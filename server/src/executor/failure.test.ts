/**
 * What the user is told when a trade does not go through.
 *
 * This table used to map Solana Anchor program codes, which cannot occur on an EVM chain, so every
 * real revert fell through to "the transaction did not go through" — the one message that tells a
 * user nothing about whether their money is safe or their limits worked.
 */
import { describe, expect, it } from 'vitest';
import { httpStatusFor, humanFailure, isTransient } from './failure.js';

describe('revert reasons, in plain language', () => {
  it('names the daily cap when the cap is what stopped it', () => {
    expect(humanFailure('execution reverted: custom error 0x3e814127')).toMatch(/cap is used up/i);
  });

  it('names revocation, which is the user asking it to stop', () => {
    expect(humanFailure('reverted with signature 0x430f7460')).toMatch(/revoked/i);
  });

  it('names the venue allowlist', () => {
    expect(humanFailure('execution reverted: custom error 0x2114fba2')).toMatch(/allowlist/i);
  });

  it('reads a decoded error name when the RPC gives one', () => {
    expect(humanFailure('Error: DailyCapExceeded(1000, 500)')).toMatch(/cap is used up/i);
  });

  it('does not confuse one selector for another that shares a prefix', () => {
    // 0x1db3b859 (NotDelegate) and 0x1f2a2005 (ZeroAmount) both begin 0x1; a substring match here
    // would tell a user their permission was wrong when the size was.
    expect(humanFailure('custom error 0x1f2a2005')).toMatch(/zero/i);
    expect(humanFailure('custom error 0x1db3b859')).toMatch(/not the one you gave permission/i);
  });

  it('explains a testnet that cannot settle, rather than blaming the trade', () => {
    expect(humanFailure('Cannot fill on base-sepolia: 1inch has no deployment there.')).toMatch(
      /cannot settle/i,
    );
  });

  it('falls back to something true rather than something specific and wrong', () => {
    expect(humanFailure('some upstream nonsense')).toBe(
      'The transaction did not go through, so nothing was placed.',
    );
  });
});


describe('the router error the deployed venue actually reverts with', () => {
  /*
   * A live DCA run on the fork failed with `0x064a4ec6`. The table held the zero-argument and
   * one-argument forms of `ReturnAmountIsNotEnough` and neither matched, so a price move was
   * reported as "the transaction did not go through" while the log said
   *
   *   Unable to decode signature "0x064a4ec6" as it was not found on the provided ABI
   *
   * The difference the user cares about is "try again" versus "something is broken".
   */
  it('decodes the two-argument ReturnAmountIsNotEnough', () => {
    const raw =
      'The contract function "spend" reverted with the following signature:\n0x064a4ec6\n\n' +
      'Unable to decode signature "0x064a4ec6" as it was not found on the provided ABI.';
    expect(humanFailure(raw)).toContain('slippage limit');
    expect(humanFailure(raw)).not.toContain('0x064a4ec6');
  });

  it('still decodes the other two arities', () => {
    expect(humanFailure('reverted with the following signature: 0x9a446475')).toContain('slippage');
    expect(humanFailure('reverted with the following signature: 0xf32bec2f')).toContain('slippage');
  });

  it('does not mistake a delegation error for a venue one', () => {
    // Selectors are matched exactly; a prefix collision here would blame the wrong party.
    expect(humanFailure('reverted with the following signature: 0x430f7460')).toContain('revoked');
    expect(humanFailure('reverted with the following signature: 0x3e814127')).toContain('cap');
  });
});

describe('a lost run and a refused one are not the same thing', () => {
  /*
   * `period_key` is UNIQUE, so a FAILED row consumes that period permanently. A user whose daily
   * buy hit a five-second RPC timeout silently lost the day, and the only trace was a `failed` row
   * nothing ever revisited.
   *
   * The classification is conservative in one direction only: a wrong "transient" costs a wasted
   * retry, a wrong "permanent" costs a user a trade they asked for.
   */
  it('releases the period for a failure that obtained no answer', () => {
    for (const e of [
      'fetch failed',
      'The request timed out after 5000ms',
      'connect ETIMEDOUT 10.0.0.1:443',
      'socket hang up',
      'HTTP 503 from upstream',
      'HTTP 429 rate limit exceeded',
      'nonce too low',
    ]) {
      expect(isTransient(e), `${e} should be retryable`).toBe(true);
    }
  });

  it('keeps the period for anything the contract or the venue refused', () => {
    for (const e of [
      'The contract function "spend" reverted with the following signature: 0x430f7460', // PolicyRevoked
      'DailyCapExceeded(1000, 200)',
      'VenueNotAllowed(0xdead)',
      'PolicyExpired()',
      'NotDelegate()',
      'execution reverted: TF',
      'No route for USDC -> NOTATOKEN',
      'VenueCallFailed()',
    ]) {
      expect(isTransient(e), `${e} must NOT be retried`).toBe(false);
    }
  });

  it('treats a price move as a real answer, not weather', () => {
    // Retrying inside one tick is how a bot chases a moving price.
    expect(isTransient('ReturnAmountIsNotEnough(19833510231696141, 19900000000000000)')).toBe(false);
    expect(isTransient('The price moved more than your slippage limit')).toBe(false);
  });

  it('does not release on a bare unknown error', () => {
    // Unknown means unknown. Releasing a claim on a cause nobody has classified is how a
    // double-buy gets invented.
    expect(isTransient('something went wrong')).toBe(false);
    expect(isTransient('')).toBe(false);
  });
});

/*
 * The status a failed run comes back as decides whether the app offers a **Try again**, because
 * the client treats 5xx as retryable. Every run route answered `failed ? 502 : 200`, so a run that
 * failed because this chain cannot settle at all invited the user to press a button that will
 * answer identically forever — the exact failure `isRetryable` exists to prevent.
 */
describe('httpStatusFor', () => {
  it('offers a retry only when the failure was transient', () => {
    expect(httpStatusFor({ status: 'failed', raw: 'upstream timed out' })).toBe(502);
    expect(httpStatusFor({ status: 'failed', raw: 'fetch failed' })).toBe(502);
  });

  it('refuses permanently when the chain cannot settle at all', () => {
    expect(
      httpStatusFor({
        status: 'failed',
        raw: 'Cannot fill on base-sepolia: 1inch has no deployment there.',
      }),
    ).toBe(409);
  });

  it('refuses permanently when the contract itself said no', () => {
    // A policy refusal is an answer, not a failure to get one. Retrying changes nothing.
    for (const raw of ['PolicyExpired', 'DailyCapExceeded(1,2)', 'VenueNotAllowed(0x0)']) {
      expect(httpStatusFor({ status: 'failed', raw })).toBe(409);
    }
  });

  it('leaves the outcomes that are not failures alone', () => {
    expect(httpStatusFor({ status: 'filled' })).toBe(200);
    expect(httpStatusFor({ status: 'skipped' })).toBe(200);
    expect(httpStatusFor({ status: 'watch' })).toBe(200);
    // `blocked` is a limit refusing the trade — well-formed request, refused by the world.
    expect(httpStatusFor({ status: 'blocked' })).toBe(409);
  });

  it('does not offer a retry when there is no detail to classify', () => {
    // An unclassifiable failure is not evidence that repeating it will help.
    expect(httpStatusFor({ status: 'failed' })).toBe(409);
  });
});
