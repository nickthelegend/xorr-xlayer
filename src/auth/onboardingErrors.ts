/**
 * What to tell someone when signing in goes wrong.
 *
 * The onboarding screen rendered `e.message` straight from whatever threw. Privy's SDK, viem and
 * our own `api` layer all write for a developer reading a stack trace, and one of them put
 * "Not signed in, so /wallet/connect was not requested." on the first screen of the product —
 * naming an internal endpoint, to a user who had not yet typed anything.
 *
 * A raw message is not always wrong: `apiReason` exists precisely because the executor's own
 * sentence ("No route for USDC -> WETH") beats any substitute a screen could invent. The rule is
 * narrower than "never show the error" — show a stated reason, and translate the ones written for
 * somebody else.
 *
 * Each of these keeps the specific cases a user can act on, and falls back to a sentence that says
 * what failed rather than pretending to know why.
 */
import { ApiError, NotSignedIn, TimedOut, apiReason } from '@/data/apiError';
import { alreadyHasWallet } from './alreadyHasWallet';

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Shared shape: the executor's own words when it wrote any, otherwise the caller's fallback. */
function stated(e: unknown, fallback: string): string {
  if (e instanceof TimedOut) {
    // Never "it failed" — a timed-out request may still be running on the server.
    return 'That is taking longer than expected. It may still be going through, so check before trying again.';
  }
  if (e instanceof NotSignedIn) return 'Your session has not finished loading. Give it a moment.';
  return apiReason(e) ?? fallback;
}

/** Sending the one-time code. */
export function codeFailure(e: unknown): string {
  const m = message(e);
  // The two Privy refusals a user can actually do something about.
  if (/invalid.*email|email.*invalid/i.test(m)) return 'That email address does not look right.';
  if (/rate.?limit|too many/i.test(m)) return 'Too many codes requested. Wait a minute and try again.';
  return stated(e, 'The code could not be sent. Check the address and try again.');
}

/** Verifying it, and creating the wallet that follows. */
export function verifyFailure(e: unknown): string {
  const m = message(e);
  /*
   * "You already have a wallet" is not a failure — the postcondition the caller wanted already
   * held. `alreadyHasWallet` matches both SDKs' wordings; see its own note.
   */
  if (alreadyHasWallet(e)) return '';
  if (/invalid.*code|code.*invalid|incorrect/i.test(m)) return 'That code is not right. Check it and try again.';
  if (/expired/i.test(m)) return 'That code has expired. Ask for a new one.';
  return stated(e, 'That did not go through. Ask for a new code and try again.');
}

/**
 * Signing in with Google, X or a wallet (2026-09-16).
 *
 * Backing out of the provider's sheet is the commonest outcome of all and is not a failure: it answers '', as
 * `verifyFailure` does for a wallet that already exists. A method the Privy dashboard has not switched on is the one
 * refusal nobody can act on from here, so it says which method, plainly, instead of quoting the SDK.
 */
export function oauthFailure(e: unknown, method: string): string {
  const m = message(e);
  if (/cancel|dismiss|abort|closed|user (rejected|denied)/i.test(m)) return '';
  if (/not (enabled|configured|allowed)|disabled|unsupported|unknown provider|invalid.?app/i.test(m)) {
    return `${method} sign-in is not switched on for this app yet. Use an email code for now.`;
  }
  return stated(e, `Signing in with ${method} did not go through. Try again, or use an email code.`);
}

/** Registering the address with the executor. */
export function connectFailure(e: unknown): string {
  if (e instanceof ApiError && e.status >= 500) {
    // Nothing retries on its own: the screen's Try again is the retry, so the sentence points at it.
    return 'We could not reach xorr just now. Your wallet is fine. Try again in a moment.';
  }
  return stated(e, 'Your wallet could not be registered with the executor.');
}
