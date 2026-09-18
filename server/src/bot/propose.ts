/**
 * The proposal producer — PLAN.md 12.18 / 12.10.
 *
 * The approve-before-execute pipeline existed with no producer: `/proposals/current` returned null
 * forever and the Bot tab rendered an empty thread. This is the missing half.
 *
 * Every number in a proposal is COMPUTED from live market data and the user's own limits — the
 * model is never asked for one. It writes the sentence; arithmetic is ours. PLAN.md §3.2.
 *
 * The rule that decides whether to propose at all is deliberately simple and legible: a breakout
 * of the recent range on the strategy's own symbol. A user can check it against the chart. It is
 * tier 6 on the ladder (§1.2), so it ships behind approval by default — which is exactly what a
 * proposal IS.
 */
import { randomUUID } from 'node:crypto';
import { one, query } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { priceOf } from '../market/prices.js';
import { getJson } from '../http/get.js';
import { COINGECKO_IDS } from '../market/ids.js';
import { evaluate } from '../rules/engine.js';
import { speak } from './llm.js';
import { TONE_INSTRUCTIONS, type ToneId } from './tone.js';
import { readPolicy } from '../evm/delegation.js';
import { SETTLEMENT_SYMBOL } from '../venues/tokens.js';
import type { Address } from 'viem';

/**
 * What the bot proposes on when the wallet has no strategy to take a hint from.
 *
 * XBTC: OKX's wrapped bitcoin, which settles on X Layer through the XBTC/USDG pool (~$1.1M, the deepest non-stable
 * book the executor routes). WETH is not it: no WETH pool on X Layer holds real liquidity against a stablecoin, so a
 * proposal on it could never be filled. An earlier default, `'SOL'`, had no token on the chain at all.
 */
/** Exported so a test can assert the price map can actually resolve it. */
export const DEFAULT_PROPOSAL_SYMBOL = 'XBTC';

const COINGECKO = 'https://api.coingecko.com/api/v3';
/*
 * The price-feed ids, IMPORTED. This file used to keep its own copy.
 *
 * The copy held nine symbols — BTC, ETH, SOL, XRP, DOGE, HYPE, AAVE, LINK, TON — while
 * `market/ids.ts` holds fourteen. The five it was missing were XAUT, PAXG, WETH, USDC and CBBTC:
 * every asset this app can actually settle on Base.
 *
 * `DEFAULT_PROPOSAL_SYMBOL` is `WETH`. So `range()` looked up a symbol its own map did not have,
 * returned `null`, and `propose()` reported `no_market_data` — writing "Proposed nothing — No live
 * market for WETH." into the permanent audit trail on every run, about an asset whose price the
 * same executor was serving to `/price/WETH` and `/market/ohlc` at that moment. The proposal
 * engine, which exists to show what the bot chose to do, could not propose anything for any
 * tradable symbol.
 *
 * A second copy of a mapping is a second thing to keep current, and this is what it cost. Same
 * mistake as the `delegations` table being read for enforcement, one file over.
 */
export const PRICE_IDS = COINGECKO_IDS;
const IDS = PRICE_IDS;

export type ProposalPayload = {
  symbol: string;
  status: string;
  /** The agent's read of this setup, or `null` when no model produced one. */
  opening: string | null;
  action: string;
  notional: string;
  entry: string;
  stop: string;
  target: string;
  /**
   * The numbers approving acts on, as plain decimals — `notional`, `stop` and `target` above are
   * formatted for reading, and parsing "$2,406.10" back out of a sentence is how a size goes wrong.
   */
  usd: string;
  stopPrice: string;
  targetPrice: string;
  rationale: string;
  /** What approving will do. Never what it did: that is the decision's answer. */
  onApprove: string;
  onSkip: string;
};

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * How long the 30-day range is worth keeping.
 *
 * It was ten minutes, for thirty DAILY candles — a series whose newest bar changes once a day and
 * whose high and low over a month move slower still. So the entry expired constantly, and every
 * expiry made the next visitor pay for a refetch that was **measured at 61 seconds** against
 * CoinGecko's free tier. The Bot tab is the whole content of that screen: bounded at ten seconds
 * it answered `503 warming`, the client retried three times, and the agent's answer took about
 * forty seconds to appear on the headline screen of the product.
 *
 * Six hours cannot change the verdict this number feeds. `evaluate` asks whether the LIVE price is
 * breaking out of that range or sitting mid-range, and the live price is fetched separately with
 * its own short TTL — so the fast half stays fast and the slow-moving reference stops being
 * re-bought every ten minutes.
 */
