/**
 * Holding a basket of tokenized equities at its target weights — PLAN.md §8.6.
 *
 * A basket is a set of target percentages: 40% NVDAx, 30% TSLAx, 30% AAPLx. Prices move, so the
 * real weights drift away from those, and rebalancing is selling what has run and buying what has
 * lagged until the two agree again.
 *
 * ## Why it only acts past a band
 *
 * Drift is continuous — a basket is never exactly on target, and a rebalancer that corrects every
 * difference it can see trades constantly, paying a spread each time to chase a number that moves
 * again before the transaction confirms. The band is what makes this a strategy rather than a
 * treadmill: below it the honest action is nothing, and a run that does nothing is recorded as
 * having done nothing rather than quietly skipped.
 *
 * ## Why one leg per run
 *
 * The largest drift, and only that one. Trading every out-of-band sleeve in a single pass means
 * several swaps against a portfolio total that each of them changes, so the later legs are sized
 * against a figure that stopped being true partway through. One leg, then re-measure on the next
 * run — which is also what makes the period key a meaningful unit of work.
 *
 * ## What it refuses to do
 *
 * A sleeve whose price cannot be read is not worth zero. Treating an unpriceable holding as
 * nothing would compute a portfolio total that is missing it, conclude that everything else is
 * over-weight, and sell down a perfectly good basket to correct a gap that does not exist. If any
 * targeted symbol cannot be priced, the whole run stands down and says which one.
 */
import { randomUUID } from 'node:crypto';
import { one, query } from '../db/index.js';
import { log } from '../http/request-id.js';
import { append } from '../audit/log.js';
import { guardAndSpend } from '../executor/place.js';
import { periodKey, type Cadence } from '../executor/schedule.js';
import { getTokenBalance } from '../solana/balances.js';
import { XSTOCKS, xStockKey, xStockPriceUsd } from '../venues/xstocks.js';

/** Below this, a leg is not worth the spread it would pay. Matches the executor's own floor. */
const MIN_TRADE_USD = 10;

export type BasketRow = {
  wallet_id: string;
  targets: Record<string, number>;
  band_pct: string | number;
  cadence: Cadence;
  enabled: boolean;
};

export type Sleeve = {
  symbol: string;
  targetPct: number;
  /** What the wallet actually holds, in units, read from the chain with the mint's multiplier. */
  units: number;
  /** Null when nothing could price it — which stands the whole run down rather than reading as 0. */
  usd: number | null;
  actualPct: number | null;
  driftPct: number | null;
};

export type BasketPlan =
  | { action: 'trade'; sleeves: Sleeve[]; totalUsd: number; leg: { symbol: string; side: 'buy' | 'sell'; usd: number; driftPct: number } }
  | { action: 'in_band'; sleeves: Sleeve[]; totalUsd: number; worstDriftPct: number }
  | { action: 'stand_down'; sleeves: Sleeve[]; totalUsd: number; reason: string };

/** Targets must name real xStocks and sum to 100. Anything else is a basket nobody can hold. */
export function validateTargets(targets: Record<string, number>): string | null {
  const entries = Object.entries(targets);
  if (entries.length === 0) return 'A basket needs at least one holding.';
  for (const [symbol, pct] of entries) {
    if (!xStockKey(symbol)) return `${symbol} is not a tokenized equity this app can hold.`;
    if (!Number.isFinite(pct) || pct <= 0) return `${symbol} needs a weight above zero.`;
  }
  const total = entries.reduce((a, [, pct]) => a + pct, 0);
  /*
   * Summed to 100, not normalised to it.
   *
   * Normalising would turn `{ NVDAx: 60 }` into 100% NVDAx — reading "hold 60% NVDA" as "put
   * everything in NVDA", which is a different instruction and a much larger position. A list that
   * does not sum is a mistake to report, not one to silently reinterpret.
   */
  if (Math.abs(total - 100) > 0.01) return `Weights add up to ${total}%, and a basket must be 100%.`;
  return null;
}

/**
 * What the wallet actually holds against what it should, priced now.
 *
 * Holdings come from the chain rather than the ledger, and through `getTokenBalance`, which applies
 * the mint's Scaled UI multiplier — a basket measured on raw balances would misread every sleeve
 * whose issuer has ever split.
 */
