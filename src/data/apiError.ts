/**
 * What a refusal actually said, kept away from anything that needs a runtime.
 *
 * These two live apart from `api.ts` because they are pure and `api.ts` is not: it reaches
 * `expo-application` through the auth headers, which pulls in `expo-modules-core` and its
 * `__DEV__` global. Importing that into a unit test fails before a single assertion runs, so the
 * one piece worth testing was the one piece that could not be.
 */
/**
 * An HTTP answer we did not want, with the body attached.
 *
 * A 409 from `/orders` is not a transport failure — it is the policy engine saying no, in a
 * sentence written for the user. Losing that to `new Error('409 Conflict')` meant the screen
 * had to show a status code where it could have shown "the daily cap is spent".
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
    /** The id the request carried as `x-request-id`, which the executor's log lines for it begin with. */
    readonly requestId?: string,
    /**
     * `retry-after`, in seconds, where the answer carried one.
     *
     * The executor sends it on both of the refusals that mean "not now": the rate limiter's 429 and a 503 from
     * something still warming. Without it a screen offering a retry is guessing at when, and the guess is
     * always "immediately" — which against a limiter is how a user turns one refusal into six.
     */
    readonly retryAfterSec?: number,
    /**
     * `idempotent-replay`, set by `server/src/http/idempotency.ts` when this answer is a STORED one: the same
     * key was sent before, and this is what that first attempt did rather than a second thing happening.
     */
    readonly replayed?: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The mark a replayed answer carries.
 *
 * `idempotent-replay: true` on a 200 means the executor had already run this key and is handing back what that
 * first attempt did — so the order filled once, a while ago, and this tap placed nothing. A screen that cannot
 * tell those apart shows "Bought 0.0412 XBTC" twice for one fill.
 *
 * A symbol and non-enumerable, so it travels on the parsed body without appearing in it: these bodies are
 * compared, spread and serialised all over the app, and a stray `replayed: true` key would show up in every
 * one of those places.
 */
export const REPLAYED = Symbol.for('xorr.idempotentReplay');

/** Put the replay mark on a value, for the repositories that unwrap an answer out of the error it arrived in. */
export function markReplayed<T>(value: T, replayed: boolean): T {
  if (replayed && value !== null && typeof value === 'object') {
    Object.defineProperty(value, REPLAYED, { value: true, enumerable: false });
  }
  return value;
}

/** Was this answer the executor repeating what an earlier attempt with the same key did? */
export function wasReplayed(value: unknown): boolean {
  return (
    (value !== null && typeof value === 'object' && (value as Record<symbol, unknown>)[REPLAYED] === true) ||
    (value instanceof ApiError && value.replayed === true)
  );
}

