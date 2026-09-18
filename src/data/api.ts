/**
 * The executor API client. The ONLY place in the client that talks to our own server.
 *
 * Base URL comes from EXPO_PUBLIC_API_URL so a device build can point at a deployed executor;
 * it defaults to the local dev server.
 */
import { accessToken } from '@/auth/token';
import { isPublicPath } from './publicPaths';
import { authKnowledge, setAuthKnowledge, whenAuthKnown } from '@/auth/authState';
import { SessionExpired, sessionVerdict, shouldRetryWithToken } from '@/auth/expiry';
import { noteSessionEnded } from '@/auth/reauth';
import { API_BASE } from './apiBase';
import { ApiError, NotSignedIn, TimedOut, markReplayed, retryAfterSeconds } from './apiError';
import { noteRateLimited } from '@/net/throttleStore';
import { keyHeaders, type Keyed } from './intentKey';
/*
 * Re-exported, not redefined.
 *
 * These moved to `apiError.ts` so an error can be constructed without pulling in the transport's
 * dependencies — `api.ts` reaches for the Privy token getter, which reaches for expo, so
 * `new NotSignedIn(...)` in a node test dragged in a native module and failed to import. An error
 * type should not need a network stack to exist. Callers still import them from here.
 */
export { NotSignedIn, TimedOut } from './apiError';

export { API_BASE };
export { ApiError, apiReason, REPLAYED, markReplayed, wasReplayed } from './apiError';

/**
 * Every request carries the Privy access token. The executor rejects anything without one, so a
 * missing token is a bug worth surfacing rather than a request worth sending.
 */
