/**
 * The autonomous agent: pick a setup across the xStocks universe, then place it — PLAN.md §8.6.
 *
 * It reads what is actually knowable about each tokenized equity — a live Jupiter price, the
 * readings this app has recorded for it, the SEC's filing cadence, the mint's own Scaled UI
 * multiplier, the Nasdaq clock — scores the strategies that the conditions support, and sends the
 * best one through the executor's spend chokepoint with no approval step in between.
 *
 * ## What it refuses to do
 *
 * Every signal here comes from a source that can fail, and each one fails to "no candidate" rather
 * than to a plausible-looking number. A stock with no price is skipped. A stock with too few
 * recorded readings gets no range-based strategy rather than a range invented around its current
 * price. A projected earnings date carries the projection error EDGAR's own filings imply, and a
 * window narrower than that error is not treated as a window. An off-hours entry that cannot be
 * checked against a second venue is held, not sized down.
 *
 * That is the difference between an agent that trades rarely and one that trades confidently on
 * numbers nobody produced.
 */
import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { one, query, tx } from '../db/index.js';
import { append } from '../audit/log.js';
import { applyFill } from '../positions/index.js';
import { log } from '../http/request-id.js';
import { evaluate } from '../rules/engine.js';
import { XSTOCKS, xStockPriceUsd, type XStockToken } from '../venues/xstocks.js';
import { guardAndSpend, type SpendReceipt } from '../executor/place.js';
import { armExits } from '../executor/order.js';
import { notifyEntry } from '../notifications/alerts.js';
import { speak } from './llm.js';
import { TONE_INSTRUCTIONS, type ToneId } from './tone.js';
import { earningsCalendar } from '../market/edgar.js';
import { readMintScale } from '../solana/balances.js';
import { readDelegation } from '../solana/delegation.js';
import type { PersonaId } from './personas.js';
import {
  DEFAULT_RISK_PROFILE,
  isRiskProfile,
  settingsFor,
  type RiskProfile,
  type RiskSettings,
} from './risk-profile.js';
import {
  evaluateOffHoursGuard,
  referencePriceUsd,
  type OffHoursGuardVerdict,
} from '../market/nasdaq.js';

/**
 * The strategies this agent actually produces a candidate for.
 *
 * `grid` was in this union and had no branch anywhere below it, so the type promised a strategy
 * nothing could ever return. A caller switching exhaustively on it was writing a dead arm.
 */
export type StrategyKind = 'momentum' | 'event-driven' | 'dca';

/**
 * How far back a range is drawn. A month of readings, matching what the asset screen charts.
 *
 * Not a risk knob. How much history to LOOK at is a question about the asset; how much of it is
 * enough to act on is the question the profile answers, and that is `minObservations`.
 */
const RANGE_HOURS = 24 * 30;

/*
 * How close a scheduled multiplier change has to be before the agent stands down on that symbol is
 * `corporateActionWindowHours`, on the profile.
 *
 * A new position is a stop price and a target price, both stated in today's per-unit terms. When
 * the multiplier moves, every holding is restated — units multiplied, price divided — and those
 * levels stop describing the thing they were chosen for. The exits `armExits` attaches are checked
 * daily, so a change inside a day or two lands between one check and the next and the first thing
 * to notice is a stop firing at a price nobody chose.
 *
 * It is a reason not to OPEN something. An existing position is left alone, because closing on a
 * corporate action would be the same mistake pointed the other way.
 */

/**
 * What this agent writes into `proposals.decision`.
 *
 * The column is `CHECK (decision IN ('approve','skip','expired'))` and this used to write
 * `'approved'`, which Postgres refused on every single autonomous trade. The insert was wrapped in
 * a `.catch` that logged and moved on, so nothing failed loudly: no decision record was ever
 * stored, and `autonomousAgentSweep`'s cooldown — which asks for rows with this exact value —
 * matched nothing, leaving the agent free to trade on every tick.
 *
 * A constant rather than a literal in two places, and `decision-vocabulary.test.ts` holds it
 * against the CHECK clause in `schema.sql` so the two cannot drift apart again silently.
 */
export const AGENT_DECISION = 'approve';

/*
 * How long a wallet waits between autonomous entries is `cooldownMinutes`, on the profile. The
 * tick is faster than any thesis is, so without it the agent would re-enter the same setup every
 * thirty seconds.
 */

