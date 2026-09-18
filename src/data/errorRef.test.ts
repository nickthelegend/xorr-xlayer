/**
 * The reference shown under a failure worth reporting (FEATURES.md #90).
 *
 * It has to be the beginning of the id the request carried, because that is how the executor's log lines for it begin,
 * and it has to be absent where it would only be noise: a refusal that already says what to change, or a request that
 * was never sent.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, NotSignedIn, TimedOut, errorRef } from './apiError';

const ID = '3fa94c01b2d7e6a51928c4f0e3a';

describe('errorRef', () => {
  it("is the first eight characters of a server error's request id", () => {
    expect(errorRef(new ApiError(502, '502 Bad Gateway', undefined, ID))).toBe('3fa94c01');
  });

  it('is given for a timeout, which may still be running and never answered with an id', () => {
    expect(errorRef(new TimedOut('/orders', 180_000, ID))).toBe('3fa94c01');
  });

  it('is not given for a refusal that says what to change', () => {
    expect(errorRef(new ApiError(409, '409 Conflict', { error: 'daily_cap' }, ID))).toBeUndefined();
    expect(errorRef(new ApiError(404, '404 Not Found', undefined, ID))).toBeUndefined();
  });

  it('is not given where no request reached a log', () => {
    expect(errorRef(new NotSignedIn('/positions'))).toBeUndefined();
    expect(errorRef(new Error('Network request failed'))).toBeUndefined();
    expect(errorRef(new ApiError(500, '500 Internal Server Error'))).toBeUndefined();
  });
});
