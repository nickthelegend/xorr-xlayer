/**
 * Where a leg settles on X Layer, with every venue stood in for (PLAN.md 3.8 and 3.20).
 *
 * `chooseSettlement` is best execution: Uniswap v3 is quoted, the tolerance is set from that quote (or from the person's
 * own), Uniswap builds the route, and OKX DEX — only when this deployment is keyed for it — wins only when its floor is
 * higher, carrying the approval contract it pulls through. A direct leg goes to its own venue. These cases prove which
 * builder is asked, with what, which venue wins, and which floor the leg is held to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import type { SwapCalldata, SwapQuote } from '../venues/tokens.js';
import type { OkxRoute } from '../venues/okxdex.js';
import type { TradeIntent } from './kinds/index.js';
import type { SettlementSend } from './settle.js';

/** X Layer mainnet: Circle's USDC, wrapped OKB and Tether's USDT0 (`evm/chains.ts`). */
const TOKENS = vi.hoisted(
  () =>
    ({
      USDC: { address: '0xB6CEceAB302E2E4948951eE7843FC24E92933061', decimals: 6 },
      WOKB: { address: '0xe538905cf8410324e03A5A23C1c177a474D59b2b', decimals: 18 },
      USDT0: { address: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', decimals: 6 },
    }) as const,
);

vi.mock('../venues/tokens.js', () => ({
  TOKENS,
  SLIPPAGE: { scheduled: 0.3, stop: 1, panic: 2 },
  // A spy: what settlement hands it, and that its answer is the tolerance every venue gets, are the assertions.
  slippageFor: vi.fn(),
}));
vi.mock('../venues/uniswap.js', () => ({ quote: vi.fn(), buildSwap: vi.fn() }));
vi.mock('../venues/okxdex.js', () => ({ okxConfigured: vi.fn(), okxRoute: vi.fn() }));
vi.mock('../evm/delegation.js', () => ({ viaWouldFill: vi.fn() }));

const { slippageFor } = await import('../venues/tokens.js');
const { buildSwap, quote } = await import('../venues/uniswap.js');
const { okxConfigured, okxRoute } = await import('../venues/okxdex.js');
const { viaWouldFill } = await import('../evm/delegation.js');
const { chooseSettlement } = await import('./settle.js');

const USDC = TOKENS.USDC.address;
const WOKB = TOKENS.WOKB.address;
/** The user whose capital is spent, and who receives what it buys. */
const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
/** Holds the tokens for the length of the venue call. */
const DELEGATION = '0x6c5528Fd8E74a047A85bAb413856A9239E73540e';
/** Uniswap v3 SwapRouter02 on X Layer. */
const ROUTER = '0x4f0C28f5926AFDA16bf2506D5D9e57Ea190f9bcA';
/** OKX DEX's router and the approval contract it pulls through, on X Layer. */
const OKX_ROUTER = '0x7c5bEE2a8091C3EF39072f64F18fAc913060AEAf';
const OKX_SPENDER = '0x8b773D83bc66Be128c60e07E17C8901f7a64F000';
/** Aave v3's Pool on X Layer. */
const AAVE_POOL = '0xE3F3Caefdd7180F884c01E57f65Df979Af84f116';
const USDT0 = TOKENS.USDT0.address;
/** The receipt token a USDT0 supply mints. */
const A_USDT0 = '0xF356ae412dB5df43BD3a10746f7ad4e1C4De4297';

/** A scheduled buy: $100 of WOKB, paid in USDC. */
const buy = (over: Partial<TradeIntent> = {}): TradeIntent => ({
  inSymbol: 'USDC',
  outSymbol: 'WOKB',
  amountIn: 100,
  usd: 100,
  because: 'Scheduled buy of $100 of WOKB.',
  ...over,
});

const settle = (intent: TradeIntent, opts: { isClose?: boolean; send?: SettlementSend } = {}) =>
  chooseSettlement({
    intent,
    owner: OWNER,
    isClose: opts.isClose ?? false,
    delegationFrom: DELEGATION,
    // What `spend()` would pull for the $100 buy; a close says what it sells.
    send: opts.send ?? { via: 'spend', amount: 100_000_000n },
  });

/** What Uniswap quoted for the buy: 0.5 WOKB, 0.42% under the mid. */
const QUOTE: SwapQuote = {
  inSymbol: 'USDC',
  outSymbol: 'WOKB',
  inAmount: 100,
  outAmount: 0.5,
  minimumOut: 0.4985,
  slippagePct: 0.3,
  venues: ['Uniswap v3'],
  route: 'Uniswap v3 via USDT0',
  priceImpactPct: 0.42,
  estimatedGas: 184_000,
};

/** A recognisable tolerance: whatever the spy answers is what must reach every venue. */
const WIDENED = 0.45;

/** The router call Uniswap built: 0.5 WOKB less the widened 0.45%. */
const ROUTER_CALL: SwapCalldata = { to: ROUTER, data: '0x1111', value: '0', minOut: 497_750_000_000_000_000n };

/** An OKX route that delivers more than Uniswap's floor. */
const OKX_BETTER: OkxRoute = {
  to: OKX_ROUTER,
  data: '0x2222',
  value: '0',
  spender: OKX_SPENDER,
  minOut: 498_500_000_000_000_000n,
  expectedOut: 500_750_000_000_000_000n,
};

beforeEach(() => {
  vi.mocked(quote).mockReset().mockResolvedValue(QUOTE);
  vi.mocked(buildSwap).mockReset().mockResolvedValue(ROUTER_CALL);
  vi.mocked(slippageFor).mockReset().mockReturnValue(WIDENED);
  vi.mocked(okxConfigured).mockReset().mockReturnValue(false);
  vi.mocked(okxRoute).mockReset().mockResolvedValue(OKX_BETTER);
  vi.mocked(viaWouldFill).mockReset().mockResolvedValue(true);
});

describe('best execution across venues (PLAN.md 3.20)', () => {
  it('without an OKX key, Uniswap settles alone and OKX is never asked', async () => {
    expect(await settle(buy())).toEqual({
      payToken: { address: USDC, decimals: 6 },
      swap: { to: ROUTER, data: '0x1111' },
      venue: 'uniswap-v3',
      floor: { tokenOut: WOKB, minOut: 497_750_000_000_000_000n },
    });
    expect(okxRoute).not.toHaveBeenCalled();
  });

  it("settles through OKX DEX when it is configured and its floor beats Uniswap's, carrying its approval contract", async () => {
    vi.mocked(okxConfigured).mockReturnValue(true);

    expect(await settle(buy())).toEqual({
      payToken: { address: USDC, decimals: 6 },
      swap: { to: OKX_ROUTER, data: '0x2222' },
      spender: OKX_SPENDER,
      venue: 'okx-dex',
      floor: { tokenOut: WOKB, minOut: 498_500_000_000_000_000n },
    });
    // $100 in USDC's six decimals, from the delegation to the owner, at the same tolerance Uniswap got.
    expect(okxRoute).toHaveBeenCalledWith({
      inSymbol: 'USDC',
      outSymbol: 'WOKB',
      amountRaw: 100_000_000n,
      from: DELEGATION,
      receiver: OWNER,
      slippagePct: WIDENED,
    });
  });

  it('keeps Uniswap when OKX delivers less, or only ties it', async () => {
    vi.mocked(okxConfigured).mockReturnValue(true);

    vi.mocked(okxRoute).mockResolvedValue({ ...OKX_BETTER, minOut: 497_000_000_000_000_000n });
    const worse = await settle(buy());
    expect(worse.venue).toBe('uniswap-v3');
    expect(worse.spender).toBeUndefined();

    vi.mocked(okxRoute).mockResolvedValue({ ...OKX_BETTER, minOut: ROUTER_CALL.minOut });
    expect((await settle(buy())).venue).toBe('uniswap-v3');
  });

  /*
   * OKX quotes mainnet. On the hosted fork its route runs through pools frozen at the fork block, and a floor set from
   * mainnet's price can be one the fork cannot meet: the contract reverts, and the order fails where Uniswap — quoted
   * on the fork itself — would have filled.
   */
  it('keeps Uniswap when the contract would not fill OKX\'s route here, however good its quote', async () => {
    vi.mocked(okxConfigured).mockReturnValue(true);
    vi.mocked(viaWouldFill).mockResolvedValue(false);

    const s = await settle(buy());
    expect(s.venue).toBe('uniswap-v3');
    expect(s.swap.to).toBe(ROUTER);
    expect(s.spender).toBeUndefined();
  });

  it('asks the contract with the exact call that would carry the route: its spender, venue, amount and floor', async () => {
    vi.mocked(okxConfigured).mockReturnValue(true);

    await settle(buy());
    expect(viaWouldFill).toHaveBeenCalledWith(
      expect.objectContaining({
        via: 'spend',
        owner: OWNER,
        spender: OKX_SPENDER,
        venue: OKX_ROUTER,
        data: OKX_BETTER.data,
        minOut: OKX_BETTER.minOut,
      }),
    );
  });

  it('treats an OKX route that cannot be built as no candidate', async () => {
    vi.mocked(okxConfigured).mockReturnValue(true);
    vi.mocked(okxRoute).mockRejectedValue(new Error('OKX DEX /swap refused: Insufficient liquidity'));

    const s = await settle(buy());
    expect(s.venue).toBe('uniswap-v3');
    expect(s.swap.to).toBe(ROUTER);
  });
});

describe('the legs around it', () => {
  it("fills through Uniswap from the delegation to the owner, at the router's floor, with the quote read first", async () => {
    await settle(buy());

    // The scheduled ceiling, widened by the impact the quote reported; that answer is the tolerance the router gets.
    expect(quote).toHaveBeenCalledWith({ inSymbol: 'USDC', outSymbol: 'WOKB', amount: 100 });
    expect(slippageFor).toHaveBeenCalledWith(0.3, 0.42);
    expect(buildSwap).toHaveBeenCalledWith({
      inSymbol: 'USDC',
      outSymbol: 'WOKB',
      amount: 100,
      amountRaw: undefined,
      from: DELEGATION,
      receiver: OWNER,
      slippagePct: WIDENED,
    });
    expect(vi.mocked(quote).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(buildSwap).mock.invocationCallOrder[0]!,
    );
  });

  it('without a quote, falls back to the urgency ceiling and still builds the route', async () => {
    vi.mocked(quote).mockRejectedValue(new Error('execution reverted'));

    const s = await settle(buy());

    expect(slippageFor).toHaveBeenCalledWith(0.3, null);
    expect(buildSwap).toHaveBeenCalledTimes(1);
    expect(s.venue).toBe('uniswap-v3');
  });

  it("fails with the router's own refusal when there is no route to build", async () => {
    vi.mocked(buildSwap).mockRejectedValue(new Error('No route for USDC -> WETH: WETH has no pool with liquidity on X Layer'));

    await expect(settle(buy())).rejects.toThrow('WETH has no pool with liquidity');
  });

  it('sends a direct leg to its own venue at its own floor, paying in its own in-token, and asks no quote and no venue', async () => {
    // Supplying $100 of idle USDT0 to Aave on X Layer: the calldata is the whole trade, and the aToken is what the owner
    // receives. The token `spend()` pulls is the intent's in-token — USDT0 — not the settlement token.
    const direct: NonNullable<TradeIntent['direct']> = {
      venue: AAVE_POOL,
      data: encodeFunctionData({
        abi: parseAbi(['function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)']),
        functionName: 'supply',
        args: [USDT0, 100_000_000n, OWNER, 0],
      }),
      unitPriceUsd: 1,
      tokenOut: A_USDT0,
      minOut: 99_990_000n,
    };
    vi.mocked(okxConfigured).mockReturnValue(true);

    const s = await settle(buy({ inSymbol: 'USDT0', outSymbol: 'aUSDT0', direct }));

    expect(s).toEqual({
      payToken: { address: USDT0, decimals: 6 },
      swap: { to: AAVE_POOL, data: direct.data },
      venue: 'aave',
      floor: { tokenOut: A_USDT0, minOut: 99_990_000n },
    });
    expect(quote).not.toHaveBeenCalled();
    expect(buildSwap).not.toHaveBeenCalled();
    expect(okxRoute).not.toHaveBeenCalled();
  });

  it('gives a close the stop ceiling widened by the quote, routed for what closePosition sends', async () => {
    vi.mocked(quote).mockResolvedValue({
      ...QUOTE,
      inSymbol: 'WOKB',
      outSymbol: 'USDC',
      inAmount: 0.5,
      outAmount: 99.7,
      minimumOut: 99.4009,
      priceImpactPct: 0.9,
    });
    vi.mocked(slippageFor).mockReturnValue(1.35);
    // 99.7 USDC less 1.35%.
    vi.mocked(buildSwap).mockResolvedValue({ ...ROUTER_CALL, minOut: 98_354_050n });
    // The whole position, in the wei the chain holds.
    const close: TradeIntent = {
      inSymbol: 'WOKB',
      outSymbol: 'USDC',
      amountIn: 0.5,
      amountInRaw: 500_000_000_000_000_008n,
      usd: 99.7,
      because: 'OKB fell through the stop.',
    };

    const s = await settle(close, { isClose: true, send: { via: 'closePosition', amount: 500_000_000_000_000_008n } });

    expect(quote).toHaveBeenCalledWith({ inSymbol: 'WOKB', outSymbol: 'USDC', amount: 0.5 });
    expect(slippageFor).toHaveBeenCalledWith(1, 0.9);
    expect(buildSwap).toHaveBeenCalledWith({
      inSymbol: 'WOKB',
      outSymbol: 'USDC',
      amount: 0.5,
      amountRaw: 500_000_000_000_000_008n,
      from: DELEGATION,
      receiver: OWNER,
      slippagePct: 1.35,
    });
    expect(s).toEqual({
      payToken: { address: WOKB, decimals: 18 },
      swap: { to: ROUTER, data: '0x1111' },
      venue: 'uniswap-v3',
      floor: { tokenOut: USDC, minOut: 98_354_050n },
    });
  });

  it('routes a partial close for exactly the wei the delegation sends, never a second scaling of the float', async () => {
    /*
     * A rebalance sells $10 of a token in coins worked out from dollars. Rounded to wei that float is one more than the
     * close floors it to, and a router built for the rounded figure pulls a wei more than the delegation approved.
     */
    const amountIn = 0.0030908927998572837;
    expect(BigInt(Math.round(amountIn * 1e18))).toBe(3_090_892_799_857_284n);
    const sends = 3_090_892_799_857_283n;
    vi.mocked(okxConfigured).mockReturnValue(true);
    const partial: TradeIntent = {
      inSymbol: 'WOKB',
      outSymbol: 'USDC',
      amountIn,
      usd: 10,
      because: 'OKB is 1.8% over its target weight.',
    };

    await settle(partial, { isClose: true, send: { via: 'closePosition', amount: sends } });

    expect(vi.mocked(buildSwap).mock.calls[0]![0]).toMatchObject({ amount: amountIn, amountRaw: sends });
    expect(vi.mocked(okxRoute).mock.calls[0]![0]).toMatchObject({ amountRaw: sends });
  });

  it("gives every venue the tolerance a person chose, in place of the executor's own (PLAN.md 3.9)", async () => {
    vi.mocked(okxConfigured).mockReturnValue(true);

    await settle(buy({ slippagePct: 0.5 }));

    expect(slippageFor).not.toHaveBeenCalled();
    expect(vi.mocked(buildSwap).mock.calls[0]![0]).toMatchObject({ slippagePct: 0.5 });
    expect(vi.mocked(okxRoute).mock.calls[0]![0]).toMatchObject({ slippagePct: 0.5 });
  });

  it('throws on a token with no registry entry, before any venue is asked', async () => {
    await expect(settle(buy({ inSymbol: 'DOGE' }))).rejects.toThrow('No token registry entry for DOGE');
    await expect(settle(buy({ outSymbol: 'DOGE' }))).rejects.toThrow('No token registry entry for DOGE');
    expect(quote).not.toHaveBeenCalled();
    expect(buildSwap).not.toHaveBeenCalled();
    expect(okxRoute).not.toHaveBeenCalled();
  });
});
