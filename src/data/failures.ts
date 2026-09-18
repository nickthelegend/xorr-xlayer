/**
 * Every way a request can fail, as a table.
 *
 * `errorText` did the one thing it could do without knowing anything: hand back whatever sentence the body
 * carried, and where there was none, `The executor answered 502.` or `Something went wrong.` Both of those
 * are honest and neither is useful. They tell a person nothing about whether to wait, to change the amount,
 * to grant a permission, or to check Activity before touching the button again — and those are four
 * completely different next actions behind what looked like one error.
 *
 * So a failure is classified, not just printed. The classification decides three things the screen cannot
 * work out from prose:
 *
 *   - **Retry.** A 429 and a 503-warming both mean "not now", and the executor says WHEN in `retry-after`.
 *     A 400 means "not like that", and a button that repeats it unchanged is a trap.
 *   - **The fix.** A missing permission is fixed on the Safety screen, a spent cap on Limits, a chain that
 *     cannot settle on Networks. A sentence naming a problem with no route to its fix is half an error.
 *   - **Whether anything happened.** A timeout, a 5xx after a broadcast and the executor's own
 *     `request_outcome_unknown` all mean the transaction may have gone through. Those must never read as
 *     "it failed", because the next thing the user does is press the button again.
 *
 * ## The table is keyed on what the executor actually sends
 *
 * Every `error` code below was taken from `server/src` — `warming` from `http/errors.ts`, `rate_limited`
 * from `http/rate-limit.ts`, `request_in_flight` and `request_outcome_unknown` from `http/idempotency.ts`,
 * the blocked reasons from `executor/order.ts`. This is not a vocabulary invented for the app; it is the
 * one the server already speaks, read at the one place that has to understand it.
 *
 * ## What it does NOT do
 *
 * It does not replace the server's sentence. Where the body carried prose — the policy engine's own
 * wording, `humanFailure`'s translation of a revert — that prose is the message, and the table supplies
 * only the kind, the retry and the fix around it. A generic sentence written here that overwrote "today's
 * cap is used up" would be a downgrade dressed as a feature.
 */
import type { Href } from 'expo-router';
import { ApiError, NotSignedIn, TimedOut, apiProse, apiReason, errorRef } from './apiError';
import { SessionExpired } from '@/auth/expiry';

/**
 * What KIND of failure this is — what the screen has to do about it, not where it came from.
 *
 * Deliberately coarser than the executor's error codes: `quoter_unavailable`, `price_unavailable` and
 * `subgraph_unavailable` are one situation to a person (a source we depend on is not answering) and three
 * to a server.
 */
export type FailureKind =
  /** Nothing left the device. */
  | 'offline'
  /** Sent, never answered. The outcome is unknown, which is not the same as failed. */
  | 'timeout'
  /** No session. Not a failure — nothing was asked. */
  | 'signed-out'
  /** The limiter, ours or an upstream's. Comes with a `retry-after`. */
  | 'throttled'
  /** A source the executor depends on is down or still filling. Seconds away, or not. */
  | 'source-unavailable'
  /** The chain itself could not be read. */
  | 'chain-unreadable'
  /** The network was busy enough that the transaction did not land. */
  | 'congested'
  /** Not enough money for what was asked. */
  | 'insufficient-balance'
  /** The permission the bot trades under is missing, revoked or expired. */
  | 'no-permission'
  /** The permission exists and this would exceed it. */
  | 'cap-spent'
  /** The chain, venue or route refused the transaction. A real answer, not a failure to get one. */
  | 'rejected'
  /** This exact request is already running, or already ran. */
  | 'duplicate'
  /** It was sent, something was broadcast, and nobody knows what became of it. */
  | 'outcome-unknown'
  /** The request itself was wrong. Repeating it unchanged answers the same way. */
  | 'bad-request'
  /** Nothing here by that name. */
  | 'not-found'
  /** Ours. A reference is worth showing. */
  | 'server-fault'
  /** Classified as far as it can be: the answer carried a sentence and nothing else to key on. */
  | 'refused';

/** Where a failure is fixed, for the screens that can offer it. */
export type FailureFix = { label: string; href: Extract<Href, string> };

