/**
 * What money on each chain is (`evm/money.ts`): what the mainnet guard, the faucet and the gas drip read, so nothing is
 * handed out on a chain whose money is real, including one the list has never heard of.
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_CHAINS, isKnownChain, moneyOn, networkName } from './money.js';

describe('what money on a chain is', () => {
  it('is real on X Layer mainnet, test funds on its testnet, and a copy on a fork or a local chain', () => {
    expect(moneyOn('xlayer')).toBe('real');
    expect(moneyOn('xlayer-testnet')).toBe('test');
    expect(moneyOn('xlayer-fork')).toBe('copy');
    expect(moneyOn('localnet')).toBe('copy');
    expect([...KNOWN_CHAINS].sort()).toEqual(['localnet', 'xlayer', 'xlayer-fork', 'xlayer-testnet']);
  });

  it('is real on a chain the list does not know, so nothing is handed out on a guess', () => {
    for (const key of ['arbitrum', 'base', 'XLAYER', '', 'constructor', 'toString', '__proto__']) {
      expect(isKnownChain(key)).toBe(false);
      expect(moneyOn(key)).toBe('real');
    }
  });

  it('names each network as a sentence says it, and a chain it does not know as its key', () => {
    expect(networkName('xlayer')).toBe('X Layer mainnet');
    expect(networkName('xlayer-fork')).toBe('a fork of X Layer mainnet');
    expect(networkName('arbitrum')).toBe('arbitrum');
  });
});