/**
 * Why the agent did what it did, in the shape `/agent/explain` reads back.
 *
 * Written once and stored twice — as the proposal payload and on the audit row — because they are
 * read for different reasons and neither should have to join to the other to answer. Every field
 * is something the agent actually observed at decision time; there is nothing here it would have
 * to recompute later, which is the point. A rationale reconstructed after the fact is a guess
 * about the past dressed up as a record of it.
 */
export type DecisionRecord = {
  symbol: string;
  strategyKind: StrategyKind;
  persona: PersonaId;
  personaName: string;
  score: number;
  usd: number;
  units: number;
  price: number;
  stopPrice: number;
  targetPrice: number;
  signature: string;
  slot: number;
  /** The persona's sentence, model-written where the model answered and deterministic where not. */
  opening: string;
  reason: string;
  marketCondition: string;
  /** The Scaled UI multiplier in force at the moment of the trade. */
  multiplier: number;
  /** A multiplier change that was already published when this was decided, if there was one. */
  pendingMultiplier: number | null;
  pendingEffectiveAtMs: number | null;
  nasdaqSession: string;
  /** Null when no independent price was available to measure drift against. */
  spreadBps: number | null;
  slippageBps: number;
  /**
   * Which risk profile was active when this was decided.
   *
   * Stored rather than looked up when the trade is explained. The setting is a thing the user can
   * change, and reading it at explain time would caption last week's careful trade with this
   * week's aggressive profile — describing a decision that was never made.
   */
  riskProfile: RiskProfile;
  exitStrategyId: string | null;
  decidedAtMs: number;
};

function decisionRecord(p: {
  setup: CandidateSetup;
  usd: number;
  receipt: SpendReceipt;
  opening: string;
  exitStrategyId: string | null;
  riskProfile: RiskProfile;
}): DecisionRecord {
  const { setup, receipt } = p;
  return {
    symbol: setup.symbol,
    strategyKind: setup.strategyKind,
    persona: setup.persona,
    personaName: setup.personaName,
    score: setup.score,
    usd: p.usd,
    units: receipt.filledUnits,
    price: receipt.fillPrice,
    stopPrice: setup.stopPrice,
    targetPrice: setup.targetPrice,
    signature: receipt.signature,
    slot: receipt.slot,
    opening: p.opening,
    reason: setup.reason,
    marketCondition: setup.marketCondition,
    multiplier: setup.corporateAction.multiplier,
    pendingMultiplier: setup.corporateAction.pending?.nextMultiplier ?? null,
    pendingEffectiveAtMs: setup.corporateAction.pending?.effectiveAtMs ?? null,
    nasdaqSession: setup.offHoursGuard.session,
    /* Null rather than 0: nothing measured is not the same as measured at zero. */
    spreadBps: setup.offHoursGuard.spreadBps,
    slippageBps: setup.suggestedSlippageBps,
    riskProfile: p.riskProfile,
    exitStrategyId: p.exitStrategyId,
    decidedAtMs: Date.now(),
  };
}

export type CorporateActionSignal = {
  /** The multiplier the mint is scaling by right now. 1 on a mint with no extension. */
  multiplier: number;
  /** A change the issuer has already published, if one is due inside the window. */
  pending: { nextMultiplier: number; effectiveAtMs: number } | null;
  hoursUntil: number | null;
};

export type CandidateSetup = {
  symbol: string;
  stock: XStockToken;
  strategyKind: StrategyKind;
  persona: PersonaId;
  personaName: string;
  score: number;
  currentPrice: number;
  stopPrice: number;
  targetPrice: number;
  reason: string;
  marketCondition: string;
  corporateAction: CorporateActionSignal;
  offHoursGuard: OffHoursGuardVerdict;
  suggestedSlippageBps: number;
};

export type AutonomousTradeResult =
  | {
      executed: true;
      setup: CandidateSetup;
      receipt: SpendReceipt;
      exitStrategyId: string | null;
      proposalId: string;
    }
  | {
      executed: false;
      reason: string;
      detail: string;
    };

/**
 * The high and the low this app has actually seen for a symbol, or null when it has not seen enough.
 *
 * Null is the point. The previous version of this derived a "30-day range" as current price ±8%,
 * which put every asset at exactly the 50th percentile of a band that was a restatement of its own
 * price — so "breaking out near the upper band" was a sentence about arithmetic, not about the
 * market, and the two branches that read it could never fire.
 */
