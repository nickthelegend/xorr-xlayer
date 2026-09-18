/**
 * The autonomous agent: pick a setup across the xStocks universe, then place it — PLAN.md §8.6.
 *
 * It reads what is actually knowable about each wrapped xStock on X Layer — a live Uniswap v3
 * price, the readings this app has recorded for it, the SEC's filing cadence, the ERC-4626
 * wrapper's own corporate-action multiplier, the Nasdaq clock — scores the strategies that the
 * conditions support, and places the best one as a one-off order (`placeOrder`, which settles
 * through the XorrDelegation contract's `spend()`) with no approval step in between.
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
import { isAddress, type Address } from 'viem';
import { one, query } from '../db/index.js';
import { log } from '../http/request-id.js';
import { evaluate, type RuleVerdict } from '../rules/engine.js';
import { XSTOCKS, xStockPriceUsd, type XStockToken } from '../venues/xstocks.js';
import { armExits, placeOrder, type OrderResult } from '../executor/order.js';
import { readPolicy, type OnChainPolicy } from '../evm/delegation.js';
import { publicClient } from '../evm/client.js';
import type { WalletRow } from '../routes/wallet-context.js';
import { speak } from './llm.js';
import { TONE_INSTRUCTIONS, type ToneId } from './tone.js';
import { earningsCalendar } from '../market/edgar.js';
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
  /** The X Layer transaction hash of the fill. */
  signature: string;
  /** The executor run that settled it (`strategy_runs.id`), where venue and measured units live. */
  runId: string;
  /** The persona's sentence, model-written where the model answered and deterministic where not. */
  opening: string;
  reason: string;
  marketCondition: string;
  /** The wrapped xStock's ERC-4626 multiplier (`convertToAssets(1e18) / 1e18`) at the moment of the trade. */
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
  receipt: AutonomousReceipt;
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
    runId: receipt.runId,
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

/**
 * What a filled autonomous entry settled as, read off the order path's own outcome.
 *
 * Only a buy: the autonomous agent opens positions, and its exits are `exit-rules` strategies that
 * close through `closePosition()` on their own schedule.
 */
export type AutonomousReceipt = {
  /** The X Layer transaction hash. */
  signature: string;
  /** The `strategy_runs` row that settled it. */
  runId: string;
  /** The one-shot order (`strategies.id`) `placeOrder` created for it. */
  orderId: string;
  /** Units delivered, measured on chain by the run. */
  filledUnits: number;
  fillPrice: number;
  symbol: string;
  usd: number;
  side: 'buy';
};

