/**
 * Telling someone their session ended, once, and offering the way back in.
 *
 * `api.ts` can now tell a stale token from a finished session, and raises `SessionExpired` for the
 * second. That is the right error for the screen that asked — but a phone with six screens mounted
 * makes six reads, so six of them report it, and the app becomes a wall of the same sentence.
 *
 * Worse, none of them can act on it: the fix is not on any of those screens, it is signing in.
 *
 * So the fact is recorded here, where the app can say it in one place with the one control that
 * helps. The screens keep their own error — a screen that silently showed nothing would be back to
 * the emptiness problem — but the prompt is not theirs to draw.
 *
 * Deliberately not a modal. A dead session does not touch the delegation, which lives on chain and
 * is revoked by a signature the user makes themselves, so the kill switch still works and covering
 * the app would take that away at the moment someone might most want it.
 */

type Listener = () => void;

let endedAt: number | null = null;
const listeners = new Set<Listener>();

/**
 * Record that the session is over.
 *
 * Idempotent: six screens discovering it within a second is one event, and re-notifying on each
 * would re-render the prompt five times for nothing.
 */
export function noteSessionEnded(now: number = Date.now()): void {
  if (endedAt !== null) return;
  endedAt = now;
  for (const l of listeners) l();
}

/**
 * Forget it, on a successful sign-in.
 *
 * Called when Privy reports an authenticated session again, rather than when the user taps the
 * button: tapping opens a screen, and being signed in is what actually ends this state.
 */
export function clearSessionEnded(): void {
  if (endedAt === null) return;
  endedAt = null;
  for (const l of listeners) l();
}

export function sessionEndedAt(): number | null {
  return endedAt;
}

export function subscribeSessionEnded(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Testing only. */
export function resetSessionEnded(): void {
  endedAt = null;
  listeners.clear();
}

/**
 * What the prompt says.
 *
 * It names the cause, because "sign in" with no reason on a screen someone was already using reads
 * as the app having logged them out arbitrarily. And it says what is untouched: on a trading app, a
 * session ending is exactly the moment someone wonders whether their money is still where they left
 * it, and the honest answer costs one sentence.
 */
export const SESSION_ENDED_TITLE = 'Your session ended';
export const SESSION_ENDED_DETAIL =
  'Sign in again to load your account. Nothing was changed — your funds and your permission are on chain, and stopping your agents still works.';
