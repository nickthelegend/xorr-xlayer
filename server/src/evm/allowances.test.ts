/**
 * Who may pull a token from the wallet (PLAN.md 3.12): the delegation's allowances and the Uniswap v3 router's, both read
 * from the chain — and an allowance that could not be read is unread, never "none".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readContract: vi.fn(),
  /** The router on this chain: X Layer mainnet and its fork have it, the testnet does not. */
  router: '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA' as string | null,
}));
vi.mock('./chains.js', () => ({
  ADDRESSES: {
    get uniswapRouter() {
      return h.router;
    },
  },
  QUOTE_ADDRESSES: { uniswapRouter: '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA' },
}));
vi.mock('./client.js', () => ({ publicClient: { readContract: (...a: unknown[]) => h.readContract(...a) } }));

const { allowanceView, chainAllowance, routerAllowance, routerSpender } = await import('./allowances.js');

/** Circle's USDC on X Layer. */
const USDC = { symbol: 'USDC', address: '0xB6CEceAB302E2E4948951eE7843FC24E92933061', decimals: 6 } as const;
const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
/** Uniswap v3 SwapRouter02 on X Layer. */
const ROUTER = '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA';
const MAX = (1n << 256n) - 1n;

beforeEach(() => {
  h.router = ROUTER;
  h.readContract.mockReset();
});

describe('an allowance, as the screen reads it', () => {
  it("says none, unlimited, or how much — in the token's own decimals", () => {
    expect(allowanceView(USDC, 0n)).toMatchObject({ allowance: '0', none: true, unlimited: false, unread: false });
    expect(allowanceView(USDC, MAX)).toMatchObject({ unlimited: true, none: false, unread: false });
    expect(allowanceView(USDC, 2_500_000n)).toMatchObject({ allowance: '2500000', display: '2.5', none: false, unlimited: false });
    // The fork tooling approves 2^255 and a sale counts it down: still unlimited, not a 59-digit amount.
    expect(allowanceView(USDC, (1n << 255n) - 10n ** 6n)).toMatchObject({ unlimited: true });
    expect(allowanceView(USDC, (1n << 254n) - 1n)).toMatchObject({ unlimited: false });
  });

  it('says unread when the read failed, rather than none', () => {
    expect(allowanceView(USDC, undefined)).toEqual({
      ...USDC,
      allowance: null,
      display: null,
      unlimited: false,
      none: false,
      unread: true,
    });
  });
});

describe('reading an allowance from the chain', () => {
  it('asks the token contract for this owner and spender', async () => {
    h.readContract.mockResolvedValue(7n);
    expect(await chainAllowance(USDC.address, OWNER, ROUTER)).toBe(7n);
    expect(h.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: USDC.address, functionName: 'allowance', args: [OWNER, ROUTER] }),
    );
  });

  it('answers undefined when the read fails', async () => {
    h.readContract.mockRejectedValue(new Error('rpc down'));
    expect(await chainAllowance(USDC.address, OWNER, ROUTER)).toBeUndefined();
  });
});

describe('the swap router', () => {
  it("is the Uniswap v3 router this chain routes through, and its allowances are read from the chain", async () => {
    expect(await routerSpender()).toEqual({ address: ROUTER, source: 'chain' });
    h.readContract.mockResolvedValue(1000n);
    expect(await routerAllowance(USDC.address, OWNER, 'chain', ROUTER)).toBe(1000n);
    expect(h.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: USDC.address, functionName: 'allowance', args: [OWNER, ROUTER] }),
    );
  });

  it("on the testnet, which has no router, names mainnet's rather than none", async () => {
    h.router = null;
    expect(await routerSpender()).toEqual({ address: ROUTER, source: 'chain' });
  });

  it('a router allowance that cannot be read is unread, not none', async () => {
    h.readContract.mockRejectedValue(new Error('rpc down'));
    expect(await routerAllowance(USDC.address, OWNER, 'chain', ROUTER)).toBeUndefined();
  });
});
