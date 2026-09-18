/**
 * A refusal usually carries a sentence, and the screens were printing over it.
 *
 * The swap ticket rendered "No route available" on top of the executor's own "No route for USDC ->
 * WETH", and on top of whatever 1inch said when 1inch was the one refusing. A user who can see
 * which pair failed knows to change something; a user who cannot just taps again.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, apiReason } from './apiError';

describe('the server’s own words survive to the screen', () => {
  it('prefers `message`, which is the sentence written for a person', () => {
    const e = new ApiError(409, '409 Conflict', {
      error: 'daily_cap_spent',
      message: 'The daily cap is spent. Nothing was placed.',
    });
    expect(apiReason(e)).toBe('The daily cap is spent. Nothing was placed.');
  });

  it('falls back to `error` when that is all there is', () => {
    // Exactly what /swap/quote returns on a 502.
    const e = new ApiError(502, '502 Bad Gateway', { error: 'No route for USDC -> WETH' });
    expect(apiReason(e)).toBe('No route for USDC -> WETH');
  });

  it('has nothing to say about a bare transport failure', () => {
    // An HTTP status is not a sentence, so the caller picks its own wording.
    expect(apiReason(new ApiError(500, '500 Internal Server Error'))).toBeUndefined();
    expect(apiReason(new ApiError(502, '502', { error: '   ' }))).toBeUndefined();
    expect(apiReason(new ApiError(502, '502', { error: 42 }))).toBeUndefined();
    expect(apiReason(new Error('Failed to fetch'))).toBeUndefined();
    expect(apiReason(undefined)).toBeUndefined();
  });
});
