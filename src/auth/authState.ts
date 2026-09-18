/**
 * What the app positively knows about whether anyone is signed in.
 *
 * `api` refuses to send an authenticated request without a token, which stopped a signed-out
 * visitor producing a 401 for every read on the home screen. But "no token" and "no token YET" are
 * different, and conflating them was worse than the problem it fixed: on a freshly established
 * Privy session the token is briefly unavailable, so every read fired in that window was silently
 * dropped — not attempted, not retried, not logged — and the screen rendered its empty state
 * permanently. Fifty-three routes made two authenticated requests between them.
 *
 * So the guard only applies when the answer is KNOWN to be "signed out". While it is unknown the
 * request goes out, exactly as it always did: at worst it 401s, which is visible, recoverable and
 * honest. Silence is none of those.
 */
import { clearSessionEnded } from './reauth';

export type AuthKnowledge = 'unknown' | 'signed-in' | 'signed-out';

let state: AuthKnowledge = 'unknown';

/** Resolved the moment the answer stops being 'unknown'. */
let settled: (() => void) | undefined;
const known = new Promise<void>((resolve) => {
  settled = resolve;
});

/** Set from Privy's own `ready` / `authenticated`, which is the only thing that actually knows. */
export function setAuthKnowledge(next: AuthKnowledge): void {
  state = next;
  if (next !== 'unknown') settled?.();
  /*
   * A session again means the expiry prompt has done its job.
   *
   * Cleared on Privy reporting `signed-in` rather than on the user tapping the button: tapping only
   * opens a screen, and being signed in is what actually ends the state. Note that `api.ts` sets
   * `signed-out` itself when it detects an expiry, which is why this only clears on the way in.
   */
  if (next === 'signed-in') clearSessionEnded();
}

/**
 * Wait, briefly, for the answer.
 *
 * The reason 'unknown' exists is that Privy takes a moment to restore a session, and a request
 * fired inside that moment carries no token. Letting it go anyway produced a 401 — visible and
 * honest, and never retried, because a screen reads once on mount. So a cold load of the home
 * screen showed a dash for the balance of a wallet holding $99,974, permanently, for a user who
 * was in fact signed in.
 *
 * Waiting is not the same as dropping: the request still goes, a few hundred milliseconds later,
 * with the credential it needed. The timeout is the backstop for a Privy that never answers at
 * all — then the request goes out as it used to and 401s, which is still better than hanging.
 */
const SETTLE_TIMEOUT_MS = 5_000;

export async function whenAuthKnown(timeoutMs = SETTLE_TIMEOUT_MS): Promise<AuthKnowledge> {
  if (state !== 'unknown') return state;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    known,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return state;
}

export function authKnowledge(): AuthKnowledge {
  return state;
}

/** Testing only. */
export function resetAuthKnowledge(): void {
  state = 'unknown';
  settled = undefined;
}
