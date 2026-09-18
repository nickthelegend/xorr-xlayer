/**
 * What a user is shown when a request fails, and whether they are invited to repeat it.
 *
 * Both of these were found on screen rather than in a test: /oracle/WETH rendered
 * `404 Not Found: {"error":"WETH is not a tokenized equity"}` — the raw wire body, braces and all
 * — under a "Try again" button for a fact that will never change.
 */
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  NotSignedIn,
  TimedOut,
  absentOrThrow,
  apiReason,
  errorText,
  isRetryable,
} from './apiError';

const wire = (status: number, body: unknown, text = JSON.stringify(body)) =>
  new ApiError(status, `${status} Not Found: ${text}`, body);

describe('errorText', () => {
  it('prefers the sentence the server wrote over the wire form', () => {
    const e = wire(404, { error: 'WETH is not a tokenized equity' });
    expect(errorText(e)).toBe('WETH is not a tokenized equity');
    // The raw form is still on the error for logs — it is only kept off the screen.
    expect(e.message).toContain('{"error"');
  });

  it('prefers `message` over `error` when the body carries both', () => {
    expect(errorText(wire(409, { error: 'cap_spent', message: 'The daily cap is spent.' }))).toBe(
      'The daily cap is spent.',
    );
  });

  it('never renders braces when the body has no prose', () => {
    expect(errorText(wire(500, { detail: { nested: true } }))).toBe('The executor answered 500.');
  });

  it('leaves the errors that write their own sentence alone', () => {
    expect(errorText(new TimedOut('/orders', 20_000))).toContain('did not answer within 20s');
    expect(errorText(new NotSignedIn('/wallet/balance'))).toContain('Not signed in');
  });

  it('has something to say about a value that is not an Error at all', () => {
    expect(errorText(undefined)).toBe('Something went wrong.');
    expect(errorText(new Error(''))).toBe('Something went wrong.');
  });
});

describe('isRetryable', () => {
  it('does not invite a retry of a request the server has already refused on its merits', () => {
    expect(isRetryable(wire(404, { error: 'not a tokenized equity' }))).toBe(false);
    expect(isRetryable(wire(400, { error: 'bad symbol' }))).toBe(false);
    expect(isRetryable(wire(409, { error: 'cap_spent' }))).toBe(false);
  });

  it('does invite one where the server said "not now"', () => {
    expect(isRetryable(wire(408, {}))).toBe(true);
    expect(isRetryable(wire(429, {}))).toBe(true);
  });

  it('does invite one when the failure was the server or the transport', () => {
    expect(isRetryable(wire(500, {}))).toBe(true);
    expect(isRetryable(wire(503, {}))).toBe(true);
    expect(isRetryable(new TimedOut('/orders', 20_000))).toBe(true);
    expect(isRetryable(new Error('Network request failed'))).toBe(true);
  });
});

/*
 * A read that failed is not a thing that is absent.
 *
 * `repos.wallet.delegation()` returned `null` on any failure — the same value the route returns
 * for a wallet that has granted nothing — so `/safety` announced "No permission has been granted"
 * with a live $1,600/day grant on chain and the executor merely unreachable.
 */
describe('absentOrThrow', () => {
  it('passes a value straight through', async () => {
    await expect(absentOrThrow(async () => ({ cap: 1600 }))).resolves.toEqual({ cap: 1600 });
  });

  it('treats a genuine null as an absence', async () => {
    await expect(absentOrThrow(async () => null)).resolves.toBeNull();
    await expect(absentOrThrow(async () => undefined)).resolves.toBeNull();
  });

  /*
   * The case this got wrong. Folding "signed out" into "absent" made `/safety` tell a signed-out
   * visitor that no permission had been granted — about a wallet it had never asked about, and to
   * someone who may hold a live grant on chain.
   */
  it('does not call being signed out an absence — it is not having asked', async () => {
    await expect(
      absentOrThrow(async () => {
        throw new NotSignedIn('/delegation');
      }),
    ).rejects.toBeInstanceOf(NotSignedIn);
  });

  it('rethrows a transport failure instead of calling it an absence', async () => {
    let threw: unknown;
    try {
      await absentOrThrow(async () => {
        throw new TypeError('Failed to fetch');
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(TypeError);
  });

  it('rethrows a server error instead of calling it an absence', async () => {
    let threw: unknown;
    try {
      await absentOrThrow(async () => {
        throw new ApiError(500, 'boom', { error: 'server_error' });
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ApiError);
  });
});

/*
 * The server writes its sentence in `detail` far more often than in `message`, and `apiReason`
 * looked at `message` and `error` only. So the single word **unauthorized** reached the user with
 * "Missing bearer token." unread in the next field, and a rejected order read **invalid_request**.
 */
describe('apiReason prefers the sentence over the identifier', () => {
  const err = (body: unknown) => new ApiError(400, 'x', body);

  it('reads the sentence out of `detail`', () => {
    expect(apiReason(err({ error: 'unauthorized', detail: 'Missing bearer token.' }))).toBe(
      'Missing bearer token.',
    );
    expect(
      apiReason(err({ error: 'invalid_request', detail: 'usd: Too small: expected number to be >0' })),
    ).toContain('Too small');
  });

  it('still reads `message`, and prefers it when both are present', () => {
    expect(apiReason(err({ error: 'duplicate_alert', message: 'You already have this alert.' }))).toBe(
      'You already have this alert.',
    );
    expect(apiReason(err({ message: 'first', detail: 'second' }))).toBe('first');
  });

  it('falls back to the identifier when there is no prose at all', () => {
    // Deliberately surfaced rather than hidden: a screen showing `no_route` is a screen that still
    // needs a sentence written for it, and burying it makes that invisible.
    expect(apiReason(err({ error: 'no_route' }))).toBe('no_route');
    expect(apiReason(err({ reason: 'not_tradable' }))).toBe('not_tradable');
  });

  it('ignores empty prose rather than showing a blank reason', () => {
    expect(apiReason(err({ error: 'no_route', detail: '   ' }))).toBe('no_route');
  });
});