export type Failure = {
  kind: FailureKind;
  /** The sentence to show. The server's own where it wrote one, this table's where it did not. */
  message: string;
  /** Would sending the identical request again be worth offering? */
  retryable: boolean;
  /** When, in seconds, where the answer said. */
  retryAfterSec?: number;
  /** The screen that fixes this, where one does. */
  fix?: FailureFix;
  /** The first eight characters of the request id, for a failure worth reporting. */
  ref?: string;
  /**
   * True where the request may have acted despite failing. The one property that must never be lost: it is
   * the difference between "try again" and "check Activity first", and between one trade and two.
   */
  outcomeUnknown: boolean;
};

type Rule = {
  kind: FailureKind;
  /** The sentence, where the answer carried none of its own. */
  fallback: string;
  retryable: boolean;
  fix?: FailureFix;
  outcomeUnknown?: boolean;
};

/**
 * By the executor's own `error` code, which is the most specific thing an answer carries.
 *
 * A code here is one the server sends today. Where it stops sending one, the status table below still
 * classifies it — a code disappearing degrades the fix, never the correctness.
 */
const BY_CODE: Record<string, Rule> = {
  /* Not now, and the answer says when. */
  rate_limited: {
    kind: 'throttled',
    fallback: 'Too many requests at once. This eases off on its own.',
    retryable: true,
  },
  warming: {
    // Never a zero and never a failure: the data is seconds away and the fetch behind it is still running.
    kind: 'source-unavailable',
    fallback: 'Still reading this for the first time. It will be here in a moment.',
    retryable: true,
  },
  busy: { kind: 'throttled', fallback: 'The executor is working through a queue. Try again shortly.', retryable: true },

  /* A source we depend on. Three codes, one situation. */
  subgraph_unavailable: { kind: 'source-unavailable', fallback: 'The index behind this did not answer.', retryable: true },
  quoter_unavailable: { kind: 'source-unavailable', fallback: 'No venue would quote this right now.', retryable: true },
  quoter_refused: { kind: 'rejected', fallback: 'No venue would quote this route.', retryable: false },
  quote_unusable: { kind: 'rejected', fallback: 'The quote that came back could not be used.', retryable: false },
  price_unavailable: { kind: 'source-unavailable', fallback: 'Nothing prices this right now.', retryable: true },
  rate_unavailable: { kind: 'source-unavailable', fallback: 'No rate could be read right now.', retryable: true },
  no_feed: { kind: 'source-unavailable', fallback: 'No price feed answered for this.', retryable: true },
  privy_unavailable: { kind: 'source-unavailable', fallback: 'Sign-in could not be checked right now.', retryable: true },
  privy_undecided: { kind: 'source-unavailable', fallback: 'Sign-in could not be checked right now.', retryable: true },

  /* The chain. */
  chain_read_failed: { kind: 'chain-unreadable', fallback: 'The chain did not answer.', retryable: true },
  needs_gas: {
    kind: 'congested',
    fallback: 'The agent has no gas money on this network, so nothing was sent. Your funds are untouched.',
    retryable: false,
    fix: { label: 'How this works', href: '/system' },
  },

  /* Permission, and its edges. Each has a screen that fixes it. */
  no_delegation: {
    kind: 'no-permission',
    fallback: 'No trading permission is granted, so nothing can be placed.',
    retryable: false,
    fix: { label: 'Grant permission', href: '/safety' },
  },
  delegation_expired: {
    kind: 'no-permission',
    fallback: 'The trading permission has expired.',
    retryable: false,
    fix: { label: 'Renew permission', href: '/safety' },
  },
  over_cap: {
    kind: 'cap-spent',
    fallback: 'This would go past your cap.',
    retryable: false,
    fix: { label: 'See your limits', href: '/limits' },
  },
  refused_by_policy: {
    kind: 'cap-spent',
    fallback: 'Your policy refused this.',
    retryable: false,
    fix: { label: 'See your limits', href: '/limits' },
  },
  policy_signed_transfer: { kind: 'rejected', fallback: 'That is not something the permission allows.', retryable: false },

  /* Where a trade cannot settle at all. Permanent for this deployment, so no retry — a fix, or nothing. */
  not_tradable: {
    kind: 'rejected',
    fallback: 'This cannot be settled here.',
    retryable: false,
    fix: { label: 'See other networks', href: '/networks' },
  },
  not_settleable_here: {
    kind: 'rejected',
    fallback: 'This cannot be settled here.',
    retryable: false,
    fix: { label: 'See other networks', href: '/networks' },
  },
  real_money: { kind: 'rejected', fallback: 'That is not allowed with real money.', retryable: false },

  /* Idempotency. The two that decide whether the button may be pressed again. */
  request_in_flight: {
    kind: 'duplicate',
    fallback: 'This is already going through. Give it a moment rather than sending it twice.',
    retryable: false,
    // Nothing new happened, and the first attempt has not answered: its outcome is not known yet.
    outcomeUnknown: true,
  },
  request_outcome_unknown: {
    kind: 'outcome-unknown',
    fallback:
      'An earlier attempt sent a transaction and stopped without answering, so it may have gone through. ' +
      'Check Activity before trying again.',
    retryable: false,
    fix: { label: 'Check Activity', href: '/activity' },
    outcomeUnknown: true,
  },
  idempotency_key_reused: {
    kind: 'bad-request',
    fallback: 'That request was already used for something else.',
    retryable: false,
  },

  /* The request, and the account. */
  invalid_request: { kind: 'bad-request', fallback: 'That request was not one the executor could read.', retryable: false },
  invalid_json: { kind: 'bad-request', fallback: 'That request was not one the executor could read.', retryable: false },
  invalid_amount: { kind: 'bad-request', fallback: 'That amount is not one the executor can use.', retryable: false },
  invalid_usd: { kind: 'bad-request', fallback: 'That amount is not one the executor can use.', retryable: false },
  unauthorized: { kind: 'signed-out', fallback: 'This needs you to be signed in.', retryable: false },
  no_wallet: {
    kind: 'bad-request',
    fallback: 'This account has no wallet yet.',
    retryable: false,
    fix: { label: 'Set up your wallet', href: '/wallet' },
  },
  not_found: { kind: 'not-found', fallback: 'There is nothing here by that name.', retryable: false },
};

