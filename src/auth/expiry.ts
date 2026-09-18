/**
 * A session that ends while the app is open.
 *
 * A Privy access token is short-lived. When one expires the executor answers 401, and until now
 * that arrived at every screen as `ApiError(401, "401 Unauthorized")` — a raw status code rendered
 * as a failure, on every list at once, for something that is not a fault at all. The reader saw an
 * app that had broken rather than a session that had ended, and nothing offered them the one thing
 * that fixes it.
 *
 * Two different situations hide behind one status:
 *
 *   the token is merely STALE — the session is still good and Privy will mint a new token on ask.
 *                               The user should never learn this happened.
 *   the session is OVER       — refreshing produces nothing usable. They have to sign in again, and
 *                               saying so once is more use than fifteen screens each saying "401".
 *
 * Telling them apart costs one retry, and the retry is safe: `authMiddleware` runs before any
 * handler, so a 401 means the request was refused before it could do anything. That holds for a
 * write as much as a read, which is what makes retrying a POST acceptable here and nowhere else.
 */

/** How many times one request may be retried after a 401. Exactly one: a second would be a loop. */
export const MAX_REAUTH_ATTEMPTS = 1;

/**
 * The end of a session, as an error a screen can recognise.
 *
 * Its own class so `failures.ts` can key on it without string-matching a status line, and so the
 * one thing worth saying — sign in again — is attached to the error rather than guessed at by
 * whichever screen happened to catch it.
 */
export class SessionExpired extends Error {
  override readonly name = 'SessionExpired';
  constructor(path: string) {
    super(`Your session ended, so ${path} was not loaded. Sign in again to continue.`);
  }
}

/**
 * Should this 401 be retried with a fresh token?
 *
 * Only the first, and only when a genuinely different token came back. Retrying with the same
 * string asks the same rejected question again, which turns one refusal into two and delays the
 * honest answer by a round trip.
 */
export function shouldRetryWithToken(params: {
  attempt: number;
  previous: string | null;
  fresh: string | null;
}): boolean {
  if (params.attempt >= MAX_REAUTH_ATTEMPTS) return false;
  if (!params.fresh) return false;
  return params.fresh !== params.previous;
}

/**
 * What the app should conclude once a 401 has survived its retry.
 *
 * `over` is a claim about the user's session and it is made only when the evidence supports it: a
 * 401 answered while holding a token Privy had just minted. A 401 with no token at all is the
 * ordinary signed-out case and is already handled before the request goes out.
 */
export function sessionVerdict(params: {
  retried: boolean;
  fresh: string | null;
}): 'over' | 'inconclusive' {
  /*
   * Without a fresh token there is nothing to distinguish "expired" from "Privy could not be
   * reached to refresh it". Declaring the session over on that evidence would sign someone out
   * because their phone lost signal for a second, which is a worse failure than the one this fixes.
   */
  if (!params.fresh) return 'inconclusive';
  return params.retried ? 'over' : 'inconclusive';
}