export async function readBasket(
  ownerAddress: string,
  targets: Record<string, number>,
): Promise<{ sleeves: Sleeve[]; totalUsd: number; unpriced: string[] }> {
  const sleeves: Sleeve[] = [];
  const unpriced: string[] = [];

  for (const [rawSymbol, targetPct] of Object.entries(targets)) {
    const key = xStockKey(rawSymbol);
    const token = key ? XSTOCKS[key] : undefined;
    if (!token) {
      unpriced.push(rawSymbol);
      sleeves.push({ symbol: rawSymbol, targetPct, units: 0, usd: null, actualPct: null, driftPct: null });
      continue;
    }

    const [balance, price] = await Promise.all([
      getTokenBalance(ownerAddress, token.address).catch(() => null),
      xStockPriceUsd(token.symbol).catch(() => null),
    ]);

    // A balance that could not be read is not a balance of zero, and neither is an unreadable price.
    if (balance === null || price === null || !(price > 0)) {
      unpriced.push(token.symbol);
      sleeves.push({ symbol: token.symbol, targetPct, units: 0, usd: null, actualPct: null, driftPct: null });
      continue;
    }

    sleeves.push({
      symbol: token.symbol,
      targetPct,
      units: balance.uiAmount,
      usd: balance.uiAmount * price,
      actualPct: null,
      driftPct: null,
    });
  }

  const totalUsd = sleeves.reduce((a, s) => a + (s.usd ?? 0), 0);
  // Percentages only once the total is known, and only when the total is real.
  if (unpriced.length === 0 && totalUsd > 0) {
    for (const s of sleeves) {
      s.actualPct = ((s.usd ?? 0) / totalUsd) * 100;
      s.driftPct = s.actualPct - s.targetPct;
    }
  }
  return { sleeves, totalUsd, unpriced };
}

/**
 * The one leg worth trading, or the reason there is none.
 *
 * Drift is measured in percentage POINTS of the basket — a sleeve targeted at 40% sitting at 46% has
 * drifted 6, whatever the basket is worth. That is the number the band is expressed in, so the
 * setting means the same thing on a $200 basket and a $20,000 one.
 */
export function planBasket(
  sleeves: Sleeve[],
  totalUsd: number,
  bandPct: number,
  unpriced: string[],
): BasketPlan {
  if (unpriced.length > 0) {
    return {
      action: 'stand_down',
      sleeves,
      totalUsd,
      reason: `${unpriced.join(', ')} could not be priced, so the basket's true weights are unknown.`,
    };
  }
  if (!(totalUsd > 0)) {
    return { action: 'stand_down', sleeves, totalUsd, reason: 'The basket holds nothing yet.' };
  }

  let worst: Sleeve | null = null;
  for (const s of sleeves) {
    if (s.driftPct === null) continue;
    if (!worst || Math.abs(s.driftPct) > Math.abs(worst.driftPct ?? 0)) worst = s;
  }
  if (!worst || worst.driftPct === null) {
    return { action: 'stand_down', sleeves, totalUsd, reason: 'Nothing in the basket could be measured.' };
  }

  if (Math.abs(worst.driftPct) < bandPct) {
    return { action: 'in_band', sleeves, totalUsd, worstDriftPct: worst.driftPct };
  }

  // Correct all the way back to target, not to the edge of the band: half-corrections re-drift out
  // on the next tick and pay a second spread to finish the job the first one started.
  const usd = Math.abs((worst.driftPct / 100) * totalUsd);
  if (usd < MIN_TRADE_USD) {
    return {
      action: 'stand_down',
      sleeves,
      totalUsd,
      reason: `${worst.symbol} is ${worst.driftPct.toFixed(1)} points out, which on this basket is under the $${MIN_TRADE_USD} minimum trade.`,
    };
  }

  return {
    action: 'trade',
    sleeves,
    totalUsd,
    // Above target means too much of it: sell. Below target: buy.
    leg: { symbol: worst.symbol, side: worst.driftPct > 0 ? 'sell' : 'buy', usd, driftPct: worst.driftPct },
  };
}

export type BasketOutcome =
  | { status: 'filled'; symbol: string; side: 'buy' | 'sell'; usd: number; signature: string; driftPct: number }
  | { status: 'skipped'; detail: string }
  | { status: 'failed'; detail: string };

/**
 * One wallet's rebalance for one period, claimed before anything is read.
 *
 * The claim is an INSERT on a UNIQUE `period_key`, exactly as `strategy_runs` does it: a retry, a
 * restart, or two schedulers racing all converge on one run per period because the database refuses
 * the second. Claimed FIRST, before the prices are read, because a claim taken after the work would
 * leave a window in which both callers have decided to trade.
 */
