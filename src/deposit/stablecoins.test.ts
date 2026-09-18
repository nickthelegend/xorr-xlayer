/**
 * What a deposit can arrive as, and what the wallet holds of it (PLAN.md P4.7, P4.12).
 */
import { describe, expect, it } from 'vitest';
import type { WalletTokens } from '@/data/walletTokens';
import {
  USDC_MAINNET,
  USDC_TESTNET,
  USDT0_MAINNET,
  acceptedTokens,
  asFundsRead,
  depositBalances,
  isUnfunded,
  stablecoinsOn,
  toRaw,
} from './stablecoins';

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
/** OKX's bridged USDC.e: called "USDC" by OKX's own token list, and not the USDC the executor settles in. */
const USDC_E = '0x74b7F16337b8972027F6196A17a631aC6dE26d22';

function read(tokens: Partial<WalletTokens['tokens'][number]>[], chain = 'xlayer'): WalletTokens {
  return {
    owner: OWNER,
    chain,
    source: 'chain',
    undescribed: [],
    tokens: tokens.map((t) => ({ symbol: '?', address: '0x0', decimals: 6, units: 0, usd: null, logo: null, ...t })),
  };
}

describe('stablecoinsOn / acceptedTokens', () => {
  it('names USDC and USDT0 on mainnet and its fork, USDC alone where there is no USDT0', () => {
    expect(stablecoinsOn('xlayer')).toEqual({ usdc: USDC_MAINNET, usdt0: USDT0_MAINNET });
    expect(stablecoinsOn('xlayer-fork')).toEqual({ usdc: USDC_MAINNET, usdt0: USDT0_MAINNET });
    expect(stablecoinsOn('xlayer-testnet')).toEqual({ usdc: USDC_TESTNET, usdt0: null });
    expect(stablecoinsOn('localnet').usdt0).toBeNull();
    expect(acceptedTokens('xlayer')).toBe('USDC or USDT0');
    expect(acceptedTokens('xlayer-testnet')).toBe('USDC');
  });
});

describe('toRaw', () => {
  it('writes base units through the decimal string', () => {
    expect(toRaw(100, 6)).toBe('100000000');
    expect(toRaw(0.1, 6)).toBe('100000');
    expect(toRaw(1.5, 18)).toBe('1500000000000000000');
    expect(toRaw(0, 6)).toBe('0');
    expect(toRaw(-1, 6)).toBe('0');
    expect(toRaw(Number.NaN, 6)).toBe('0');
  });
});

describe('depositBalances', () => {
  it('reads USDC, USDT0 and OKB by contract, and holds what the list leaves out at zero', () => {
    const b = depositBalances(
      read([
        { symbol: 'USDT0', address: USDT0_MAINNET, units: 25 },
        { symbol: 'OKB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18, units: 0.02, native: true },
      ]),
      'xlayer',
    );
    expect(b.usdc).toEqual({ raw: '0', amount: 0 });
    expect(b.usdt0).toEqual({ raw: '25000000', amount: 25 });
    expect(b.gas.amount).toBe(0.02);
    expect(isUnfunded(b)).toBe(false);
  });

  it('matches the contract in any case, never a symbol on another contract', () => {
    const b = depositBalances(
      read([
        { symbol: 'USDC', address: USDC_E, units: 500 },
        { symbol: 'USDC', address: USDC_MAINNET.toLowerCase(), units: 12.5 },
      ]),
      'xlayer',
    );
    expect(b.usdc.amount).toBe(12.5);
  });

  it('has no USDT0 row on the testnet, whatever the list says', () => {
    const b = depositBalances(
      read([
        { symbol: 'USDC', address: USDC_TESTNET, units: 100 },
        { symbol: 'USDT0', address: USDT0_MAINNET, units: 7 },
      ], 'xlayer-testnet'),
      'xlayer-testnet',
    );
    expect(b.usdc.amount).toBe(100);
    expect(b.usdt0).toBeNull();
  });

  it('calls a wallet with only gas unfunded', () => {
    const b = depositBalances(read([{ symbol: 'OKB', address: '0xEe', decimals: 18, units: 1, native: true }]), 'xlayer');
    expect(isUnfunded(b)).toBe(true);
  });
});

describe('asFundsRead', () => {
  it('carries the contracts arrivals are judged by', () => {
    const b = depositBalances(read([{ symbol: 'USDT0', address: USDT0_MAINNET, units: 3 }]), 'xlayer');
    const f = asFundsRead(b, 'xlayer');
    expect(f.usdc.address).toBe(USDC_MAINNET);
    expect(f.usdt0).toEqual({ raw: '3000000', amount: 3, address: USDT0_MAINNET });
    expect(asFundsRead(depositBalances(read([], 'xlayer-testnet'), 'xlayer-testnet'), 'xlayer-testnet').usdt0).toBeUndefined();
  });
});
