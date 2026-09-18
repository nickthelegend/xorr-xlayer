/**
 * What each wallet was worth, when (PLAN.md 2.10).
 *
 * The Portfolio graph replays what is held now over last week's prices: it shows how today's holdings
 * would have moved and cannot show a deposit, a sale or a withdrawal at all. A graph of what the wallet
 * was actually worth needs the value at the time, and nothing kept it. This keeps it — read from the chain
 * the way `/wallet/balance` reads it, every 15 minutes for each wallet with something on this chain, and
 * straight after a fill, a close or a withdrawal.
 *
 * A value that cannot be read in full keeps nothing. An unpriced holding or an unanswered Aave read would
 * store a dip that never happened, forever; a gap is the honest record of not knowing.
 */
import type { Address } from 'viem';
import { query } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { totalValueUsd } from '../evm/balances.js';
import { log } from '../http/request-id.js';

export type SnapshotReason = 'interval' | 'fill' | 'close' | 'withdrawal';
export type HistoryPoint = { at: number; totalUsd: number; reason: SnapshotReason };

export const SNAPSHOT_EVERY_MS = 15 * 60_000;
export const MAX_HISTORY_POINTS = 500;

const RANGE_MS = { '1D': 86_400_000, '1W': 7 * 86_400_000, '1M': 30 * 86_400_000, ALL: null } as const;
export type HistoryRange = keyof typeof RANGE_MS;

/** Where a range starts: a date, `null` for all of it, or `undefined` for a range that is not one. */
export function historySince(range: string, now = Date.now()): Date | null | undefined {
  if (!Object.hasOwn(RANGE_MS, range)) return undefined;
  const ms = RANGE_MS[range as HistoryRange];
  return ms === null ? null : new Date(now - ms);
}

/** Read the wallet's value from the chain and keep it. False, with nothing kept, when it could not be read in full. */
export async function snapshotWallet(
  wallet: { id: string; address: string },
  reason: SnapshotReason,
): Promise<boolean> {
  let value: Awaited<ReturnType<typeof totalValueUsd>>;
  try {
    value = await totalValueUsd(wallet.address as Address, { strict: true });
  } catch (e) {
    log.warn(`[snapshot] nothing kept for wallet ${wallet.id}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  await query(
    `INSERT INTO portfolio_snapshots (wallet_id, total_usd, cash_usd, holdings_usd, supplied_usd, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [wallet.id, value.total, value.cash, value.holdings.reduce((sum, h) => sum + h.usd, 0), value.supplied, reason],
  );
  return true;
}

/** When each wallet was last attempted, so one that cannot be read is not re-read every tick. */
const attempted = new Map<string, number>();

/** Testing only. */
export function clearSnapshotAttempts(): void {
  attempted.clear();
}

/**
 * Snapshot every wallet that is due: something on this chain — a strategy that is not ended, an open
 * position — or used in the last week, and nothing kept for it in the last 15 minutes. Addresses that are
 * not addresses (test rows) are never read.
 */
export async function snapshotSweep(now = Date.now(), limit = 20): Promise<{ recorded: number; failed: number }> {
  const due = await query<{ id: string; address: string }>(
    `SELECT w.id, w.address FROM wallets w
      WHERE w.address ~ '^0x[0-9a-fA-F]{40}$'
        AND (EXISTS (SELECT 1 FROM strategies s
                      WHERE s.wallet_id = w.id AND s.chain = ${THIS_CHAIN} AND s.state IN ('live', 'watch', 'paused'))
          OR EXISTS (SELECT 1 FROM positions p
                      WHERE p.wallet_id = w.id AND p.chain = ${THIS_CHAIN} AND p.units > 0.000001)
          OR w.active_at > now() - interval '7 days')
        AND NOT EXISTS (SELECT 1 FROM portfolio_snapshots ps
                         WHERE ps.wallet_id = w.id AND ps.chain = ${THIS_CHAIN} AND ps.at > now() - interval '15 minutes')
      ORDER BY w.active_at DESC NULLS LAST
      LIMIT $1`,
    [limit * 2],
  );
  let recorded = 0;
  let failed = 0;
  for (const w of due) {
    if (recorded + failed >= limit) break;
    if (now - (attempted.get(w.id) ?? 0) < SNAPSHOT_EVERY_MS) continue;
    attempted.set(w.id, now);
    if (await snapshotWallet(w, 'interval')) recorded += 1;
    else failed += 1;
  }
  return { recorded, failed };
}

/** A wallet's snapshots on this chain since `since` (or all of them), oldest first. */
export async function listSnapshots(walletId: string, since: Date | null): Promise<HistoryPoint[]> {
  const rows = await query<{ at: Date; total_usd: string; reason: SnapshotReason }>(
    `SELECT at, total_usd, reason FROM portfolio_snapshots
      WHERE wallet_id = $1 AND chain = ${THIS_CHAIN} AND ($2::timestamptz IS NULL OR at >= $2)
      ORDER BY at ASC`,
    [walletId, since],
  );
  return rows.map((r) => ({ at: new Date(r.at).getTime(), totalUsd: Number(r.total_usd), reason: r.reason }));
}

/**
 * At most `max` points, oldest first. Every event — a fill, a close, a withdrawal — and the latest point
 * are always kept (so a history of more events than `max` returns them all); the interval points between
 * are sampled evenly. Nothing is averaged or interpolated: every point returned is a value that was read.
 */
export function thinPoints(points: HistoryPoint[], max = MAX_HISTORY_POINTS): HistoryPoint[] {
  if (points.length <= max) return points;
  const keep = new Set<number>();
  points.forEach((p, i) => {
    if (p.reason !== 'interval') keep.add(i);
  });
  keep.add(points.length - 1);
  const intervals = points.map((_, i) => i).filter((i) => !keep.has(i));
  const room = Math.max(0, max - keep.size);
  const step = intervals.length / Math.max(room, 1);
  for (let k = 0; k < room; k += 1) keep.add(intervals[Math.floor(k * step)]!);
  return [...keep].sort((a, b) => a - b).map((i) => points[i]!);
}
