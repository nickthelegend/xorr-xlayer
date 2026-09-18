/**
 * Which key signs the permission.
 *
 * Found on the hosted build, not in a test: with a wallet extension installed, pressing "Sign this
 * permission" raised the extension's own dialog. Both web call sites took `wallets[0]`, and Privy
 * lists injected wallets alongside the embedded one.
 */
import { describe, expect, it } from 'vitest';
import { isEmbedded, pickEmbedded } from './embeddedWallet';

const embedded = { address: '0xEMBEDDED', walletClientType: 'privy' };
const metamask = { address: '0xEXTENSION', walletClientType: 'metamask' };
const injected = { address: '0xINJECTED', connectorType: 'injected', walletClientType: 'rabby' };
/** Newer SDKs mark it this way instead. */
const embeddedByConnector = { address: '0xEMBEDDED2', connectorType: 'embedded' };

describe('pickEmbedded', () => {
  it('picks the embedded wallet even when an extension is listed first', () => {
    expect(pickEmbedded([metamask, embedded])?.address).toBe('0xEMBEDDED');
    expect(pickEmbedded([injected, metamask, embedded])?.address).toBe('0xEMBEDDED');
  });

  it('recognises the embedded wallet by either marker', () => {
    expect(pickEmbedded([metamask, embeddedByConnector])?.address).toBe('0xEMBEDDED2');
  });

  it('returns nothing rather than an extension when there is no embedded wallet', () => {
    // The whole point. A fallback to wallets[0] here is the bug this module exists to prevent:
    // a permission signed by a key the executor is not watching grants nothing it can use.
    expect(pickEmbedded([metamask, injected])).toBeUndefined();
  });

  it('handles an empty or absent list', () => {
    expect(pickEmbedded([])).toBeUndefined();
    expect(pickEmbedded(undefined)).toBeUndefined();
  });

  it('is unbothered by the single-wallet case it always got right', () => {
    expect(pickEmbedded([embedded])?.address).toBe('0xEMBEDDED');
  });
});

describe('isEmbedded', () => {
  it('is true only for Privy’s own wallet', () => {
    expect(isEmbedded(embedded)).toBe(true);
    expect(isEmbedded(embeddedByConnector)).toBe(true);
    expect(isEmbedded(metamask)).toBe(false);
    expect(isEmbedded(injected)).toBe(false);
    expect(isEmbedded(undefined)).toBe(false);
  });
});
