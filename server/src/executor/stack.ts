/**
 * Several strategies on one symbol, without them selling the same units twice.
 *
 * Stacking is the ordinary thing people want: a recurring buy accumulating NVDAx, a trailing stop
 * under it, and a take-profit above. Nothing in the schema prevented that — `strategy_runs.period_key`
 * is keyed per STRATEGY, so two strategies on one symbol already claim their own runs and the
 * idempotency guarantee is untouched by stacking.
 *
 * What prevented it was one line in `armExits`, refusing a second exit on a symbol, and the reason
 * it was there is real: `planExitRules` closes the WHOLE position, so two exits firing in the same
 * window would each try to sell everything. The first would succeed and the second would attempt to
 * sell units that no longer exist.
 *
 * ## The fix is to size the sell, not to forbid the strategy
 *
 * A sell is sized against what is left AFTER other strategies' sells in the same period — those
 * already filled, and those still in flight. In flight counts, and that is the important half:
 * a run that has broadcast but not confirmed has spent those units as surely as one that has
 * settled, and ignoring it is how two stops fire ten seconds apart and the second reverts.
 *
 * ## Why the period, and not all time
 *
 * A sell from last week is already reflected in the balance this reads, so counting it again would
 * subtract it twice. Only the sells that this balance cannot yet have seen are deducted — the ones
 * in the window the wallet's own reads may still be behind.
 */
import { query } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';

/** How far back an in-flight sell is still assumed to be missing from the balance. */
const IN_FLIGHT_WINDOW_MINUTES = 30;

export type StackedStrategy = {
  id: string;
  kind: string;
  label: string;
  state: string;
  /** What it commits per day. Zero for the ones that can only close. */
  dailyAllocationUsd: number;
  nextRunAt: number | null;
  /** Can it open a position, or only reduce one? */
  closeOnly: boolean;
};

/** Kinds that can only ever reduce a position. Mirrors `run.ts`'s own list. */
const CLOSE_ONLY = new Set(['exit-rules']);

/**
 * Every live strategy pointed at one symbol.
 *
 * Ordered so the ones that can open come first: reading a stack, the question is almost always
 * "what is building this position" before "what is protecting it".
 */
export async function stackOn(walletId: string, symbol: string): Promise<StackedStrategy[]> {
  const rows = await query<{
    id: string;
    kind: string;
    label: string;
    state: string;
    daily_allocation_usd: string;
    next_run_at: Date | null;
  }>(
    `SELECT id, kind, label, state, daily_allocation_usd, next_run_at
       FROM strategies
      WHERE wallet_id = $1 AND symbol = $2 AND state IN ('live','watch') AND chain = ${THIS_CHAIN}
      ORDER BY created_at ASC`,
    [walletId, symbol],
  );

  return rows
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      state: r.state,
      dailyAllocationUsd: Number(r.daily_allocation_usd ?? 0),
      nextRunAt: r.next_run_at ? new Date(r.next_run_at).getTime() : null,
      closeOnly: CLOSE_ONLY.has(r.kind),
    }))
    .sort((a, b) => Number(a.closeOnly) - Number(b.closeOnly));
}

/**
 * Units that OTHER strategies on this symbol have already committed to selling.
 *
 * Counts `pending` as well as `filled`. A pending run is one that has claimed its period and may
 * have broadcast; treating it as zero is exactly how a second stop sells units the first has
 * already sent to the chain.
 *
 * `failed` and `blocked` are excluded — those units were never sold and are still there to sell.
 */
export async function claimedSellUnits(
  walletId: string,
  symbol: string,
  excludeStrategyId: string,
): Promise<number> {
  const rows = await query<{ units: string | null }>(
    `SELECT r.units
       FROM strategy_runs r
       JOIN strategies s ON s.id = r.strategy_id
      WHERE s.wallet_id = $1
        AND s.symbol = $2
        AND s.id <> $3
        AND r.side = 'sell'
        AND r.status IN ('pending','filled')
        AND r.started_at > now() - ($4 || ' minutes')::interval
        AND s.chain = ${THIS_CHAIN}`,
    [walletId, symbol, excludeStrategyId, String(IN_FLIGHT_WINDOW_MINUTES)],
  ).catch(() => []);

  return rows.reduce((total, r) => total + Math.max(0, Number(r.units ?? 0)), 0);
}

/**
 * What this strategy may actually sell: what is held, less what the others have spoken for.
 *
 * Never negative. A claim larger than the balance means the others have already sold everything —
 * the answer is zero units to sell, not a negative quantity to be arithmetic'd into a buy.
 */
export function sellableUnits(heldUnits: number, claimedUnits: number): number {
  if (!Number.isFinite(heldUnits) || heldUnits <= 0) return 0;
  const left = heldUnits - Math.max(0, claimedUnits);
  return left > 0 ? left : 0;
}

/**
 * What a stack commits per day, and what it is protected by.
 *
 * The opening allocations summed, because that is the number the daily cap is measured against and
 * the one a person means by "how much is this costing me". The close-only strategies are counted
 * separately rather than added in: a stop-loss commits nothing and adding its zero to the total
 * would suggest it had been considered and found to cost nothing, rather than not applying.
 */
export function stackSummary(stack: StackedStrategy[]): {
  opening: number;
  closeOnly: number;
  dailyCommitmentUsd: number;
} {
  const opening = stack.filter((s) => !s.closeOnly);
  return {
    opening: opening.length,
    closeOnly: stack.length - opening.length,
    dailyCommitmentUsd: opening.reduce((a, s) => a + s.dailyAllocationUsd, 0),
  };
}
