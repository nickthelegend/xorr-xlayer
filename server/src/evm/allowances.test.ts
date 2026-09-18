/**
 * Who may pull a token from the wallet (PLAN.md 3.12): the delegation's allowances and the 1inch router's, each read
 * from where it is true on this chain — and an allowance that could not be read is unread, never "none".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ chain: 'base-fork', readContract: vi.fn() }));
vi.mock('./chains.js', () => ({
  get CHAIN_KEY() {
    return h.chain;
  },
  ADDRESSES: { oneInchRouter: '0x111111125421cA6dc452d289314280a0f8842A65' },
}));
vi.mock('./client.js', () => ({ publicClient: { readContract: (...a: unknown[]) => h.readContract(...a) } }));
vi.mock('../venues/oneinch.js', () => ({ oneinchApi: vi.fn() }));

const { oneinchApi } = await import('../venues/oneinch.js');
const { allowanceView, chainAllowance, routerAllowance, routerSpender } = await import('./allowances.js');

const USDC = { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 } as const;
const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const ROUTER = '0x111111125421cA6dc452d289314280a0f8842A65';
const MAX = (1n << 256n) - 1n;

beforeEach(() => {
  h.chain = 'base-fork';
  h.readContract.mockReset();
  vi.mocked(oneinchApi).mockReset();
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

describe('the 1inch router', () => {
  it("on Base, is the spender 1inch's Approve API names, and its allowances come from that API", async () => {
    h.chain = 'base';
    vi.mocked(oneinchApi).mockResolvedValueOnce({ address: ROUTER.toLowerCase() });
    expect(await routerSpender()).toEqual({ address: ROUTER.toLowerCase(), source: '1inch' });
    expect(oneinchApi).toHaveBeenCalledWith('/swap/v6.0/8453/approve/spender', 3_600_000);

    vi.mocked(oneinchApi).mockResolvedValueOnce({ allowance: '1000' });
    expect(await routerAllowance(USDC.address, OWNER, '1inch', ROUTER)).toBe(1000n);
    expect(vi.mocked(oneinchApi).mock.calls[1]![0]).toBe(
      `/swap/v6.0/8453/approve/allowance?tokenAddress=${USDC.address}&walletAddress=${OWNER}`,
    );
    expect(h.readContract).not.toHaveBeenCalled();
  });

  it('anywhere else, is the router this chain routes through, read from the chain', async () => {
    expect(await routerSpender()).toEqual({ address: ROUTER, source: 'chain' });
    h.readContract.mockResolvedValue(0n);
    expect(await routerAllowance(USDC.address, OWNER, 'chain', ROUTER)).toBe(0n);
    expect(oneinchApi).not.toHaveBeenCalled();
  });

  it('an Approve API answer that fails is unread, not none', async () => {
    vi.mocked(oneinchApi).mockRejectedValue(new Error('429'));
    expect(await routerAllowance(USDC.address, OWNER, '1inch', ROUTER)).toBeUndefined();
  });
});