/** `retry-after` as seconds. The header is seconds or an HTTP date; both are real, and neither is a number here. */
export function retryAfterSeconds(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  // A date already past is not a wait. Zero, so a caller says "now" rather than a negative number of seconds.
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * The prose fields only: the sentence someone wrote, never an identifier.
 *
 * Split out of `apiReason` for `failures.ts`, which has a sentence of its own for every code it knows. There,
 * preferring `no_delegation` over "No trading permission is granted, so nothing can be placed." is exactly
 * backwards — the identifier is the last resort precisely because nobody had written the sentence yet, and
 * for those codes somebody now has.
 */
export function apiProse(e: unknown): string | undefined {
  if (!(e instanceof ApiError)) return undefined;
  const body = e.body as { message?: unknown; detail?: unknown } | undefined;
  return [body?.message, body?.detail].find((v): v is string => typeof v === 'string' && v.trim().length > 0)?.trim();
}

/**
 * The server's own sentence, when it wrote one.
 *
 * Routes answer a refusal as `{ error, message }` or `{ error }` — the policy engine's wording,
 * the venue's reason, "No route for USDC -> XBTC". Screens were rendering their own generic
 * substitute over the top of it: "No route available" where the executor had said which pair and
 * why. A stated reason is the difference between a user retrying pointlessly and a user knowing
 * to change something.
 *
 * Falls back to undefined rather than to the raw message, so a caller can choose its own wording
 * when there is genuinely nothing to report — an HTTP status is not a sentence.
 */
export function apiReason(e: unknown): string | undefined {
  if (!(e instanceof ApiError)) return undefined;
  const body = e.body as
    | { message?: unknown; detail?: unknown; error?: unknown; reason?: unknown }
    | undefined;

  /*
   * The prose fields first, and `detail` is one of them.
   *
   * This read `message` then `error`, and never `detail` — where forty-eight of this server's
   * responses put the sentence. So `{"error":"unauthorized","detail":"Missing bearer token."}`
   * reached the user as the single word **unauthorized**, and a rejected order as
   * **invalid_request**, with the written explanation sitting unread in the next field.
   *
   * `error` and `reason` are identifiers — `no_route`, `not_tradable`, `duplicate_alert` — kept as
   * the last resort for exactly the purpose the note below describes: a screen showing one is a
   * screen that still needs a sentence written for it, and that should stay visible rather than be
   * hidden behind a generic fallback.
   */
  const prose = apiProse(e);
  const reason = prose ?? body?.error ?? body?.reason;
  if (typeof reason !== 'string' || !reason.trim()) return undefined;
  // `no_route` and `insufficient_liquidity` are identifiers, not prose. Left alone deliberately:
  // a screen that shows one is a screen we should give a sentence to, and hiding it here would
  // make that invisible.
  return reason.trim();
}

/**
 * The sentence to put in front of a user, out of whatever the failure carried.
 *
 * `ApiError.message` keeps the raw wire form on purpose — `404 Not Found: {"error":"XBTC is not a
 * tokenized equity"}` — because throwing information away at the boundary is how a screen ends up
 * with a status code and nothing else. But `ErrorState` was rendering exactly that string, so the
 * raw body, the braces and the quotes went on screen: /oracle/XBTC showed the JSON verbatim.
 *
 * The server already wrote the sentence. Prefer it; fall back to the status when the body carried
 * no prose, and leave non-HTTP errors alone — `TimedOut` and `NotSignedIn` write their own.
 */
export function errorText(e: unknown): string {
  const reason = apiReason(e);
  if (reason) return reason;
  if (e instanceof ApiError) {
    // No prose in the body. A bare status is not a sentence either, so say what happened in one.
    return `The executor answered ${e.status}.`;
  }
  return e instanceof Error && e.message ? e.message : 'Something went wrong.';
}

/**
 * Is trying the identical request again worth offering?
 *
 * A "Try again" button under a permanent refusal is a worse failure than no button: it invites a
 * user to keep pressing something that will answer the same way forever. /oracle/XBTC offered a
 * retry on "XBTC is not a tokenized equity", which is not going to change.
 *
 * 4xx means the request was wrong, so repeating it unchanged gets the same answer — except 408 and
 * 429, which are explicitly "not now, try later". Everything else (5xx, timeouts, transport) is
 * worth another go.
 */
export function isRetryable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  if (e.status === 408 || e.status === 429) return true;
  return e.status < 400 || e.status >= 500;
}

/**
 * Thrown instead of sending a request that is certain to be rejected.
 *
 * Screens already treat a failed read as "no data", which is the right rendering for a signed-out
 * user — the difference is that they now get there without three 401s in the console and three
 * pointless round trips.
 */
export class NotSignedIn extends Error {
  constructor(path: string) {
    super(`Not signed in, so ${path} was not requested.`);
    this.name = 'NotSignedIn';
  }
}

/**
 * The executor did not answer in time.
 *
 * Nothing in this client was bounded, and `fetch` on its own never gives up. A single request the
 * server never finished — a `POST /orders` whose swap wedged upstream — left the order ticket
 * spinning on its green button with no error, no timeout and no way back: the only exit was to
 * kill the app. Found by placing a real order on a simulator and watching it never return.
 *
 * A bound is not a fix for a slow server. It is the difference between a state the user can act on
 * and one they cannot leave.
 */
