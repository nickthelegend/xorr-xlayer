/**
 * "This address is real" and "this token can be traded here" are different questions.
 *
 * `/market/tradable` answered the first while being asked the second. The equities are in `TOKENS`
 * because their addresses are real on Base; on a fork of Base they do not function. So all eight
 * were listed as tradable, `isTradable('NVDAc')` was true, and `/order/NVDAc` rendered a complete
 * ticket — live price, unit conversion, an enabled "Buy $250 of NVDAc" — for a fill that reverts.
 *
 * Two sources of truth with no test holding them together, and the screen was the one that lied.
 */
process.env.ONEINCH_API_KEY ??= 'test-key';
process.env.XORR_CHAIN ??= 'base-sepolia';

import { describe, expect, it, vi, beforeEach } from 'vitest';

const readContract = vi.fn();
// Every export, not just the one under test: `stocks.ts` pulls in the venue module, which pulls in
// the chain config, and a partial mock leaves those reading `undefined` at import time.
vi.mock('../evm/client.js', () => ({
  publicClient: { readContract: () => readContract() },
  walletClient: {},
  delegateAccount: { address: '0x0000000000000000000000000000000000000001' },
  KEY_DIRECTORY: '/tmp',
}));
vi.mock('./oneinch.js', () => ({
  quote: async () => ({ outAmount: 4, venues: [] }),
  TOKENS: {},
  canonicalSymbol: (x: string) => x,
  DEFAULT_SLIPPAGE_PCT: 0.3,
}));

const { equitiesFunctional, resetEquitiesFunctional, isStock, STOCKS } = await import('./stocks.js');

beforeEach(() => {
  readContract.mockReset();
  resetEquitiesFunctional();
});

describe('a token that will not answer cannot be traded', () => {
  it('is functional when totalSupply returns a real supply', async () => {
    // Real Base: these carry one byte of code and answer anyway.
    readContract.mockResolvedValue(1_373_108_020_000n);
    expect(await equitiesFunctional()).toBe(true);
  });

  it('is NOT functional when the call reverts', async () => {
    // An anvil fork of the same block: the byte is copied, nothing is behind it.
    readContract.mockRejectedValue(new Error('execution reverted'));
    expect(await equitiesFunctional()).toBe(false);
  });

  it('is NOT functional on a zero supply', async () => {
    // A token nobody holds is not one anybody can buy.
    readContract.mockResolvedValue(0n);
    expect(await equitiesFunctional()).toBe(false);
  });

  it('accepts any one token answering, because not all of them do', async () => {
    /*
     * Measured on real Base: only four of the eight answer `totalSupply()` — TSLAc, AMZNc, GOOGLc
     * and MSTRc revert — while all eight show transfer activity. They are transferable without
     * exposing the full ERC-20 read surface. Probing whichever happened to be first in the registry
     * would have called mainnet broken on a different ordering.
     */
    readContract.mockRejectedValueOnce(new Error('reverted')).mockResolvedValue(1_000n);
    expect(await equitiesFunctional()).toBe(true);
  });

  it('asks the chain once per process, not once per request', async () => {
    /*
     * `/market/tradable` is called on mount by the market list. An RPC round trip per request would
     * put the chain in front of a screen that renders before the user has done anything.
     */
    readContract.mockResolvedValue(1n);
    await Promise.all([equitiesFunctional(), equitiesFunctional(), equitiesFunctional()]);
    await equitiesFunctional();
    // One probe batch — four tokens, asked once — and nothing on the three later calls.
    expect(readContract).toHaveBeenCalledTimes(4);
  });
});

describe('the registry still holds them, which is correct', () => {
  it('every equity stays in STOCKS regardless — the addresses are real', () => {
    // Not being tradable HERE is not the same as not existing. The market list still shows them.
    expect(Object.keys(STOCKS).length).toBe(8);
    for (const s of Object.keys(STOCKS)) expect(isStock(s)).toBe(true);
  });
});
