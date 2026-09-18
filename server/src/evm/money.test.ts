/**
 * What money on each chain is (`evm/money.ts`): what the mainnet guard, the faucet and the gas drip read, so nothing is
 * handed out on a chain whose money is real, including one the list has never heard of.
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_CHAINS, isKnownChain, moneyOn, networkName } from './money.js';

describe('what money on a chain is', () => {
  it('is real on Base mainnet, test funds on Base Sepolia, and a copy on a fork or a local chain', () => {
    expect(moneyOn('base')).toBe('real');
    expect(moneyOn('base-sepolia')).toBe('test');
    expect(moneyOn('base-fork')).toBe('copy');
    expect(moneyOn('localnet')).toBe('copy');
    expect([...KNOWN_CHAINS].sort()).toEqual(['base', 'base-fork', 'base-sepolia', 'localnet']);
  });

  it('is real on a chain the list does not know, so nothing is handed out on a guess', () => {
    for (const key of ['arbitrum', 'optimism', 'BASE', '', 'constructor', 'toString', '__proto__']) {
      expect(isKnownChain(key)).toBe(false);
      expect(moneyOn(key)).toBe('real');
    }
  });

  it('names each network as a sentence says it, and a chain it does not know as its key', () => {
    expect(networkName('base')).toBe('Base mainnet');
    expect(networkName('base-fork')).toBe('a fork of Base mainnet');
    expect(networkName('arbitrum')).toBe('arbitrum');
  });
});