const RANGE_TTL_MS = 6 * 60 * 60_000;

/** Recent daily range for the symbol — the reference a breakout is measured against. */
async function range(symbol: string): Promise<{ high: number; low: number } | null> {
  const id = IDS[symbol];
  if (!id) return null;
  const rows = await getJson<[number, number, number, number, number][]>(
    `${COINGECKO}/coins/${id}/ohlc?vs_currency=usd&days=30`,
    RANGE_TTL_MS,
  ).catch(() => null);
  if (!rows || rows.length < 5) return null;
  return {
    high: Math.max(...rows.map((r) => r[2])),
    low: Math.min(...rows.map((r) => r[3])),
  };
}

export type ProposeResult =
  | { created: true; id: string; payload: ProposalPayload }
  | { created: false; reason: string; detail: string };

/**
 * Consider proposing a trade. Returns why it declined when it declines — and that decline is
 * written to the audit trail by the caller, because "what it chose not to do" is the product.
 */
export async function propose(walletId: string, tone: ToneId = 'dry'): Promise<ProposeResult> {
  const open = await one<{ id: string }>(
    `SELECT id FROM proposals WHERE wallet_id=$1 AND decision IS NULL AND expires_at > now() LIMIT 1`,
    [walletId],
  );
  if (open) return { created: false, reason: 'already_open', detail: 'A proposal is already waiting.' };

  /*
   * Read the CHAIN, like every other path that asks this question.
   *
   * This read the `delegations` table, which only has a row when the grant came through this
   * executor. A permission granted any other way — a script, another device, the contract
   * directly — is invisible to it, so the Agents tab told a wallet with a live $2,810/day
   * on-chain cap "No trading permission has been granted." and the bot proposed nothing, ever.
   * `/judge` asserts on that very screen that the permission is "read from the chain, never from
   * our database"; this was the one path where that was not true.
   *
   * `readPolicy` is what `/orders`, `/strategies` and `run.ts` already use.
   */
  const wallet = await one<{ address: string; agents_stopped?: boolean }>(
    `SELECT address, agents_stopped FROM wallets WHERE id = $1`,
    [walletId],
  );
  const ownerAddress = wallet?.address as Address | undefined;
  if (!ownerAddress) {
    return { created: false, reason: 'no_wallet', detail: 'This wallet has no address on file.' };
  }
  const del = await readPolicy(ownerAddress);
  if (!del) return { created: false, reason: 'no_delegation', detail: 'No trading permission has been granted.' };

  /*
   * Propose on a symbol the user actually has a strategy for.
   *
   * The fallback was `'SOL'` — Solana, in an app that settles on Base, where it has no token, no
   * route and no way to fill. A wallet with no strategies got a proposal for an instrument the
   * executor would refuse at the venue.
   *
   * `PORTFOLIO` was excluded because it names a rebalance rather than an instrument. USDC needed
   * the same exclusion for the same reason and did not have it: the yield strategy supplies cash
   * to Aave, so its `symbol` is legitimately USDC, and once a wallet had one it was the newest row
   * this query could find. Every proposal run then asked for a price and a range for the asset
   * everything is priced IN, got nothing, and wrote "Proposed nothing — No live market for USDC."
   * into the activity log. Four of those in a row are the first thing on the fork wallet's
   * Activity screen, which reads as a broken bot rather than a quiet one.
   *
   * A proposal is a TRADE, so the symbol has to be something there is a market for. The settlement
   * asset has no market against itself.
   */
  const strat = await one<{ symbol: string }>(
    `SELECT symbol FROM strategies WHERE wallet_id=$1 AND chain = ${THIS_CHAIN}
       AND symbol <> 'PORTFOLIO' AND symbol <> $2
     ORDER BY created_at DESC LIMIT 1`,
    [walletId, SETTLEMENT_SYMBOL],
  );
  const symbol = strat?.symbol ?? DEFAULT_PROPOSAL_SYMBOL;

  /*
   * "Skipped. I will not re-propose WETH today." The skip reply promises it, so something must keep it.
   *
   * Nothing did. The only check above is for a proposal still open, so the next time the Bot tab
   * mounted it asked again and could put the trade the user had just turned down straight back in
   * front of them. "Today" is the UTC day, the unit the daily cap already resets on.
   */
  const skipped = await one<{ id: string }>(
    `SELECT id FROM proposals
      WHERE wallet_id = $1 AND decision = 'skip' AND payload->>'symbol' = $2
        AND decided_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      LIMIT 1`,
    [walletId, symbol],
  );
  if (skipped) {
    return {
      created: false,
      reason: 'skipped_today',
      detail: `You skipped ${symbol} today, so I will not propose it again until tomorrow (UTC).`,
    };
  }

  const [price, band] = await Promise.all([priceOf(symbol).catch(() => 0), range(symbol)]);
  if (!price || !band) {
    return { created: false, reason: 'no_market_data', detail: `No live market for ${symbol}.` };
  }

  // Size it at a quarter of the remaining daily cap, so a proposal can never be the whole budget.
  const verdict = await evaluate({
    walletId,
    usd: 1,
    dailyCapUsd: del.dailyCapUsd,
    delegationExpiresAt: new Date(del.expiresAt),
    delegationRevoked: del.revoked,
    // Stopped agents do not ask either (PLAN.md 2.14).
    killed: wallet?.agents_stopped === true,
  });
  if (!verdict.allowed) return { created: false, reason: verdict.reason, detail: verdict.detail };

  const notional = Math.max(10, Math.round((verdict.remainingUsd + 1) * 0.25));
  const units = notional / price;

  // The setup: is price in the top decile of its 30-day range?
  const position = (price - band.low) / Math.max(band.high - band.low, 1e-9);
  if (position < 0.9) {
    return {
      created: false,
      reason: 'no_setup',
      detail: `${symbol} is mid-range, so there is nothing worth proposing.`,
    };
  }

  // Risk is derived, never invented: stop under the range, target at the same distance x2.
  const stop = Math.min(price * 0.99, band.high * 0.995);
  const risk = price - stop;
  const target = price + risk * 2;

  const said = await speak({
    persona: 'momentum-scout',
    toneInstruction: TONE_INSTRUCTIONS[tone],
    situation: `${symbol} is trading at the top of its thirty-day range. You are proposing a long with a stop under the range high. Explain the setup in one sentence, naming no figures.`,
  });

  const payload: ProposalPayload = {
    symbol,
    status: `Watching ${Object.keys(IDS).length} markets`,
    /*
     * No model, no opening line. The rest of this proposal — the size, the entry, the stop, the
     * target, the cap it fits inside — is computed from real prices and the user's real policy,
     * and it stands on its own. A written-in-advance sentence dressed as the agent's read of THIS
     * setup is the one part that would not be true.
     */
    opening: said.ok ? said.text : null,
    action: `Buy ${units.toFixed(4)} ${symbol}`,
    notional: money(notional),
    entry: money(price),
    stop: money(stop),
    target: money(target),
    usd: String(notional),
    stopPrice: String(stop),
    targetPrice: String(target),
    rationale: `Risking ${money(risk * units)} to make ${money(risk * 2 * units)}. Within your ${money(del.dailyCapUsd)} daily cap.`,
    /*
     * This said "Filled 0.0041 WETH at $2,431. Stop set at $2,406." — written before anyone had
     * approved anything, and then used as the approval's reply while nothing traded. PLAN.md 1.3.
     */
    onApprove: `Buys ${money(notional)} of ${symbol} at market through your permission; the stop and target become a real exit on the position.`,
    onSkip: `Skipped. I will not re-propose ${symbol} today.`,
  };

  const row = await one<{ id: string }>(
    `INSERT INTO proposals (id, wallet_id, agent, payload, expires_at)
     VALUES ($1,$2,'Momentum Scout',$3, now() + interval '252 seconds') RETURNING id`,
    [randomUUID(), walletId, JSON.stringify(payload)],
  );
  return { created: true, id: row!.id, payload };
}
