/**
 * "This address is real" and "this token can be traded here" are different questions.
 *
 * `/market/tradable` answered the first while being asked the second. On the Base build the
 * equities were in `TOKENS` because their addresses were real on Base; on a fork of Base they did
 * not function. So all eight were listed as tradable, `isTradable('NVDAc')` was true, and
 * `/order/NVDAc` rendered a complete ticket — live price, unit conversion, an enabled "Buy $250 of
 * NVDAc" — for a fill that reverts. On X Layer the same split holds: the wrapped xStocks are real on
 * mainnet and its fork, and have no code on the testnet.
 *
 * Two sources of truth with no test holding them together, and the screen was the one that lied.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const readContract = vi.fn();
// Every export, not just the one under test: a partial mock leaves the other readers of the client
// seeing `undefined` at import time.
vi.mock('../evm/client.js', () => ({
  publicClient: { readContract: () => readContract() },
  walletClient: {},
  delegateAccount: { address: '0x0000000000000000000000000000000000000001' },
  KEY_DIRECTORY: '/tmp',
}));
vi.mock('./uniswap.js', () => ({ quote: async () => ({ outAmount: 4, venues: [] }) }));
vi.mock('../evm/throttle.js', () => ({ pastTheThrottle: <T>(f: () => Promise<T>) => f() }));
vi.mock('../db/index.js', () => ({ query: vi.fn(async () => []), one: vi.fn() }));

const { equitiesFunctional, resetEquitiesFunctional, isStock, STOCKS } = await import('./stocks.js');

beforeEach(() => {
  readContract.mockReset();
  resetEquitiesFunctional();
});

describe('a token that will not answer cannot be traded', () => {
  it('is functional when totalSupply returns a real supply', async () => {
    // X Layer mainnet: a wrapper is an ordinary ERC-4626 with a supply.
    readContract.mockResolvedValue(1_373_108_020_000n);
    expect(await equitiesFunctional()).toBe(true);
  });

  it('is NOT functional when the call reverts', async () => {
    // The testnet: the wrappers have no code, so the call reverts.
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
     * Measured on real Base: only four of the eight equities there answered `totalSupply()` while
     * all eight showed transfer activity. Probing whichever happened to be first in the registry
     * would have called mainnet broken on a different ordering, so any one answering is enough.
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
    // One probe batch — three wrappers, asked once — and nothing on the three later calls.
    expect(readContract).toHaveBeenCalledTimes(3);
  });
});

describe('the registry still holds them, which is correct', () => {
  it('every equity stays in STOCKS regardless — the addresses are real', () => {
    // Not being tradable HERE is not the same as not existing. The market list still shows them.
    // The eleven wrapped xStocks on X Layer (`venues/stocks.ts`).
    expect(Object.keys(STOCKS).length).toBe(11);
    for (const s of Object.keys(STOCKS)) expect(isStock(s)).toBe(true);
  });
});