export async function rebalanceOnce(
  wallet: { id: string; address: string },
  basket: BasketRow,
  at: Date = new Date(),
): Promise<BasketOutcome | null> {
  const key = periodKey(`basket:${wallet.id}`, basket.cadence, at);
  const runId = randomUUID();

  const claimed = await query<{ id: string }>(
    `INSERT INTO basket_runs (id, wallet_id, period_key, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (period_key) DO NOTHING
     RETURNING id`,
    [runId, wallet.id, key],
  ).catch(() => []);
  // Already run this period. Not an error, and not something to report as one.
  if (claimed.length === 0) return null;

  const finish = (
    status: 'filled' | 'failed' | 'skipped',
    detail: string,
    extra: { symbol?: string; side?: string; usd?: number; driftPct?: number; signature?: string } = {},
  ) =>
    query(
      `UPDATE basket_runs
          SET status = $2, detail = $3, symbol = $4, side = $5, usd = $6, drift_pct = $7,
              signature = $8, finished_at = now()
        WHERE id = $1`,
      [
        runId,
        status,
        detail,
        extra.symbol ?? null,
        extra.side ?? null,
        extra.usd ?? null,
        extra.driftPct ?? null,
        extra.signature ?? null,
      ],
    ).catch((e) => log.error('[basket] could not record the run:', e));

  const bandPct = Number(basket.band_pct);
  const { sleeves, totalUsd, unpriced } = await readBasket(wallet.address, basket.targets);
  const plan = planBasket(sleeves, totalUsd, bandPct, unpriced);

  if (plan.action === 'stand_down') {
    await finish('skipped', plan.reason);
    return { status: 'skipped', detail: plan.reason };
  }

  if (plan.action === 'in_band') {
    /*
     * Recorded, not silently dropped. "We looked and everything was within the band" is the answer
     * a rebalancer gives most days, and a schedule that showed nothing on those days would look
     * like a strategy that had stopped running.
     */
    const detail = `Every sleeve is inside the ${bandPct}% band — the furthest is ${plan.worstDriftPct.toFixed(1)} points out.`;
    await finish('skipped', detail, { driftPct: plan.worstDriftPct });
    return { status: 'skipped', detail };
  }

  const { leg } = plan;
  const outcome = await guardAndSpend({
    walletId: wallet.id,
    ownerPubkey: wallet.address,
    symbol: leg.symbol,
    usd: leg.usd,
    side: leg.side,
  }).catch((e) => ({ placed: false as const, status: 'blocked' as const, reason: 'threw', detail: String(e) }));

  if (!outcome.placed) {
    await finish('failed', outcome.detail, { symbol: leg.symbol, side: leg.side, usd: leg.usd, driftPct: leg.driftPct });
    return { status: 'failed', detail: outcome.detail };
  }

  const verb = leg.side === 'sell' ? 'Sold' : 'Bought';
  const direction = leg.driftPct > 0 ? 'over' : 'under';
  const detail = `${leg.symbol} was ${Math.abs(leg.driftPct).toFixed(1)} points ${direction} its ${sleeveTarget(sleeves, leg.symbol)}% target, past the ${bandPct}% band.`;

  await finish('filled', detail, {
    symbol: leg.symbol,
    side: leg.side,
    usd: outcome.usd,
    driftPct: leg.driftPct,
    signature: outcome.signature,
  });

  await append({
    walletId: wallet.id,
    agent: 'Basket',
    action: `${verb} ${leg.symbol} to rebalance`,
    detail,
    amount: `$${outcome.usd.toFixed(2)}`,
    kind: 'trade',
    signature: outcome.signature,
    payload: {
      basketRunId: runId,
      periodKey: key,
      symbol: leg.symbol,
      side: leg.side,
      usd: outcome.usd,
      driftPct: leg.driftPct,
      bandPct,
      totalUsd,
      targets: basket.targets,
      sleeves: sleeves.map((s) => ({ symbol: s.symbol, targetPct: s.targetPct, actualPct: s.actualPct })),
    },
  }).catch((e) => log.error('[basket] could not write the audit row:', e));

  return {
    status: 'filled',
    symbol: leg.symbol,
    side: leg.side,
    usd: outcome.usd,
    signature: outcome.signature,
    driftPct: leg.driftPct,
  };
}

function sleeveTarget(sleeves: Sleeve[], symbol: string): string {
  return String(sleeves.find((s) => s.symbol === symbol)?.targetPct ?? '');
}

/**
 * One scheduler tick's worth of rebalancing, across the wallets that asked for it.
 */
export async function basketSweep(at: Date = new Date()): Promise<number> {
  const rows = await query<BasketRow & { address: string }>(
    `SELECT b.wallet_id, b.targets, b.band_pct, b.cadence, b.enabled, w.address
       FROM agent_baskets b
       JOIN wallets w ON w.id = b.wallet_id
      WHERE b.enabled = true
        AND w.address IS NOT NULL
        AND (w.agents_stopped IS NULL OR w.agents_stopped = false)
      LIMIT 20`,
  ).catch(() => []);

  let traded = 0;
  for (const row of rows) {
    try {
      const out = await rebalanceOnce({ id: row.wallet_id, address: row.address }, row, at);
      if (out?.status === 'filled') {
        traded += 1;
        log.info(`[basket] ${out.side} ${out.symbol} $${out.usd.toFixed(2)} — ${out.signature}`);
      }
    } catch (e) {
      log.error(`[basket] sweep error for wallet ${row.wallet_id}:`, e);
    }
  }
  return traded;
}
