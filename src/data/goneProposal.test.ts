/**
 * A decision on a proposal that is not there any more (docs/qa/ENDPOINTS.md E160).
 *
 * The executor answers one with a 404 that keeps the thread's sentence. That answer, and only that answer, is a decision
 * the chat can show: everything else is still the failure it was, so a request that never landed is never reported as
 * decided.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, NotSignedIn, TimedOut, goneProposal } from './apiError';

const GONE = { error: 'not_found', status: 'gone', message: 'That proposal no longer exists.' };

describe('goneProposal', () => {
  it("reads the executor's 404 for a proposal that is not there as the answer it is", () => {
    expect(goneProposal(new ApiError(404, '404 Not Found', GONE))).toEqual({
      status: 'gone',
      message: 'That proposal no longer exists.',
    });
  });

  it('leaves a 404 that is not that answer the error it is', () => {
    expect(goneProposal(new ApiError(404, '404 Not Found', { error: 'not_found' }))).toBeUndefined();
    expect(goneProposal(new ApiError(404, '404 Not Found'))).toBeUndefined();
    expect(goneProposal(new ApiError(404, '404 Not Found', null))).toBeUndefined();
    expect(goneProposal(new ApiError(404, '404 Not Found', { status: 'gone', message: 42 }))).toBeUndefined();
    expect(goneProposal(new ApiError(404, '404 Not Found', { status: 'gone', message: '  ' }))).toBeUndefined();
  });

  it('leaves every other failure the error it is, whatever its body says', () => {
    expect(goneProposal(new ApiError(500, '500 Internal Server Error', GONE))).toBeUndefined();
    expect(goneProposal(new ApiError(409, '409 Conflict', GONE))).toBeUndefined();
    expect(goneProposal(new TimedOut('/proposals/p-1/decide', 30_000))).toBeUndefined();
    expect(goneProposal(new NotSignedIn('/proposals/p-1/decide'))).toBeUndefined();
    expect(goneProposal(new Error('Network request failed'))).toBeUndefined();
  });
});