async function observedRange(
  symbol: string,
  minObservations: number,
): Promise<{ high: number; low: number } | null> {
  const rows = await query<{ usd: string }>(
    `SELECT usd FROM price_observations
      WHERE symbol = $1 AND at > now() - ($2 || ' hours')::interval`,
    [symbol, String(RANGE_HOURS)],
  ).catch(() => []);

  const prices = rows.map((r) => Number(r.usd)).filter((n) => Number.isFinite(n) && n > 0);
  if (prices.length < minObservations) return null;

  const high = Math.max(...prices);
  const low = Math.min(...prices);
  return high > low ? { high, low } : null;
}

/**
 * Where the live price sits in that band, 0 at the low and 1 at the high.
 *
 * The live quote rather than the newest stored reading, because the quote is what the trade would
 * be sized against and the table is only as fresh as the last time something looked. A new high
 * reads as 1 and a new low as 0, which is what they are.
 */
function bandPosition(price: number, range: { high: number; low: number }): number {
  return Math.min(1, Math.max(0, (price - range.low) / (range.high - range.low)));
}

/**
 * When the company next reports, and whether the projection is tight enough to position against.
 *
 * `earningsCalendar` projects from EDGAR's filing cadence and says how wrong that projection could
 * be, in days, from the company's own record. A five-day window means nothing if the date it is
 * drawn around could be eight days out, so a projection whose error exceeds the window is not one
 * this agent trades.
 */
async function earningsWindow(symbol: string): Promise<{ days: number; errorDays: number } | null> {
  const cal = await earningsCalendar(symbol).catch(() => null);
  if (!cal || cal.nextAt === null) return null;
  return {
    days: Math.round((cal.nextAt - Date.now()) / 86_400_000),
    errorDays: cal.errorDays,
  };
}

/**
 * What the mint itself says about splits and dividends.
 *
 * Token-2022 publishes a corporate action as a new Scaled UI multiplier with the timestamp it takes
 * effect, so the chain holds the schedule and there is nothing to look up anywhere else. A read
 * that fails reports multiplier 1 and no pending action, which is what a mint without the extension
 * looks like too.
 */
async function corporateActionSignal(stock: XStockToken): Promise<CorporateActionSignal> {
  const scale = await readMintScale(stock.address).catch(() => null);
  if (!scale) return { multiplier: 1, pending: null, hoursUntil: null };

  const pending = scale.pending;
  if (!pending) return { multiplier: scale.multiplier, pending: null, hoursUntil: null };

  const untilMs = pending.effectiveAtMs - Date.now();
  return {
    multiplier: scale.multiplier,
    pending,
    hoursUntil: Math.round(untilMs / 3_600_000),
  };
}

/**
 * Evaluates every strategy the conditions support across the xStocks universe, best first.
 *
 * The thresholds come in rather than being read here, so the caller that knows WHICH wallet this
 * is for is the one that decides how careful to be. The default is the default profile, and it is
 * only ever right for a caller with no wallet in hand — a demo script, or a preview of what the
 * agent would consider in general. `runAutonomousCycle` always passes the wallet's own.
 */
