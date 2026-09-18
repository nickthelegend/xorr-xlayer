/**
 * Schedule arithmetic for recurring strategies — PLAN.md 9.3.
 *
 * Pure and deterministic: the executor and the app must agree, to the millisecond, on when a run
 * is due. `periodKey` is the idempotency key — one run per period, ever, no matter how many times
 * a retry fires. PLAN.md 12.8: "A DCA retry that double-buys is how a trading bot loses real
 * money quietly."
 */
import type { Cadence } from '../data/types';

export const CADENCE_DAYS: Record<Cadence, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

/** Advance one period from `from`. Monthly steps the calendar month, not 30 days. */
export function advance(from: Date, cadence: Cadence): Date {
  const d = new Date(from.getTime());
  if (cadence === 'monthly') {
    d.setMonth(d.getMonth() + 1);
    return d;
  }
  d.setDate(d.getDate() + CADENCE_DAYS[cadence]);
  return d;
}

/** The next `count` run times, starting one period from now. */
export function nextRuns(cadence: Cadence, count: number, from: Date = new Date()): Date[] {
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    cursor = advance(cursor, cadence);
    out.push(new Date(cursor.getTime()));
  }
  return out;
}

/**
 * The idempotency key for a run. Two attempts in the same period produce the same key, so the
 * executor's unique index rejects the second — which is what makes a retry safe.
 */
export function periodKey(strategyId: string, cadence: Cadence, at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(at.getUTCDate()).padStart(2, '0');
  switch (cadence) {
    case 'daily':
      return `${strategyId}:${y}-${m}-${d}`;
    case 'weekly':
    case 'biweekly': {
      // ISO week number, so a run is pinned to a week rather than to a rolling 7 days.
      const tmp = new Date(Date.UTC(y, at.getUTCMonth(), at.getUTCDate()));
      const day = tmp.getUTCDay() || 7;
      tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
      const bucket = cadence === 'biweekly' ? Math.floor(week / 2) : week;
      return `${strategyId}:${tmp.getUTCFullYear()}-W${bucket}`;
    }
    case 'monthly':
      return `${strategyId}:${y}-${m}`;
  }
}

/** Is a run due? True when now is at or past the scheduled time. */
export function isDue(nextRunAt: number, now: number = Date.now()): boolean {
  return now >= nextRunAt;
}
