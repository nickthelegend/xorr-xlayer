/**
 * The default venue, pinned on a fork of X Layer: the route a symbol takes, the path the router is handed, the floor a
 * fill is held to, that the bought tokens are paid to the OWNER, and which pools a quote reads.
 *
 * That last one is the reason this file exists. A fork is frozen at the block it was taken from, so a price read from its
 * pools never moves; prices and the agent's signals read the live mainnet pools, while a fill's quote and floor read the
 * chain it settles on. Mixing those up either freezes the agent or fills against pools the transaction will not touch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, getAddress, type Hex } from 'viem';

vi.hoisted(() => {
  process.env.XORR_CHAIN = 'xlayer-fork';
});

const forkSim = vi.fn();
const marketSim = vi.fn();
vi.mock('../evm/client.js', () => ({ publicClient: { simulateContract: (a: unknown) => forkSim(a) } }));
vi.mock('viem', async (orig) => {
  const actual = await orig<typeof import('viem')>();
  return { ...actual, createPublicClient: () => ({ simulateContract: (a: unknown) => marketSim(a) }) };
});
const priceOf = vi.fn();
vi.mock('../market/prices.js', () => ({ priceOf: (s: string) => priceOf(s) }));

const { routeBetween, encodePath, quote, buildSwap, ROUTER_ABI } = await import('./uniswap.js');

const OWNER = '0x00000000000000000000000000000000000000A1' as const;
const DELEGATION = '0x00000000000000000000000000000000000000D1' as const;
const ROUTER = '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA';

/** QuoterV2's `quoteExactInput` result: amountOut, the ticks and fees it crossed, and a gas estimate. */
const answer = (amountOut: bigint) => ({ result: [amountOut, [], [], 150_000n] });

beforeEach(() => {
  forkSim.mockReset();
  marketSim.mockReset();
  priceOf.mockReset();
});

describe('routes', () => {
  it('buys a USDC-paired xStock directly, and a USDG-paired one through USDG', () => {
    expect(routeBetween('USDC', 'TSLAx').tokens).toEqual(['USDC', 'TSLAx']);
    const nvda = routeBetween('USDC', 'NVDAx');
    expect(nvda.tokens).toEqual(['USDC', 'USDG', 'NVDAx']);
    expect(nvda.fees).toHaveLength(2);
  });

  it('refuses a token with no pool against a stablecoin', () => {
    expect(() => routeBetween('USDC', 'WETH')).toThrow(/no pool with liquidity/);
  });

  it('encodes the path as address, fee, address — 20 + 3 + 20 bytes per hop', () => {
    const path = encodePath(routeBetween('USDC', 'NVDAx'));
    expect((path.length - 2) / 2).toBe(20 + 3 + 20 + 3 + 20);
  });
});

describe('a quote', () => {
  it('reads the fork for a fill: size in the token\'s own units, the floor from the tolerance', async () => {
    forkSim.mockResolvedValue(answer(274_000_000_000_000_000n)); // 0.274 TSLAx
    priceOf.mockResolvedValue(null);
    const q = await quote({ inSymbol: 'USDC', outSymbol: 'TSLAx', amount: 100, slippagePct: 0.5 });
    expect(forkSim).toHaveBeenCalledTimes(1);
    expect(marketSim).not.toHaveBeenCalled();
    expect((forkSim.mock.calls[0]![0] as { args: [Hex, bigint] }).args[1]).toBe(100_000_000n);
    expect(q.outAmount).toBeCloseTo(0.274, 12);
    expect(q.minimumOut).toBeCloseTo(0.274 * 0.995, 12);
    expect(q.venues).toEqual(['Uniswap v3']);
  });

  it('reads the live mainnet pools for a market price, never the fork\'s frozen copy', async () => {
    marketSim.mockResolvedValue(answer(274_000_000_000_000_000n));
    await quote({ inSymbol: 'USDC', outSymbol: 'TSLAx', amount: 1_000, skipPriceImpact: true, market: true });
    expect(marketSim).toHaveBeenCalledTimes(1);
    expect(forkSim).not.toHaveBeenCalled();
  });

  it('names the hop in the route', async () => {
    forkSim.mockResolvedValue(answer(450_000_000_000_000_000n));
    const q = await quote({ inSymbol: 'USDC', outSymbol: 'NVDAx', amount: 100, skipPriceImpact: true });
    expect(q.route).toBe('Uniswap v3 via USDG');
  });

  it('measures price impact against the feed, and says null when a leg has no price — never zero', async () => {
    forkSim.mockResolvedValue(answer(270_000_000_000_000_000n));
    priceOf.mockImplementation(async (s: string) => (s === 'USDC' ? 1 : 364));
    const q = await quote({ inSymbol: 'USDC', outSymbol: 'TSLAx', amount: 100 });
    // At the mid, $100 buys 100/364 = 0.2747 TSLAx; 0.27 is 1.72% short of that.
    expect(q.priceImpactPct).toBeCloseTo(((100 / 364 - 0.27) / (100 / 364)) * 100, 6);

    priceOf.mockImplementation(async () => null);
    const unpriced = await quote({ inSymbol: 'USDC', outSymbol: 'TSLAx', amount: 100 });
    expect(unpriced.priceImpactPct).toBeNull();
  });

  it('refuses a size of zero and a route with no liquidity', async () => {
    await expect(quote({ inSymbol: 'USDC', outSymbol: 'TSLAx', amount: 0 })).rejects.toThrow(/above zero/);
    forkSim.mockResolvedValue(answer(0n));
    await expect(quote({ inSymbol: 'USDC', outSymbol: 'TSLAx', amount: 5, skipPriceImpact: true })).rejects.toThrow(
      /No liquidity/,
    );
  });
});

describe('a swap', () => {
  it('pays the OWNER, from the delegation\'s exact amount, held to the floor the fork quotes', async () => {
    forkSim.mockResolvedValue(answer(1_000_000_000_000_000_000n)); // 1.0 TSLAx
    const swap = await buildSwap({
      inSymbol: 'USDC',
      outSymbol: 'TSLAx',
      amount: 364,
      from: DELEGATION,
      receiver: OWNER,
      slippagePct: 1,
    });
    expect(getAddress(swap.to)).toBe(getAddress(ROUTER));
    expect(marketSim).not.toHaveBeenCalled();
    const { functionName, args } = decodeFunctionData({ abi: ROUTER_ABI, data: swap.data });
    expect(functionName).toBe('exactInput');
    const p = args[0] as { recipient: string; amountIn: bigint; amountOutMinimum: bigint };
    expect(getAddress(p.recipient)).toBe(OWNER);
    expect(p.amountIn).toBe(364_000_000n);
    expect(p.amountOutMinimum).toBe(990_000_000_000_000_000n);
    expect(swap.minOut).toBe(p.amountOutMinimum);
  });

  it('sells exactly the raw amount it is handed — a whole balance, never a float round-trip of it', async () => {
    forkSim.mockResolvedValue(answer(99_000_000n));
    const swap = await buildSwap({
      inSymbol: 'TSLAx',
      outSymbol: 'USDC',
      amount: 0.27,
      amountRaw: 274_123_456_789_012_345n,
      from: DELEGATION,
      receiver: OWNER,
    });
    const { args } = decodeFunctionData({ abi: ROUTER_ABI, data: swap.data });
    expect((args[0] as { amountIn: bigint }).amountIn).toBe(274_123_456_789_012_345n);
  });
});