/**
 * By HTTP status, for an answer that named no code we know.
 *
 * Coarse on purpose. This is the floor under the table above, and a floor that guesses is worse than one
 * that says the little it is sure of.
 */
function byStatus(status: number): Rule {
  if (status === 401 || status === 403) return { kind: 'signed-out', fallback: 'This needs you to be signed in.', retryable: false };
  if (status === 404) return { kind: 'not-found', fallback: 'There is nothing here by that name.', retryable: false };
  if (status === 408) return { kind: 'timeout', fallback: 'The executor did not answer in time.', retryable: true, outcomeUnknown: true };
  if (status === 429) return { kind: 'throttled', fallback: 'Too many requests at once. This eases off on its own.', retryable: true };
  if (status === 409) return { kind: 'refused', fallback: 'The executor refused this.', retryable: false };
  if (status >= 400 && status < 500) return { kind: 'bad-request', fallback: 'That request was not one the executor could read.', retryable: false };
  if (status === 503) return { kind: 'source-unavailable', fallback: 'The executor is not answering this right now.', retryable: true };
  /*
   * A 5xx keeps the outcome unknown, and that is not pedantry.
   *
   * A proxy in front of an executor that is still working answers 502, and `server/src/http/idempotency.ts`
   * stores rather than releases a key whose request had already broadcast — because that request may have
   * moved money. The app has to say the same thing.
   */
  return { kind: 'server-fault', fallback: 'The executor failed on this one.', retryable: true, outcomeUnknown: true };
}

/**
 * Failures with no status at all — the ones `fetch` throws.
 *
 * React Native's is `Network request failed`; the web's is `Failed to fetch`; Node's is `fetch failed`. Three
 * runtimes, one situation, and none of those three sentences belongs on screen.
 */
const TRANSPORT = /network request failed|failed to fetch|fetch failed|networkerror|econnrefused|econnreset|enotfound|socket hang up/i;

/** What the chain says when it is busy rather than refusing. Read off the message, since no code carries it. */
const CONGESTED = /fee too low|underpriced|replacement transaction|max fee per gas|congest|nonce too low/i;

/** And what it says when it has refused. */
const REJECTED = /reverted|execution reverted|rejected|user denied|slippage|returnamount/i;