export class TimedOut extends Error {
  constructor(
    readonly path: string,
    readonly ms: number,
    /** The id the request carried: it may still be running, and this is how its log lines are found. */
    readonly requestId?: string,
  ) {
    // Never "it failed". A request that timed out may still be running on the server, and for a
    // trade the difference between those two sentences is a double spend.
    super(
      `The executor did not answer within ${Math.round(ms / 1000)}s. ` +
        'It may still be working — check Activity before trying again.',
    );
    this.name = 'TimedOut';
  }
}

/**
 * A reference for a failure worth reporting (FEATURES.md #90): the first eight characters of the request's id, which is
 * how every log line the executor writes for that request begins (`server/src/http/request-id.ts`).
 *
 * Only where it helps. A 5xx is the server's own fault, and a timed-out request may still be running: those are what
 * someone reports, and the reference is what finds them. A 4xx already says what to change, and a signed-out or offline
 * failure never reached a log at all.
 */
export function errorRef(e: unknown): string | undefined {
  const id =
    e instanceof TimedOut ? e.requestId : e instanceof ApiError && e.status >= 500 ? e.requestId : undefined;
  return id ? id.slice(0, 8) : undefined;
}

/**
 * Read something that may legitimately be absent, without turning a FAILURE into an absence.
 *
 * `repos.wallet.delegation()` was written as
 *
 *     (await api.get('/delegation').catch(() => undefined)) ?? null
 *
 * so an unreachable executor produced `null` — the same value the route returns for a wallet that
 * has granted nothing. `/safety` reads exactly that to choose between LIVE and NOT GRANTED, and
 * with the executor down and a live $1,600/day grant on chain it announced "No permission has been
 * granted, so nothing can trade."
 *
 * `useHydrateDelegation` already had a catch for this case, commented "A failed read is not 'no
 * permission'", which could never fire against a function that never threw.
 *
 * `NotSignedIn` was ALSO folded into the absence, on the reasoning that no session means no
 * permission. That is wrong for the same reason the paragraph above is right, and the consequence
 * is identical: a returning user with a live $1,600/day grant on chain, not signed in, was shown
 * "NOT GRANTED · No permission has been granted, so nothing can trade" — the one claim `/safety`
 * must never make. Not being signed in is not an answer about a wallet; it is not having asked.
 *
 * So the only absence left is the route genuinely answering "nothing here". Every error, signed
 * out included, reaches the caller so the screen can say which of the three it is: granted,
 * absent, or unasked.
 *
 * Extracted here for the same reason `errorText` and `pressGuard` were: the part worth testing was
 * the part a test could not reach, because `local.ts` pulls in the whole Expo runtime.
 */
export async function absentOrThrow<T>(read: () => Promise<T | null | undefined>): Promise<T | null> {
  return (await read()) ?? null;
}

/**
 * A decision on a proposal that is not there any more, read as the answer it is.
 *
 * `POST /proposals/:id/decide` answers an id that is not this wallet's proposal — or another account's, which it does
 * not tell apart — with a 404, as the executor answers every resource that is not the caller's, and keeps the thread's
 * sentence in the body: `{ error: 'not_found', status: 'gone', message }`. The chat renders that sentence, so that one
 * answer comes back as a decision. Any other refusal, and a 404 without that body, is still the error it is: a proposal
 * nobody could decide is not a proposal that was decided.
 *
 * Here rather than in `local.ts` for the reason `absentOrThrow` is.
 */
export function goneProposal(e: unknown): { status: 'gone'; message: string } | undefined {
  if (!(e instanceof ApiError) || e.status !== 404) return undefined;
  const body = e.body as { status?: unknown; message?: unknown } | null | undefined;
  if (body?.status !== 'gone' || typeof body.message !== 'string' || !body.message.trim()) return undefined;
  return { status: 'gone', message: body.message };
}