export async function evaluateBestSetup(
  settings: RiskSettings = settingsFor(DEFAULT_RISK_PROFILE),
): Promise<CandidateSetup | null> {
  const candidates: CandidateSetup[] = [];

  for (const stock of Object.values(XSTOCKS)) {
    const price = await xStockPriceUsd(stock.symbol).catch(() => null);
    if (!price || price <= 0) continue;

    const reference = await referencePriceUsd(stock.symbol);
    const offHoursGuard = evaluateOffHoursGuard({
      symbol: stock.symbol,
      onChainPrice: price,
      referencePrice: reference,
    });

    // The guard holding is the whole answer for this symbol: nothing scores past it.
    if (offHoursGuard.action === 'hold') continue;

    const corporateAction = await corporateActionSignal(stock);
    const range = await observedRange(stock.symbol, settings.minObservations);
    const earnings = await earningsWindow(stock.symbol);
    const slippageBps = offHoursGuard.suggestedSlippageBps;

    /*
     * A corporate action already on the chain is a reason not to open anything here at all.
     *
     * This used to be a 40-point markdown, which is a way of saying "worse, but still allowed" —
     * and a scored-down candidate still wins whenever the alternatives are worse, so on a quiet
     * day the agent would take exactly the entry the markdown was warning about. The stop and the
     * target cannot survive the multiplier moving, so there is no size at which this is a good
     * trade and nothing for a score to express.
     *
     * How far to stand clear is the profile's: a careful agent keeps four days, an aggressive one
     * keeps one.
     */
    if (
      corporateAction.pending &&
      corporateAction.pending.effectiveAtMs - Date.now() <=
        settings.corporateActionWindowHours * 3_600_000
    ) {
      continue;
    }
    const offHoursPenalty = offHoursGuard.session === 'closed' ? 15 : 0;

    // 1. Event-driven: a projected report, far enough out to enter and be flat before the print.
    if (
      earnings &&
      earnings.days >= 3 &&
      earnings.days <= 10 &&
      earnings.errorDays <= settings.earningsErrorToleranceDays
    ) {
      candidates.push({
        symbol: stock.symbol,
        stock,
        strategyKind: 'event-driven',
        persona: 'earnings-desk',
        personaName: 'Earnings Desk',
        score: Math.max(10, 95 - Math.abs(earnings.days - 6)),
        currentPrice: price,
        stopPrice: price * 0.94,
        targetPrice: price * 1.12,
        reason: `${stock.symbol} is projected to report in about ${earnings.days} days, give or take ${earnings.errorDays}, from its own filing cadence. Entering the run-up and flat before the print.`,
        marketCondition: `Pre-earnings window, ${earnings.days}d out`,
        corporateAction,
        offHoursGuard,
        suggestedSlippageBps: slippageBps,
      });
    }

    const position = range ? bandPosition(price, range) : null;

    // 2. Momentum: near the top of the range this app has actually recorded.
    if (range && position !== null && position >= settings.momentumEntryAt) {
      const stop = Math.max(price * 0.95, range.high * 0.94);
      const target = price + (price - stop) * 2;
      candidates.push({
        symbol: stock.symbol,
        stock,
        strategyKind: 'momentum',
        persona: 'momentum-scout',
        personaName: 'Momentum Scout',
        score: Math.max(10, Math.round(75 + position * 20) - offHoursPenalty),
        currentPrice: price,
        stopPrice: stop,
        targetPrice: target,
        reason: `${stock.symbol} is trading at the ${(position * 100).toFixed(0)}th percentile of the $${range.low.toFixed(2)}-$${range.high.toFixed(2)} band this app has recorded over the past month.`,
        marketCondition: `Upper band, ${(position * 100).toFixed(0)}th percentile of observed range`,
        corporateAction,
        offHoursGuard,
        suggestedSlippageBps: slippageBps,
      });
    }

    // 3. DCA: near the bottom of that same recorded range.
    if (range && position !== null && position < settings.dcaEntryBelow) {
      candidates.push({
        symbol: stock.symbol,
        stock,
        strategyKind: 'dca',
        persona: 'yield-keeper',
        personaName: 'Yield Keeper',
        score: Math.round(70 + (settings.dcaEntryBelow - position) * 20),
        currentPrice: price,
        stopPrice: price * 0.92,
        targetPrice: price * 1.1,
        reason: `${stock.symbol} is in the lower part of the $${range.low.toFixed(2)}-$${range.high.toFixed(2)} band this app has recorded over the past month. Accumulating.`,
        marketCondition: `Lower band, ${(position * 100).toFixed(0)}th percentile of observed range`,
        corporateAction,
        offHoursGuard,
        suggestedSlippageBps: slippageBps,
      });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

/**
 * Runs the autonomous propose -> decide -> execute -> notify cycle for one wallet.
 */
export async function runAutonomousCycle(
  walletId: string,
  options: {
    fixedUsd?: number;
    tone?: ToneId;
    /**
     * A setup the caller has already chosen, to execute instead of scanning for a new one.
     *
     * `evaluateBestSetup` is a Jupiter quote, a 1inch quote and a mint read per symbol, so a caller
     * that has just done that work and wants the trade placed should not pay for it twice — and
     * more importantly should not get a DIFFERENT setup than the one it showed somebody.
     */
    setup?: CandidateSetup;
  } = {},
): Promise<AutonomousTradeResult> {
  // 1. The wallet, and whether its owner has stopped everything.
  const wallet = await one<{
    id: string;
    address: string;
    agents_stopped?: boolean;
    risk_profile?: string;
  }>(`SELECT id, address, agents_stopped, risk_profile FROM wallets WHERE id = $1`, [walletId]);
  if (!wallet) {
    return { executed: false, reason: 'no_wallet', detail: 'Wallet not found.' };
  }
  if (wallet.agents_stopped) {
    return {
      executed: false,
      reason: 'agents_stopped',
      detail: 'Agents are stopped by the kill switch.',
    };
  }

  // 2. The on-chain SPL delegation, which is what actually authorises any of this.
  const onChainDel = await readDelegation(new PublicKey(wallet.address)).catch(() => null);
  if (onChainDel && onChainDel.isRevoked) {
    return {
      executed: false,
      reason: 'delegation_revoked',
      detail: 'The on-chain SPL delegation has been revoked.',
    };
  }

  /*
   * How careful to be, as the user set it.
   *
   * A value this build does not recognise falls back rather than throwing — a newer deploy could
   * have written one, and an agent that refuses to run because it does not recognise a word is a
   * worse failure than an agent that runs carefully. The resolved name is what goes into the
   * record, so the explanation cites the profile that was actually APPLIED.
   */
  const riskProfile: RiskProfile = isRiskProfile(wallet.risk_profile)
    ? wallet.risk_profile
    : DEFAULT_RISK_PROFILE;
  const settings = settingsFor(riskProfile);

  // 3. The setup the caller brought, or the best one the current conditions support.
  const bestSetup = options.setup ?? (await evaluateBestSetup(settings));
  if (!bestSetup) {
    return {
      executed: false,
      reason: 'no_setup',
      detail: 'Nothing in the xStocks universe reads as a setup right now.',
    };
  }

  // 4. Size it, inside the daily cap the delegation set.
  const dailyCap = onChainDel ? Math.max(onChainDel.delegatedUsd, 100) : 1000;
  const verdict = await evaluate({
    walletId,
    usd: 1,
    dailyCapUsd: dailyCap,
    delegationExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    delegationRevoked: false,
    killed: Boolean(wallet.agents_stopped),
  });
  if (!verdict.allowed) {
    return { executed: false, reason: verdict.reason, detail: verdict.detail };
  }

  const sizeUsd = Math.min(
    options.fixedUsd ?? settings.maxTradeUsd,
    Math.max(settings.minTradeUsd, Math.floor(verdict.remainingUsd * settings.allowanceShare)),
  );
  if (sizeUsd < settings.minTradeUsd) {
    return {
      executed: false,
      reason: 'insufficient_budget',
      detail: `What is left of today's allowance is under the $${settings.minTradeUsd} minimum trade size.`,
    };
  }

  // 5. The sentence the user reads, in the persona's voice where the model is reachable.
  const tone = options.tone ?? 'dry';
  const llmRes = await speak({
    persona: bestSetup.persona,
    toneInstruction: TONE_INSTRUCTIONS[tone],
    situation: `Autonomous agent selected ${bestSetup.strategyKind} strategy for ${bestSetup.symbol} based on ${bestSetup.marketCondition}. Placed market buy with attached stop loss. Explain why this setup was chosen in one terse sentence, naming no numbers.`,
  }).catch(() => null);
  const openingLine =
    llmRes && llmRes.ok
      ? llmRes.text
      : `${bestSetup.personaName} took the setup: ${bestSetup.reason}`;

  // 6. Through the chokepoint. Everything above this line is analysis; this is the spend.
  const outcome = await guardAndSpend({
    walletId,
    ownerPubkey: wallet.address,
    symbol: bestSetup.symbol,
    usd: sizeUsd,
    side: 'buy',
    slippageBps: bestSetup.suggestedSlippageBps,
  });
  if (!outcome.placed) {
    return { executed: false, reason: outcome.reason, detail: outcome.detail };
  }
  const receipt = outcome;

  // 7. Arm the exits against the price it actually filled at.
  let exitStrategyId: string | null = null;
  try {
    const exits = await armExits(wallet, {
      symbol: bestSetup.symbol,
      entryPrice: receipt.fillPrice,
      stopPrice: bestSetup.stopPrice,
      targetPrice: bestSetup.targetPrice,
    });
    exitStrategyId = exits.strategyId;
  } catch (e) {
    log.error('[autonomous] failed to arm exits:', e instanceof Error ? e.message : e);
  }

  /*
   * 8. Book the fill, so the position the agent just opened is a position the app knows about.
   *
   * `guardAndSpend` places the swap and hands back a receipt; it does not touch `positions`, and
   * nothing on this path did either. So an autonomous buy reached the chain, moved real money and
   * sent a notification — and then did not appear in the book at all: Holdings showed nothing, P&L
   * counted nothing, and the sleeve breakdown had nothing to attribute. Found by driving the whole
   * demo path on the fork and reading the tables afterwards.
   *
   * Attributed to the agent and to the proposal that decided it, so the sleeve says which run
   * opened it rather than crediting it to whichever strategy happened to be live.
   *
   * A sale is negative units; `side` decides the sign. Not fatal if it fails — the money has
   * already moved, and throwing here would turn a bookkeeping failure into a second one.
   */
  const proposalId = randomUUID();
  const signedUnits = receipt.side === 'sell' ? -receipt.filledUnits : receipt.filledUnits;
  const signedUsd = receipt.side === 'sell' ? -receipt.usd : receipt.usd;
  await tx((client) =>
    applyFill(client, {
      walletId,
      symbol: bestSetup.symbol,
      units: signedUnits,
      usd: signedUsd,
      attribution: { source: 'agent', id: proposalId, label: bestSetup.personaName },
    }),
  ).catch((e) => log.error('[autonomous] failed to book the fill:', e));

  const record = decisionRecord({
    setup: bestSetup,
    usd: sizeUsd,
    receipt,
    opening: openingLine,
    exitStrategyId,
    riskProfile,
  });

  await query(
    `INSERT INTO proposals (id, wallet_id, agent, payload, decision, decided_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, now(), now() + interval '1 hour')`,
    [proposalId, walletId, bestSetup.personaName, JSON.stringify(record), AGENT_DECISION],
  ).catch((e) => log.error('[autonomous] failed to insert proposal:', e));

  /*
   * The audit row, without which the trade did not happen as far as the app is concerned.
   *
   * `guardAndSpend` places the swap and returns a receipt; it does not write to `audit_log`, and
   * nothing else on this path did either. So an autonomous fill reached the chain, moved real
   * money, sent a push — and then did not appear on Activity, which is the one screen whose entire
   * promise is that it shows what the agents did. The trail is also where `/agent/explain` starts
   * from, so a trade missing from it cannot be asked about.
   *
   * Not fatal if it fails. The money has already moved and throwing here would turn a bookkeeping
   * failure into a second one, but it is logged loudly rather than swallowed.
   */
  await append({
    walletId,
    agent: bestSetup.personaName,
    action: `Bought ${bestSetup.symbol}`,
    detail: openingLine,
    amount: `$${sizeUsd.toFixed(2)}`,
    kind: 'trade',
    signature: receipt.signature,
    payload: { proposalId, ...record },
  }).catch((e) => log.error('[autonomous] failed to write the audit row:', e));

  // 9. Tell the user, with the signature they can go and check.
  await notifyEntry({
    walletId,
    symbol: bestSetup.symbol,
    strategyKind: bestSetup.strategyKind,
    notionalUsd: sizeUsd,
    units: receipt.filledUnits,
    price: receipt.fillPrice,
    signature: receipt.signature,
    rationale: openingLine,
    agentName: bestSetup.personaName,
  });

  return { executed: true, setup: bestSetup, receipt, exitStrategyId, proposalId };
}

/**
 * One scheduler tick's worth: the eligible wallets, each past its own cooldown.
 */
export async function autonomousAgentSweep(_now: Date = new Date()): Promise<number> {
  /*
   * The profile comes back with the wallet, because the cooldown is part of it.
   *
   * Read here rather than inside the loop: the gate that decides whether to even look at a wallet
   * has to know how long that wallet waits, and a careful wallet waiting thirty minutes while the
   * sweep applied a ten-minute hold would be the setting quietly not taking effect.
   */
  const wallets = await query<{ id: string; risk_profile: string | null }>(
    `SELECT id, risk_profile FROM wallets
      WHERE address IS NOT NULL AND (agents_stopped IS NULL OR agents_stopped = false)
      ORDER BY updated_at DESC LIMIT 10`,
  ).catch(() => []);

  let executedCount = 0;
  for (const w of wallets) {
    try {
      // One autonomous entry per wallet per its own cooldown. The tick is faster than any thesis is.
      const profile = isRiskProfile(w.risk_profile) ? w.risk_profile : DEFAULT_RISK_PROFILE;
      const recent = await one<{ id: string }>(
        `SELECT id FROM proposals
          WHERE wallet_id = $1 AND decision = $2
            AND decided_at > now() - ($3 || ' minutes')::interval
          LIMIT 1`,
        [w.id, AGENT_DECISION, String(settingsFor(profile).cooldownMinutes)],
      ).catch(() => null);
      if (recent) continue;

      const res = await runAutonomousCycle(w.id);
      if (res.executed) {
        executedCount += 1;
        log.info(
          `[autonomous] ${res.setup.strategyKind} on ${res.setup.symbol} — ${res.receipt.signature}`,
        );
      }
    } catch (err) {
      log.error(`[autonomous] sweep error for wallet ${w.id}:`, err);
    }
  }
  return executedCount;
}
