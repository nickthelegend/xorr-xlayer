/**
 * Both SDKs refuse a second embedded wallet, and neither words it like the other.
 *
 * Verbatim, observed on screen: the native message under four green ticks on an iPhone 17 Pro
 * simulator, and the web one in Chrome minutes later — after the native case had already been
 * "fixed". Matching only `already exists` left the web screen printing the SDK's sentence in red
 * on the happy path for every returning user.
 */
import { describe, expect, it } from 'vitest';
import { alreadyHasWallet } from './alreadyHasWallet';

const NATIVE =
  "Wallet already exists for this user. Set 'createAdditional' to 'true' to create another wallet.";
const WEB = 'User already has an embedded wallet.';

describe('Privy refusing a second embedded wallet is not a failure', () => {
  it('recognises the @privy-io/expo wording', () => {
    expect(alreadyHasWallet(new Error(NATIVE))).toBe(true);
  });

  it('recognises the @privy-io/react-auth wording', () => {
    expect(alreadyHasWallet(new Error(WEB))).toBe(true);
  });

  it('accepts a bare string as well as an Error', () => {
    expect(alreadyHasWallet(WEB)).toBe(true);
  });

  /*
   * The point of the guard is that everything else still propagates. A broad catch here would
   * swallow a real wallet-creation failure and report success to a user who has no wallet.
   */
  it('does not swallow anything else', () => {
    for (const other of [
      'Network request failed',
      'User rejected the request.',
      'Embedded wallet creation is disabled for this app.',
      'Session already exists',
      'insufficient funds for gas',
    ]) {
      expect(alreadyHasWallet(new Error(other))).toBe(false);
    }
  });
});
