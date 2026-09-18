/**
 * Telling a stale token from a finished session.
 *
 * A 401 used to reach every screen as `ApiError(401, "401 Unauthorized")` — a raw status code
 * rendered as a failure, on every list at once, for something that is not a fault. The reader saw
 * an app that had broken rather than a session that had ended.
 *
 * The property worth defending here is the negative one: the app must not declare a session over
 * on weak evidence. Signing someone out because their phone lost signal for a second is a worse
 * failure than the one this replaces.
 */
import { describe, expect, it } from 'vitest';
import { MAX_REAUTH_ATTEMPTS, SessionExpired, sessionVerdict, shouldRetryWithToken } from './expiry';

describe('whether to retry a 401', () => {
  it('retries once with a genuinely new token', () => {
    expect(shouldRetryWithToken({ attempt: 0, previous: 'old', fresh: 'new' })).toBe(true);
  });

  it('never retries twice', () => {
    // A second retry is a loop, and a loop against an auth endpoint is how an app locks itself out.
    expect(shouldRetryWithToken({ attempt: 1, previous: 'old', fresh: 'newer' })).toBe(false);
    expect(MAX_REAUTH_ATTEMPTS).toBe(1);
  });

  it('does not retry with the same token', () => {
    // Asking the same rejected question again turns one refusal into two and delays the honest
    // answer by a round trip.
    expect(shouldRetryWithToken({ attempt: 0, previous: 'same', fresh: 'same' })).toBe(false);
  });

  it('does not retry with no token at all', () => {
    expect(shouldRetryWithToken({ attempt: 0, previous: 'old', fresh: null })).toBe(false);
  });

  it('retries when there was no token before and there is one now', () => {
    // The first request of a freshly restored session, which raced Privy and went out bare.
    expect(shouldRetryWithToken({ attempt: 0, previous: null, fresh: 'new' })).toBe(true);
  });
});

describe('concluding that a session is over', () => {
  it('says so when a 401 survived a retry with a fresh token', () => {
    // The only evidence that actually supports the claim: Privy minted a token and the executor
    // still refused it.
    expect(sessionVerdict({ retried: true, fresh: 'new' })).toBe('over');
  });

  it('refuses to say so when no fresh token could be got', () => {
    /*
     * "Expired" and "Privy could not be reached to refresh it" are indistinguishable without one.
     * Declaring the session over here would sign someone out for a moment of bad signal.
     */
    expect(sessionVerdict({ retried: true, fresh: null })).toBe('inconclusive');
    expect(sessionVerdict({ retried: false, fresh: null })).toBe('inconclusive');
  });

  it('refuses to say so when no retry was made', () => {
    expect(sessionVerdict({ retried: false, fresh: 'new' })).toBe('inconclusive');
  });
});

describe('the error a screen receives', () => {
  it('names what was not loaded and what to do about it', () => {
    const e = new SessionExpired('/positions');
    expect(e.message).toContain('/positions');
    expect(e.message).toMatch(/sign in again/i);
  });

  it('is its own class, so nothing has to match a status line', () => {
    const e = new SessionExpired('/wallet');
    expect(e.name).toBe('SessionExpired');
    expect(e).toBeInstanceOf(SessionExpired);
    expect(e).toBeInstanceOf(Error);
  });

  it('does not read as a fault', () => {
    // A session ending is not the app breaking, and the sentence must not suggest it is.
    const e = new SessionExpired('/positions');
    expect(e.message).not.toMatch(/error|failed|unauthorized|401/i);
  });
});
