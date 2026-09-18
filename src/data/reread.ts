/**
 * When a screen reads its numbers again on its own (FEATURES.md #27), kept apart from `useAsync` so the rule is testable
 * without the Expo runtime — the arrangement `pollState.ts` has with `usePoll.ts`.
 *
 * Every read here happened once, when its screen mounted, so a screen come back to showed what it showed before: Portfolio,
 * returned to from a sale on the position screen, went on listing the position, and a phone taken out of a pocket showed
 * the balance from when it went in. A screen that regains focus, or an app back in the foreground, now reads again
 * (`useFreshOnReturn.ts`) — but not every time. Switching between two tabs is a focus event each way, and a read per switch
 * would ask the executor for `/positions`, measured at 31s cold, as fast as a thumb can tap.
 */

/** How old the last answer must be before coming back to a screen reads it again. */
export const REREAD_AFTER_MS = 15_000;

/** What `useAsync` holds: the question (`key`) its last read answered, and the answer — data or a failure. */
export type Settled<T> = { key: string; at?: number; data?: T; error?: Error };

export type RereadResult<T> = { ok: true; data: T; at: number } | { ok: false; error: Error };

/**
 * Is it worth reading this again now?
 *
 * Never while a read of it is already on its way — the first one, a retry, or an earlier re-read — because that answer
 * is the fresh one; and never before anything has come back, for the same reason. Otherwise once the last answer is
 * `afterMs` old. A failure counts as an answer here, so an executor that is down is asked again at that pace rather than
 * on every return.
 */
export function shouldReread(
  read: { now: number; lastSettledAt: number | undefined; inFlight: boolean },
  afterMs: number = REREAD_AFTER_MS,
): boolean {
  if (read.inFlight || read.lastSettledAt === undefined) return false;
  const age = read.now - read.lastSettledAt;
  // A clock set back makes the age negative: an age nobody knows, not a fresh answer.
  return age < 0 || age >= afterMs;
}

/**
 * What a re-read leaves on screen.
 *
 * An answer replaces the one before it and clears any failure. A failure is kept BESIDE the last answer rather than in
 * place of it — the rule `pollState.ts` makes for a polled balance, for the same reason: a funded wallet must not blank to
 * dashes because a read made in the background failed. The error is set for the question on screen, so each screen's own
 * failure state still says what happened, and `at` stays the time of the data it kept.
 *
 * A re-read of a question the screen is no longer asking — its deps changed while the read was out — is dropped.
 */
export function settleReread<T>(prev: Settled<T>, asked: string, result: RereadResult<T>): Settled<T> {
  if (prev.key !== asked) return prev;
  return result.ok ? { key: asked, data: result.data, at: result.at } : { ...prev, error: result.error };
}