export function classify(e: unknown): Failure {
  /*
   * Signed out first: it is not a failure, and every other branch would report it as one. `api.ts` throws it
   * INSTEAD of sending a request it knows will be refused, so nothing about it is a fault.
   */
  if (e instanceof NotSignedIn) {
    return { kind: 'signed-out', message: e.message, retryable: false, outcomeUnknown: false };
  }

  /*
   * A session that ended while the app was open, which is the same KIND as being signed out and a
   * different event: nothing was wrong, the app was working a moment ago, and the reader is owed
   * that distinction rather than "This needs you to be signed in" appearing on a screen they were
   * already using.
   *
   * `api.ts` raises this only after a 401 survived a retry with a token Privy had just minted, so
   * by the time it reaches here the claim has been earned.
   */
  if (e instanceof SessionExpired) {
    return {
      kind: 'signed-out',
      message: e.message,
      // Repeating it answers the same way until they sign in. The fix is the route, not the retry.
      retryable: false,
      fix: { label: 'Sign in', href: '/' },
      outcomeUnknown: false,
    };
  }

  if (e instanceof TimedOut) {
    return {
      kind: 'timeout',
      // Its own sentence already says the one thing that matters: it may still be running.
      message: e.message,
      retryable: true,
      ref: errorRef(e),
      fix: { label: 'Check Activity', href: '/activity' },
      outcomeUnknown: true,
    };
  }

  if (e instanceof ApiError) {
    const code = codeOf(e);
    const known = code !== undefined ? BY_CODE[code] : undefined;
    const rule = known ?? byStatus(e.status);
    return {
      kind: rule.kind,
      /*
       * The server's PROSE wins — it is more specific than anything this table could say.
       *
       * Where there is none, which sentence to fall back to depends on whether the code is one this table
       * knows. For a known code the table's own sentence is better than the identifier: `no_delegation` is
       * not something to show a person. For an unknown one the identifier is all there is, and showing it is
       * how the next missing sentence gets noticed instead of disappearing behind a generic line.
       */
      message: apiProse(e) ?? (known ? rule.fallback : (apiReason(e) ?? rule.fallback)),
      retryable: rule.retryable,
      retryAfterSec: e.retryAfterSec,
      fix: rule.fix,
      ref: errorRef(e),
      outcomeUnknown: rule.outcomeUnknown ?? false,
    };
  }

  const message = e instanceof Error ? e.message : String(e ?? '');
  if (TRANSPORT.test(message)) {
    return {
      kind: 'offline',
      message: 'Can’t reach xorr. Your funds and your permission are on chain and unaffected.',
      retryable: true,
      // Nothing left the device, so nothing can have happened.
      outcomeUnknown: false,
    };
  }
  if (CONGESTED.test(message)) {
    return {
      kind: 'congested',
      message: 'The network was busy and this did not land. Nothing was placed.',
      retryable: true,
      outcomeUnknown: false,
    };
  }
  if (REJECTED.test(message)) {
    return {
      kind: 'rejected',
      // The revert's own translated sentence, where one reached here: `humanFailure` already wrote it.
      message,
      retryable: false,
      outcomeUnknown: false,
    };
  }

  /*
   * Everything left. Not "Something went wrong": an error with a message keeps it, because a sentence written
   * by whatever threw is more use than one written here for a case nobody has seen.
   */
  return {
    kind: 'server-fault',
    message: message || 'The executor failed on this one.',
    retryable: true,
    outcomeUnknown: false,
  };
}

/** The `error` field of a refusal body, where it is a string. */
function codeOf(e: ApiError): string | undefined {
  const body = e.body as { error?: unknown; reason?: unknown; status?: unknown } | null | undefined;
  for (const field of [body?.error, body?.reason]) {
    /*
     * `errorResponse` puts the thrown message in `error` for an unhandled 500, so that field is a code only
     * where it looks like one: lower case, words joined by underscores. `"Cannot read properties of
     * undefined"` must not be looked up as though it were `refused_by_policy`.
     */
    if (typeof field === 'string' && /^[a-z][a-z0-9_]*$/.test(field)) return field;
  }
  return undefined;
}

/**
 * How long the executor asked for, said as a person would say it.
 *
 * Rounded, and never a live countdown. A number ticking down invites watching it, and `retry-after` is the
 * limiter's window rather than a promise about the second after it — being precise about it would be being
 * precise about the wrong thing.
 */
export function waitSentence(seconds: number): string {
  if (seconds <= 5) return 'Try again in a moment.';
  if (seconds < 60) return `Try again in about ${Math.ceil(seconds / 5) * 5} seconds.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in about ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`;
}
