/**
 * What resuming a paused strategy means, kept apart from the route that does it.
 *
 * Pausing one strategy is not the kill switch. The kill switch revokes the delegation on chain and
 * stops everything; this stops one row from being selected by `scheduler.ts`, which reads only
 * `live` and `watch`. The permission is untouched, which is the whole point — and is also why the
 * two must never be described in the same words anywhere a user can read them.
 *
 * Two rules live here because both were wrong in ways that cost money rather than clarity.
 */
import { advance, type Cadence } from './schedule.js';

/** The states a strategy can be paused out of and put back into. */
export type ResumableState = 'live' | 'watch';

/**
 * Which state a resume returns to.
 *
 * Resume used to mean `live`, full stop. A strategy in `watch` — the state whose entire purpose is
 * to record what it WOULD do and move nothing — came back from a pause able to spend. Nobody asked
 * for that, nothing announced it, and the row looked the same either way in the list.
 *
 * So the state it was paused out of is stored on the row (`paused_from`, migration 031) and read
 * back here. An older row that was paused before the column existed carries nothing, and `live` is
 * the honest default for it: that is what a resume did when the row was written, and quietly
 * demoting someone's live strategy to watch would be its own surprise.
 */
export function stateOnResume(pausedFrom: string | null | undefined): ResumableState {
  return pausedFrom === 'watch' ? 'watch' : 'live';
}

/**
 * When a resumed strategy should next run.
 *
 * Resuming used to fire immediately, and for a recurring buy that means spending money the instant
 * you tap it. `next_run_at` stays where it was while a strategy is paused, so a daily DCA paused on
 * Monday and resumed on Friday is four days overdue: the next tick selects it, `periodKey` buckets
 * it under FRIDAY — not the Monday it was actually due — and a real buy settles seconds after a tap
 * that said "resume", not "buy".
 *
 * A resume is not an order. The rule is that it never causes an immediate spend: a due time already
 * past is moved forward to the next slot from now, and a due time still ahead is left exactly where
 * the user set it. "Run now" sits next to Resume in the list for anyone who did want it at once.
 *
 * A strategy with no cadence has nothing to advance — a one-shot's due time is the only one it has.
 */
export function nextRunOnResume(
  nextRunAt: Date | null,
  cadence: Cadence | null,
  now: Date,
): Date | null {
  if (!nextRunAt || !cadence) return nextRunAt;
  if (nextRunAt.getTime() > now.getTime()) return nextRunAt;

  /*
   * Forward from NOW, not from the missed slot.
   *
   * Advancing from `nextRunAt` would land on another past date for anything paused longer than one
   * period — a daily paused for a month would need thirty steps — and each step is a period the
   * user was not running. One slot from now is the first moment the schedule means anything again.
   */
  return advance(now, cadence);
}

/**
 * Whether a resume moved the schedule, so the answer can say so.
 *
 * A silent change to when someone's money moves is the kind of helpfulness that reads as a bug the
 * first time it surprises them.
 */
export function resumeMovedSchedule(before: Date | null, after: Date | null): boolean {
  if (!before || !after) return false;
  return before.getTime() !== after.getTime();
}
