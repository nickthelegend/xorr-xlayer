/**
 * The first screen of the product must not speak to the user in a developer's words.
 *
 * It did: "Not signed in, so /wallet/connect was not requested." — naming an internal endpoint, on
 * onboarding, before the user had typed anything. These pin the translations and, more importantly,
 * the one rule that matters: a message that reaches a person never contains a path.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, NotSignedIn, TimedOut } from '@/data/apiError';
import { codeFailure, connectFailure, oauthFailure, verifyFailure } from './onboardingErrors';

const withGoogle = (e: unknown) => oauthFailure(e, 'Google');
const ALL = [codeFailure, connectFailure, verifyFailure, withGoogle];

describe('nothing reaches the user in developer words', () => {
  it('never leaks an endpoint path, whatever threw', () => {
    const leaky = [
      new NotSignedIn('/wallet/connect'),
      new TimedOut('/wallet/connect', 45_000),
      new Error('POST /orders failed with 500'),
    ];
    for (const fn of ALL) {
      for (const e of leaky) {
        expect(fn(e), `${fn.name} on ${String(e)}`).not.toMatch(/\/[a-z]+\//);
      }
    }
  });

  it('says a timeout may still be going through, never that it failed', () => {
    for (const fn of ALL) {
      expect(fn(new TimedOut('/x', 1000))).toMatch(/still be going through/i);
    }
  });
});

describe('the cases a user can act on', () => {
  it('names a bad email rather than blaming the network', () => {
    expect(codeFailure(new Error('Invalid email address'))).toMatch(/does not look right/i);
  });

  it('distinguishes a wrong code from an expired one', () => {
    expect(verifyFailure(new Error('invalid code'))).toMatch(/not right/i);
    expect(verifyFailure(new Error('This code has expired'))).toMatch(/expired/i);
  });

  it('treats an existing wallet as nothing to report', () => {
    // The postcondition already held. Both SDK wordings, per `alreadyHasWallet`.
    expect(verifyFailure(new Error('User already has an embedded wallet.'))).toBe('');
    expect(
      verifyFailure(new Error("Wallet already exists for this user. Set 'createAdditional'…")),
    ).toBe('');
  });

  it('prefers the executor’s own sentence over a substitute', () => {
    // `apiReason` exists because "No route for USDC -> WETH" beats anything a screen could invent.
    const e = new ApiError(400, '/wallet/connect', { message: 'That address is already claimed.' });
    expect(connectFailure(e)).toBe('That address is already claimed.');
  });

  it('says the wallet is fine when it is the executor that is down', () => {
    expect(connectFailure(new ApiError(503, '/wallet/connect', {}))).toMatch(/wallet is fine/i);
  });
});

describe('signing in with Google, X or a wallet', () => {
  it('says nothing when the person simply backed out of the provider', () => {
    for (const e of [new Error('The user canceled the authorization'), new Error('Flow was dismissed')]) {
      expect(oauthFailure(e, 'Google')).toBe('');
    }
  });

  it('names the method that is not switched on for this app, and offers the way that is', () => {
    const said = oauthFailure(new Error('OAuth provider twitter is not enabled for this app'), 'X');
    expect(said).toMatch(/^X sign-in is not switched on/);
    expect(said).toMatch(/email code/i);
  });

  it('falls back to what failed, naming the method, rather than the SDK\'s words', () => {
    expect(oauthFailure(new Error('AuthSession request failed: ERR_1042'), 'Google')).toMatch(
      /Signing in with Google did not go through/,
    );
  });
});