async function authHeaders(): Promise<Record<string, string>> {
  const token = await accessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Reads are bounded tighter than writes because they are retried by simply looking again.
 *
 * Both are generous on purpose. This executor settles on a mainnet fork, and its slow calls are
 * genuinely slow: `/positions` has been measured at 31s cold and a swap has to quote, build,
 * simulate, broadcast and wait for a receipt. A bound that fires on a call that would have
 * succeeded turns a slow product into a broken one, which is the worse trade.
 */
const READ_TIMEOUT_MS = 45_000;
/*
 * Deliberately above the slowest write this executor has actually produced — a `POST /orders`
 * measured at 153s while 1inch's lane was congested. A write that gives up EARLIER than the server
 * answers is worse than no bound at all: the trade may well have executed, and a screen that says
 * "did not answer" invites a retry that spends twice. Hence the ceiling, and hence the wording of
 * the error, which never claims nothing happened.
 */
const WRITE_TIMEOUT_MS = 180_000;

/**
 * An id for one request (FEATURES.md #90), sent as `x-request-id`.
 *
 * The executor adopts a well-formed id instead of minting its own (`server/src/http/request-id.ts`) and begins every
 * log line for the request with its first eight characters. So the reference a screen shows under a failure finds the
 * request in the logs — including a timed-out one, which never gets an answer to read an id from. Random hex first, so
 * those eight characters differ from one request to the next. It is a label, not a secret or a token.
 */
function newRequestId(): string {
  const random = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${random}${Date.now().toString(16)}`;
}

/**
 * Run `op` under a deadline, aborting the in-flight fetch when it passes.
 *
 * The deadline covers the WHOLE operation, not just the fetch: `whenAuthKnown()` and the Privy
 * token both sit in front of the request and either can stall, and a hang there looks identical
 * from the screen.
 */
async function withDeadline<T>(
  path: string,
  ms: number,
  requestId: string,
  op: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new TimedOut(path, ms, requestId));
    }, ms);
  });
  try {
    return await Promise.race([op(ctrl.signal), expired]);
  } catch (e) {
    // An abort we caused is the deadline, not a network fault, and it must read as one.
    if (e instanceof Error && e.name === 'AbortError') throw new TimedOut(path, ms, requestId);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const timeoutMs = init?.method && init.method !== 'GET' ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
  const requestId = newRequestId();
  return withDeadline(path, timeoutMs, requestId, (signal) => send<T>(path, signal, requestId, init));
}

async function send<T>(
  path: string,
  signal: AbortSignal,
  requestId: string,
  init?: RequestInit,
  /**
   * How many times this request has already been retried after a 401.
   *
   * A Privy access token is short-lived, and an expired one is not a fault — the session is
   * usually still good and Privy will mint a new token on ask. Retrying once turns a routine
   * expiry into something the user never sees.
   *
   * Safe for a write as much as a read, and only because of where the refusal comes from:
   * `authMiddleware` runs before any handler, so a 401 means the request was rejected before it
   * could do anything at all. Nothing was placed, so nothing can be placed twice.
   */
  reauthAttempt = 0,
): Promise<T> {
  /*
   * Do not ask a question we KNOW we cannot answer — and only then.
   *
   * Every authenticated call used to fire regardless of whether a token existed, so a signed-out
   * load of the home screen produced a 401 for `/wallet/balance`, `/agents` and `/positions`:
   * three real console errors on the first screen a new user sees.
   *
   * The first version of this skipped whenever `accessToken()` was falsy, which was a worse bug:
   * on a freshly established session the token is briefly unavailable, so reads fired in that
   * window were dropped silently and the screen kept its empty state for good. While the answer is
   * unknown the request goes out — a 401 is visible and recoverable; silence is neither.
   */
  if (!isPublicPath(path)) {
    // While the answer is unknown, wait for it rather than sending a request that cannot carry a
    // token. See `whenAuthKnown` for why an un-retried 401 was worse than a short wait.
    const know = authKnowledge() === 'unknown' ? await whenAuthKnown() : authKnowledge();
    if (know === 'signed-out') throw new NotSignedIn(path);
  }

  const token = await accessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-request-id': requestId,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  /*
   * A 401: is the token merely stale, or is the session over?
   *
   * Until now both arrived at every screen as `ApiError(401, "401 Unauthorized")` — a raw status
   * code drawn as a failure, on every list at once, for something that is not a fault. Asking
   * Privy for a token tells the two apart, and it costs one round trip.
   */
  if (res.status === 401 && !isPublicPath(path)) {
    const fresh = await accessToken();
    if (shouldRetryWithToken({ attempt: reauthAttempt, previous: token, fresh })) {
      return send<T>(path, signal, requestId, init, reauthAttempt + 1);
    }
    if (sessionVerdict({ retried: reauthAttempt > 0, fresh }) === 'over') {
      /*
       * Said once, here, rather than fifteen times on fifteen screens.
       *
       * Marking the app signed out also stops every other authenticated read from going out to be
       * refused — `send` refuses to ask a question it knows it cannot answer.
       */
      setAuthKnowledge('signed-out');
      /*
       * Recorded once for the whole app, not left to each screen.
       *
       * Six mounted screens make six reads, so six of them would report the same sentence — and
       * none of them can act on it, because the fix is signing in rather than anything on that
       * screen. The screens keep their own error; the prompt is drawn in one place.
       */
      noteSessionEnded();
      throw new SessionExpired(path);
    }
    /*
     * Inconclusive: no fresh token, so "expired" and "Privy could not be reached" are
     * indistinguishable. Falls through to the ordinary error below rather than signing someone out
     * for a moment of bad signal.
     */
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // A refusal often carries a REASON — the policy engine's own sentence, the one the user
    // should read. Parse it here so a caller does not have to re-parse an error message.
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    // Both headers are on the CORS expose list (`server/src/index.ts`), so they are readable from the app.
    const retryAfterSec = retryAfterSeconds(res.headers.get('retry-after'));
    /*
     * A 429 is not one screen's problem.
     *
     * Every screen that reads a market polls, so walking into the limiter fails all of them at once, and
     * each one rendering its own "that did not load" composes into "the app is broken" — a much worse
     * description of a sixty-second window than the truth. Recorded here, where every request passes, so
     * one banner can say it once (`net/throttle.ts`).
     */
    if (res.status === 429) noteRateLimited(retryAfterSec);
    throw new ApiError(
      res.status,
      `${res.status} ${res.statusText}${text ? `: ${text}` : ''}`,
      parsed,
      requestId,
      retryAfterSec,
      res.headers.get('idempotent-replay') === 'true',
    );
  }
  /*
   * A replayed success is still a success, and the screen has to be able to tell the two apart: the executor
   * answered this key once already, so nothing happened a second time. Carried as a property on the parsed
   * body rather than thrown, because nothing went wrong.
   */
  return markReplayed((await res.json()) as T, res.headers.get('idempotent-replay') === 'true');
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  /**
   * `write` carries a money action's `Idempotency-Key` (FEATURES.md #29): the executor runs a keyed write once and answers
   * a repeat of it with what the first did. When a key is made, kept and dropped is `intentKey.ts`.
   */
  post: <T,>(path: string, body: unknown, write?: Keyed) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body), headers: keyHeaders(write) }),
  patch: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  /** For a write that REPLACES a whole resource — a saved order, not a change to one. */
  put: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T,>(path: string) => request<T>(path, { method: 'DELETE' }),
  async getText(path: string): Promise<string> {
    // Waits for the session as `request` does: on a cold start the answer is briefly unknown, and a file asked for in that
    // window went out without a token and came back 401 — an export that failed for nothing.
    if (!isPublicPath(path)) {
      const know = authKnowledge() === 'unknown' ? await whenAuthKnown() : authKnowledge();
      if (know === 'signed-out') throw new NotSignedIn(path);
    }
    const requestId = newRequestId();
    return withDeadline(path, READ_TIMEOUT_MS, requestId, async (signal) => {
      const res = await fetch(`${API_BASE}${path}`, {
        signal,
        headers: { 'x-request-id': requestId, ...(await authHeaders()) },
      });
      if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`, undefined, requestId);
      return res.text();
    });
  },
};