export type CorporateActionSignal = {
  /** The multiplier the wrapped xStock is scaling by right now. 1 when it could not be read. */
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
      receipt: AutonomousReceipt;
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

/** The two reads the corporate-action signal is made of. Only these functions, nothing else. */
const ERC4626_ABI = [
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
] as const;

/**
 * The raw (rebasing) xStock's published schedule. Both functions exist on the X Layer raw tokens —
 * read on chain against TSLAx on 2026-09-19 (`newMultiplier` = 1e18, `newMultiplierActivationTime`
 * = 0: nothing scheduled) — and a token without them reverts, which reads as "nothing pending".
 */
const XSTOCK_SCHEDULE_ABI = [
  {
    type: 'function',
    name: 'newMultiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'newMultiplierActivationTime',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ONE_SHARE = 10n ** 18n;

/**
 * The wrapped xStock's corporate-action multiplier: how many raw tokens one wrapper share is worth.
 *
 * The wrapper is an ERC-4626 vault over the rebasing raw token, so `convertToAssets(1e18)` equals the
 * raw token's `multiplier()` — a split or a reinvested dividend moves it, and nothing else does.
 * Throws when the read fails; the caller decides what a failed read means.
 */
export async function readWrapperMultiplier(stock: Pick<XStockToken, 'address'>): Promise<number> {
  const assets = await publicClient.readContract({
    address: stock.address as Address,
    abi: ERC4626_ABI,
    functionName: 'convertToAssets',
    args: [ONE_SHARE],
  });
  const multiplier = Number(assets) / 1e18;
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error(`${String(assets)} is not a multiplier`);
  }
  return multiplier;
}

/** A multiplier change the issuer has already written on chain and not yet activated, or null. */
async function readScheduledMultiplier(
  stock: Pick<XStockToken, 'raw'>,
  current: number,
): Promise<{ nextMultiplier: number; effectiveAtMs: number } | null> {
  const [next, activation] = await Promise.all([
    publicClient.readContract({
      address: stock.raw as Address,
      abi: XSTOCK_SCHEDULE_ABI,
      functionName: 'newMultiplier',
    }),
    publicClient.readContract({
      address: stock.raw as Address,
      abi: XSTOCK_SCHEDULE_ABI,
      functionName: 'newMultiplierActivationTime',
    }),
  ]);
  const effectiveAtMs = Number(activation) * 1000;
  const nextMultiplier = Number(next) / 1e18;
  // Zero, or a time already passed, is not a schedule: the change has either never been set or is in force.
  if (!(effectiveAtMs > Date.now())) return null;
  if (!(nextMultiplier > 0) || nextMultiplier === current) return null;
  return { nextMultiplier, effectiveAtMs };
}

/**
 * What the chain itself says about splits and dividends.
 *
 * The multiplier in force is the ERC-4626 wrapper's `convertToAssets(1e18)`; a change the issuer has
 * already scheduled is on the raw token, with the timestamp it takes effect — so the chain holds the
 * schedule and there is nothing to look up anywhere else. A read that fails reports multiplier 1 and
 * no pending action, which is also what a token that has never had a corporate action looks like.
 */
async function corporateActionSignal(stock: XStockToken): Promise<CorporateActionSignal> {
  const multiplier = await readWrapperMultiplier(stock).catch(() => null);
  if (multiplier === null) return { multiplier: 1, pending: null, hoursUntil: null };

  const pending = await readScheduledMultiplier(stock, multiplier).catch(() => null);
  if (!pending) return { multiplier, pending: null, hoursUntil: null };

  const untilMs = pending.effectiveAtMs - Date.now();
  return {
    multiplier,
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

type Refusal = { executed: false; reason: string; detail: string };

/**
 * The permission as the XorrDelegation contract holds it, or the refusal that stands in for it.
 *
 * Every failure here refuses. The Solana version read the delegation with `.catch(() => null)` and
 * then sized against a $1,000 default when the read came back empty — so an RPC failure sized a
 * trade against a cap nobody granted. A permission that cannot be read is not a permission.
 */
async function readPermission(
  address: string,
): Promise<{ ok: true; policy: OnChainPolicy } | { ok: false; refusal: Refusal }> {
  const refuse = (reason: string, detail: string) => ({
    ok: false as const,
    refusal: { executed: false as const, reason, detail },
  });
  if (!isAddress(address)) {
    return refuse('no_wallet', 'This wallet has no X Layer address on file.');
  }
  let policy: OnChainPolicy | null;
  try {
    policy = await readPolicy(address);
  } catch (e) {
    log.error('[autonomous] could not read the permission:', e instanceof Error ? e.message : e);
    return refuse(
      'delegation_unreadable',
      'The on-chain trading permission could not be read on X Layer, so nothing was placed.',
    );
  }
  if (!policy) {
    return refuse('no_delegation', 'No trading permission has been granted on X Layer.');
  }
  if (policy.revoked) {
    return refuse('delegation_revoked', 'The on-chain trading permission has been revoked.');
  }
  if (policy.expiresAt <= Date.now()) {
    return refuse('delegation_expired', 'The on-chain trading permission has expired. Renew it to let the agent trade.');
  }
  if (!(policy.remainingTodayUsd > 0)) {
    return refuse('daily_cap', "Today's on-chain cap is used up. Nothing was placed.");
  }
  return { ok: true, policy };
}

/**
 * The order path's answer, in the agent's vocabulary.
 *
 * A refusal before anything ran (`not_tradable`, `no_delegation`, `delegation_expired`) and a run
 * the executor blocked (`onchain_daily_cap`, `delegation_revoked_onchain`, `agent_out_of_gas`, a
 * rules reason, ...) pass their own reason and sentence straight through. A run that failed says so
 * as `order_failed` with the human sentence the run wrote; anything that is not a fill is not one.
 */
function receiptFrom(
  order: OrderResult,
  symbol: string,
  usd: number,
): { ok: true; receipt: AutonomousReceipt } | { ok: false; refusal: Refusal } {
  const refuse = (reason: string, detail: string) => ({
    ok: false as const,
    refusal: { executed: false as const, reason, detail },
  });
  if (!order.placed) return refuse(order.refusal.reason, order.refusal.detail);
  const outcome = order.outcome;
  switch (outcome.status) {
    case 'filled':
      return {
        ok: true,
        receipt: {
          signature: outcome.signature,
          runId: outcome.runId,
          orderId: order.orderId,
          filledUnits: outcome.units,
          fillPrice: outcome.price,
          symbol,
          usd,
          side: 'buy',
        },
      };
    case 'blocked':
      return refuse(outcome.reason, outcome.detail);
    case 'failed':
      return refuse('order_failed', outcome.error);
    case 'watch':
      return refuse('order_not_filled', 'The order ran in watch mode, so nothing was bought.');
    case 'skipped':
      return refuse('order_not_filled', `The order did not run (${outcome.reason}), so nothing was bought.`);
  }
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
     * `evaluateBestSetup` is a Uniswap v3 quote, a reference price and a wrapper read per symbol, so a caller
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

  // 2. The on-chain XorrDelegation policy, which is what actually authorises any of this.
  const permission = await readPermission(wallet.address);
  if (!permission.ok) return permission.refusal;
  const policy = permission.policy;

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
      detail: 'Nothing in the X Layer xStocks universe reads as a setup right now.',
    };
  }

  // 4. Size it, inside the daily cap the delegation set — as the chain reports it, not a default.
  /*
   * The rules engine is a gate, so an engine that cannot answer is a closed gate.
   *
   * The Solana chokepoint caught an `evaluate` error into `{ allowed: true }` — a database blip in
   * the kill-switch/daily-spend read let a trade through unchecked, on the one path that places
   * trades with nobody watching. A rules error now refuses, with the reason named.
   */
  let verdict: RuleVerdict;
  try {
    verdict = await evaluate({
      walletId,
      usd: 1,
      dailyCapUsd: policy.dailyCapUsd,
      delegationExpiresAt: new Date(policy.expiresAt),
      delegationRevoked: policy.revoked,
      killed: Boolean(wallet.agents_stopped),
    });
  } catch (e) {
    log.error('[autonomous] rules engine failed; refusing:', e instanceof Error ? e.message : e);
    return {
      executed: false,
      reason: 'rules_unavailable',
      detail:
        'The spending rules could not be checked, so nothing was placed. An unchecked trade is not one the agent makes.',
    };
  }
  if (!verdict.allowed) {
    return { executed: false, reason: verdict.reason, detail: verdict.detail };
  }

  // What is left today is the smaller of our own tally and the contract's: the contract is final.
  const remainingUsd = Math.min(verdict.remainingUsd, policy.remainingTodayUsd);
  const sizeUsd = Math.min(
    options.fixedUsd ?? settings.maxTradeUsd,
    Math.max(settings.minTradeUsd, Math.floor(remainingUsd * settings.allowanceShare)),
  );
  if (sizeUsd < settings.minTradeUsd || sizeUsd > remainingUsd) {
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

  // 6. The order. Everything above this line is analysis; this is the spend.
  const order = await placeOrder(
    // `placeOrder` reads the wallet's id and address and nothing else.
    wallet as WalletRow,
    bestSetup.symbol,
    sizeUsd,
    `${bestSetup.personaName} · $${sizeUsd.toFixed(2)} of ${bestSetup.symbol}`,
    { slippagePct: bestSetup.suggestedSlippageBps / 100 },
  ).catch((e: unknown): OrderResult => ({
    placed: false,
    refusal: {
      status: 'blocked',
      reason: 'order_failed',
      detail: `The order could not be placed: ${e instanceof Error ? e.message : String(e)}`,
    },
  }));
  const filled = receiptFrom(order, bestSetup.symbol, sizeUsd);
  if (!filled.ok) return filled.refusal;
  const receipt = filled.receipt;

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
   * 8. The fill is already in the book.
   *
   * The order path (`executor/run.ts`) books the measured units with `applyFill`, attributed to the
   * one-shot order whose label names this persona, and counts it against the day's spend — in the
   * same transaction as the run row. Booking it again here would double the position. What this
   * adds is the decision: the proposal row the cooldown keys on, and the audit row `/agent/explain`
   * reads back.
   */
  const proposalId = randomUUID();
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
   * No second audit row and no second push. The order path already wrote the fill's row and sent its notification (in
   * the transaction that booked the fill); a row here would list one trade twice on Activity and buzz the phone twice.
   * The WHY lives on the proposal above, keyed by the transaction hash, which is where `/activity/:seq/explain` finds it.
   */

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
