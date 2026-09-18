/**
 * Where a leg settles, with every venue stood in for (PLAN.md 3.8 and 3.20, and the test half of 3.4).
 *
 * `chooseSettlement` is best execution: every venue that can serve the leg says what it would deliver, and the leg
 * settles where the owner receives the most — a book when it pays at least the aggregator's quote, Aqua over SwapVM
 * on a tie — a direct leg to its own venue, and never a book on a close. These cases prove which builder is asked,
 * with what, which venue wins, and which floor the leg is held to, including that "route to 1inch" skips the books
 * only when an Aqua index gave that answer — and that on a fork the aggregator is measured by a dry run and held to
 * what its route delivers there (PLAN.md X77).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import type { AquaFill } from '../venues/aqua.js';
import type { SwapCalldata, SwapQuote } from '../venues/oneinch.js';
import type { SwapVmFill } from '../venues/swapvm.js';
import type { TradeIntent } from './kinds/index.js';
import type { SettlementSend } from './settle.js';

const TOKENS = vi.hoisted(
  () =>
    ({
      USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    }) as const,
);

vi.mock('../venues/oneinch.js', () => ({
  TOKENS,
  SLIPPAGE: { scheduled: 0.3, stop: 1, panic: 2 },
  // A spy: what settlement hands it, and that its answer is the tolerance the router gets, are the assertions.
  slippageFor: vi.fn(),
  quote: vi.fn(),
  buildSwap: vi.fn(),
}));
vi.mock('../venues/aqua.js', () => ({ buildAquaFill: vi.fn() }));
vi.mock('../venues/swapvm.js', () => ({ buildSwapVmFill: vi.fn() }));
vi.mock('../graph/aqua.js', () => ({ aquaIndexConfigured: vi.fn() }));
// Off a fork unless a case says otherwise: where 1inch's prices and the pools drift apart, the route is measured (PLAN.md X77).
const fork = vi.hoisted(() => ({ drifts: false }));
vi.mock('../evm/measure-route.js', () => ({
  get PRICES_DRIFT() {
    return fork.drifts;
  },
  deliveredOnChain: vi.fn(),
}));

const { buildSwap, quote, slippageFor } = await import('../venues/oneinch.js');
const { buildAquaFill } = await import('../venues/aqua.js');
const { buildSwapVmFill } = await import('../venues/swapvm.js');
const { aquaIndexConfigured } = await import('../graph/aqua.js');
const { deliveredOnChain } = await import('../evm/measure-route.js');
const { chooseSettlement } = await import('./settle.js');

const USDC = TOKENS.USDC.address;
const WETH = TOKENS.WETH.address;
/** The user whose capital is spent, and who receives what it buys. */
const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
/** Holds the tokens for the length of the venue call. */
const DELEGATION = '0x6c5528Fd8E74a047A85bAb413856A9239E73540e';
const ROUTER = '0x111111125421cA6dc452d289314280a0f8842A65';
const AQUA_BOOK = '0x74e1283711106a5844eb20760c7cb6405933c54f';
const SWAPVM_BOOK = '0x6cc8379b893d0239392720368f901b56c0f51e53';
const MAKER = '0x364d7Bbc139541e0e37450D527ae154B5C292581';
const AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
/** The receipt token a USDC supply mints. */
const A_USDC = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';

/** A scheduled buy: $100 of WETH, paid in USDC. */
const buy = (over: Partial<TradeIntent> = {}): TradeIntent => ({
  inSymbol: 'USDC',
  outSymbol: 'WETH',
  amountIn: 100,
  usd: 100,
  because: 'Scheduled buy of $100 of WETH.',
  ...over,
});

const settle = (intent: TradeIntent, opts: { preferred?: string; isClose?: boolean; send?: SettlementSend } = {}) =>
  chooseSettlement({
    intent,
    owner: OWNER,
    preferred: opts.preferred,
    isClose: opts.isClose ?? false,
    delegationFrom: DELEGATION,
    // What `spend()` would pull for the $100 buy; a case that measures a close says what it sells.
    send: opts.send ?? { via: 'spend', amount: 100_000_000n },
  });

/** What 1inch quoted for the buy: 0.04 WETH, 0.42% under the mid. */
const QUOTE: SwapQuote = {
  inSymbol: 'USDC',
  outSymbol: 'WETH',
  inAmount: 100,
  outAmount: 0.04,
  minimumOut: 0.03988,
  slippagePct: 0.3,
  venues: ['Uniswap V3'],
  route: 'Uniswap V3',
  priceImpactPct: 0.42,
  estimatedGas: 184_000,
};

/** A maker's book that pays more than the aggregator quotes: 0.0401 WETH, held to that less 0.3%. */
const AQUA_FILL: AquaFill = {
  token: USDC,
  venue: AQUA_BOOK,
  amount: 100_000_000n,
  data: '0xaaaa',
  quotedOut: 40_100_000_000_000_000n,
  tokenOut: WETH,
  minOut: 39_979_700_000_000_000n,
  strategy: {
    maker: MAKER,
    token0: WETH,
    token1: USDC,
    feeBps: 30n,
    maxDeviationBps: 200n,
    referencePrice: 2_500_000_000n,
    salt: `0x${'5a'.repeat(32)}`,
  },
  hash: `0x${'a1'.repeat(32)}`,
};

/** The same book, shallow: it can serve the size, but pays 0.03995 WETH — less than the aggregator's 0.04. */
const AQUA_SHORT: AquaFill = { ...AQUA_FILL, quotedOut: 39_950_000_000_000_000n, minOut: 39_830_150_000_000_000n };

/** A maker's SwapVM program: its dry run delivers 0.0402 WETH; its compiled floor is the quote less 0.3%. */
const SWAPVM_FILL: SwapVmFill = {
  token: USDC,
  venue: SWAPVM_BOOK,
  amount: 100_000_000n,
  data: '0x5555',
  tokenOut: WETH,
  order: { maker: MAKER, traits: 1n, data: '0xdeadbeef' },
  hash: `0x${'b2'.repeat(32)}`,
  minOut: 39_880_000_000_000_000n,
  expectedOut: 40_200_000_000_000_000n,
};

/** A recognisable tolerance: whatever the spy answers is what must reach the router. */
const WIDENED = 0.45;

/** The router call 1inch built: 0.04 WETH less the widened 0.45%. */
const ROUTER_CALL: SwapCalldata = { to: ROUTER, data: '0x1111', value: '0', minOut: 39_820_000_000_000_000n };

beforeEach(() => {
  vi.mocked(buildAquaFill).mockReset().mockResolvedValue(undefined);
  vi.mocked(buildSwapVmFill).mockReset().mockResolvedValue(undefined);
  vi.mocked(quote).mockReset().mockResolvedValue(QUOTE);
  vi.mocked(buildSwap).mockReset().mockResolvedValue(ROUTER_CALL);
  vi.mocked(slippageFor).mockReset().mockReturnValue(WIDENED);
  vi.mocked(aquaIndexConfigured).mockReset().mockReturnValue(false);
  vi.mocked(deliveredOnChain).mockReset();
  fork.drifts = false;
});

describe('best execution across venues (PLAN.md 3.20)', () => {
  it("settles through an Aqua book that delivers more than the aggregator quotes, held to the book's floor", async () => {
    vi.mocked(buildAquaFill).mockResolvedValue(AQUA_FILL);

    expect(await settle(buy())).toEqual({
      payToken: { address: USDC, decimals: 6 },
      swap: { to: AQUA_BOOK, data: '0xaaaa' },
      venue: 'aqua',
      floor: { tokenOut: WETH, minOut: 39_979_700_000_000_000n },
    });
    // $100 in USDC's six decimals, and the scheduled 0.3% as a fraction.
    expect(buildAquaFill).toHaveBeenCalledWith({
      owner: OWNER,
      tokenIn: USDC,
      tokenOut: WETH,
      amountIn: 100_000_000n,
      slippage: 0.003,
    });
    // The price it had to beat.
    expect(quote).toHaveBeenCalledWith({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100 });
    expect(buildSwap).not.toHaveBeenCalled();
  });

  it("takes the aggregator when a book can serve the size but delivers less than the aggregator's quote", async () => {
    vi.mocked(buildAquaFill).mockResolvedValue(AQUA_SHORT);

    expect(await settle(buy())).toEqual({
      payToken: { address: USDC, decimals: 6 },
      swap: { to: ROUTER, data: '0x1111' },
      venue: '1inch',
      floor: { tokenOut: WETH, minOut: 39_820_000_000_000_000n },
    });
    expect(slippageFor).toHaveBeenCalledWith(0.3, 0.42);
    expect(buildSwap).toHaveBeenCalledTimes(1);
  });

  it("settles through a SwapVM program whose dry run delivers the most, its floor priced from the quote in the output token's units", async () => {
    vi.mocked(buildAquaFill).mockResolvedValue(AQUA_FILL);
    vi.mocked(buildSwapVmFill).mockResolvedValue(SWAPVM_FILL);

    expect(await settle(buy())).toEqual({
      payToken: { address: USDC, decimals: 6 },
      swap: { to: SWAPVM_BOOK, data: '0x5555' },
      venue: 'swapvm',
      floor: { tokenOut: WETH, minOut: 39_880_000_000_000_000n },
    });
    // The 0.04 WETH quoted, in WETH's eighteen decimals — not USDC's six.
    expect(buildSwapVmFill).toHaveBeenCalledWith({
      owner: OWNER,
      tokenIn: USDC,
      tokenOut: WETH,
      amountIn: 100_000_000n,
      slippage: 0.003,
      quotedOut: 40_000_000_000_000_000n,
    });
    expect(buildSwap).not.toHaveBeenCalled();
  });

  it('lets a book keep a tie with the aggregator, and Aqua keep a tie with SwapVM', async () => {
    vi.mocked(buildAquaFill).mockResolvedValue({ ...AQUA_FILL, quotedOut: 40_000_000_000_000_000n });
    expect((await settle(buy())).venue).toBe('aqua');

    vi.mocked(buildAquaFill).mockResolvedValue(AQUA_FILL);
    vi.mocked(buildSwapVmFill).mockResolvedValue({ ...SWAPVM_FILL, expectedOut: AQUA_FILL.quotedOut });
    expect((await settle(buy())).venue).toBe('aqua');
    expect(buildSwap).not.toHaveBeenCalled();
  });

  it('holds a program whose dry run returned nothing to read to its floor, which the aggregator beats', async () => {
    vi.mocked(buildSwapVmFill).mockResolvedValue({ ...SWAPVM_FILL, expectedOut: undefined });

    expect((await settle(buy())).venue).toBe('1inch');
  });
});

describe('the legs around it', () => {
  it("with neither book serving, the aggregator fills from the delegation to the owner, at the router's floor", async () => {
    expect(await settle(buy())).toEqual({
      payToken: { address: USDC, decimals: 6 },
      swap: { to: ROUTER, data: '0x1111' },
      venue: '1inch',
      floor: { tokenOut: WETH, minOut: 39_820_000_000_000_000n },
    });
    // The scheduled ceiling, widened by the impact the quote reported; that answer is the tolerance the router gets.
    expect(slippageFor).toHaveBeenCalledWith(0.3, 0.42);
    expect(buildSwap).toHaveBeenCalledWith({
      inSymbol: 'USDC',
      outSymbol: 'WETH',
      amount: 100,
      amountRaw: undefined,
      from: DELEGATION,
      receiver: OWNER,
      slippagePct: WIDENED,
    });
    // Both books were asked, after the quote they are held against; the router is built only once neither wins.
    expect(buildAquaFill).toHaveBeenCalledTimes(1);
    expect(buildSwapVmFill).toHaveBeenCalledTimes(1);
    const [quoted] = vi.mocked(quote).mock.invocationCallOrder;
    const [built] = vi.mocked(buildSwap).mock.invocationCallOrder;
    expect(quoted).toBeLessThan(vi.mocked(buildSwapVmFill).mock.invocationCallOrder[0]!);
    expect(built).toBeGreaterThan(vi.mocked(buildAquaFill).mock.invocationCallOrder[0]!);
  });

  it('without a quote, takes a book that serves — its own quote is real — and never asks SwapVM', async () => {
    vi.mocked(quote).mockRejectedValue(new Error('429 after 5 attempts'));
    vi.mocked(buildAquaFill).mockResolvedValue(AQUA_SHORT);

    expect((await settle(buy())).venue).toBe('aqua');
    expect(buildSwapVmFill).not.toHaveBeenCalled();
    expect(buildSwap).not.toHaveBeenCalled();
  });

  it('without a quote or a book, the aggregator falls back to the urgency ceiling', async () => {
    vi.mocked(quote).mockRejectedValue(new Error('429 after 5 attempts'));

    const s = await settle(buy());

    expect(buildSwapVmFill).not.toHaveBeenCalled();
    expect(slippageFor).toHaveBeenCalledWith(0.3, null);
    expect(s.venue).toBe('1inch');
  });

  it('treats a book whose builder throws as not served', async () => {
    vi.mocked(buildAquaFill).mockRejectedValue(new Error('execution reverted: EmptyBook()'));
    vi.mocked(buildSwapVmFill).mockResolvedValue(SWAPVM_FILL);
    expect((await settle(buy())).venue).toBe('swapvm');

    vi.mocked(buildSwapVmFill).mockRejectedValue(new Error('fetch failed'));
    expect((await settle(buy())).venue).toBe('1inch');
    expect(buildSwap).toHaveBeenCalledTimes(1);
  });

  it('sends a direct leg to its own venue at its own floor, and asks no quote, no book and no aggregator', async () => {
    // Supplying $100 of idle USDC to Aave: the calldata is the whole trade, and the aToken is what the owner receives.
    const direct: NonNullable<TradeIntent['direct']> = {
      venue: AAVE_POOL,
      data: encodeFunctionData({
        abi: parseAbi(['function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)']),
        functionName: 'supply',
        args: [USDC, 100_000_000n, OWNER, 0],
      }),
      unitPriceUsd: 1,
      tokenOut: A_USDC,
      minOut: 99_990_000n,
    };

    const s = await settle(buy({ outSymbol: 'aUSDC', direct }));

    expect(s).toEqual({
      payToken: { address: USDC, decimals: 6 },
      swap: { to: AAVE_POOL, data: direct.data },
      venue: 'aave',
      floor: { tokenOut: A_USDC, minOut: 99_990_000n },
    });
    expect(quote).not.toHaveBeenCalled();
    expect(buildAquaFill).not.toHaveBeenCalled();
    expect(buildSwapVmFill).not.toHaveBeenCalled();
    expect(buildSwap).not.toHaveBeenCalled();
  });

  it('never tries a book on a close, and gives the aggregator the stop ceiling widened by the quote', async () => {
    // Books that WOULD win, and an index recommending one: a close still does not ask them.
    vi.mocked(buildAquaFill).mockResolvedValue(AQUA_FILL);
    vi.mocked(buildSwapVmFill).mockResolvedValue(SWAPVM_FILL);
    vi.mocked(quote).mockResolvedValue({
      ...QUOTE,
      inSymbol: 'WETH',
      outSymbol: 'USDC',
      inAmount: 0.04,
      outAmount: 99.7,
      minimumOut: 99.4009,
      priceImpactPct: 0.9,
    });
    vi.mocked(slippageFor).mockReturnValue(1.35);
    // 99.7 USDC less 1.35%.
    vi.mocked(buildSwap).mockResolvedValue({ ...ROUTER_CALL, minOut: 98_354_050n });
    // The whole position, in the wei the chain holds.
    const close: TradeIntent = {
      inSymbol: 'WETH',
      outSymbol: 'USDC',
      amountIn: 0.04,
      amountInRaw: 40_000_000_000_000_008n,
      usd: 99.7,
      because: 'WETH fell through the stop.',
    };

    const s = await settle(close, { preferred: 'aqua', isClose: true });

    expect(buildAquaFill).not.toHaveBeenCalled();
    expect(buildSwapVmFill).not.toHaveBeenCalled();
    expect(quote).toHaveBeenCalledWith({ inSymbol: 'WETH', outSymbol: 'USDC', amount: 0.04 });
    expect(slippageFor).toHaveBeenCalledWith(1, 0.9);
    expect(buildSwap).toHaveBeenCalledWith({
      inSymbol: 'WETH',
      outSymbol: 'USDC',
      amount: 0.04,
      amountRaw: 40_000_000_000_000_008n,
      from: DELEGATION,
      receiver: OWNER,
      slippagePct: 1.35,
    });
    expect(s).toEqual({
      payToken: { address: WETH, decimals: 18 },
      swap: { to: ROUTER, data: '0x1111' },
      venue: '1inch',
      floor: { tokenOut: USDC, minOut: 98_354_050n },
    });
  });

  it("gives every venue the tolerance a person chose, in place of the executor's own (PLAN.md 3.9)", async () => {
    await settle(buy({ slippagePct: 0.5 }));

    expect(vi.mocked(buildAquaFill).mock.calls[0]![0]).toMatchObject({ slippage: 0.005 });
    expect(vi.mocked(buildSwapVmFill).mock.calls[0]![0]).toMatchObject({ slippage: 0.005 });
    expect(slippageFor).not.toHaveBeenCalled();
    expect(vi.mocked(buildSwap).mock.calls[0]![0]).toMatchObject({ slippagePct: 0.5 });
  });

  it('throws on an input token with no registry entry, before any venue is asked', async () => {
    await expect(settle(buy({ inSymbol: 'DOGE' }))).rejects.toThrow('No token registry entry for DOGE');
    expect(buildAquaFill).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
    expect(buildSwapVmFill).not.toHaveBeenCalled();
    expect(buildSwap).not.toHaveBeenCalled();
  });
});

describe('on a fork, where 1inch prices Base and the pools hold their fork block (PLAN.md X77)', () => {
  /** What the route really delivers on the fork: 0.0395 WETH, under the 0.04 1inch quotes on Base. */
  const DELIVERED = 39_500_000_000_000_000n;
  const REFUSED = 'execution reverted: ReturnAmountIsNotEnough(5927798290791051)';

  beforeEach(() => {
    fork.drifts = true;
    vi.mocked(deliveredOnChain).mockResolvedValue(DELIVERED);
  });

  it('holds the aggregator to what its route delivers on the fork, less the tolerance, not to the quote', async () => {
    const s = await settle(buy());

    // 0.0395 WETH less the widened 0.45%.
    expect(s).toEqual({
      payToken: { address: USDC, decimals: 6 },
      swap: { to: ROUTER, data: '0x1111' },
      venue: '1inch',
      floor: { tokenOut: WETH, minOut: 39_322_250_000_000_000n },
    });
    // Built once, at the leg's tolerance, and measured through the call that will carry it, as it will be sent.
    expect(buildSwap).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildSwap).mock.calls[0]![0]).toMatchObject({ slippagePct: WIDENED });
    expect(slippageFor).toHaveBeenCalledTimes(1);
    expect(deliveredOnChain).toHaveBeenCalledWith({
      owner: OWNER,
      via: 'spend',
      token: USDC,
      venue: ROUTER,
      amount: 100_000_000n,
      tokenOut: WETH,
      data: '0x1111',
    });
  });

  it('holds a book against what the route delivers there: under the quote, but over the route, a book wins', async () => {
    // 0.03995 WETH: less than the 0.04 quoted on Base, more than the 0.0395 the route delivers on the fork.
    vi.mocked(buildAquaFill).mockResolvedValue(AQUA_SHORT);

    expect((await settle(buy())).venue).toBe('aqua');
  });

  it("prices SwapVM's floor from what the route delivers on the fork", async () => {
    vi.mocked(buildSwapVmFill).mockResolvedValue(SWAPVM_FILL);

    await settle(buy());

    expect(vi.mocked(buildSwapVmFill).mock.calls[0]![0]).toMatchObject({ quotedOut: DELIVERED });
  });

  it("measures a close through closePosition(), in the sold token's own units, and holds it to that less its tolerance", async () => {
    vi.mocked(deliveredOnChain).mockResolvedValue(99_000_000n);
    vi.mocked(slippageFor).mockReturnValue(1.35);
    const close: TradeIntent = {
      inSymbol: 'WETH',
      outSymbol: 'USDC',
      amountIn: 0.04,
      amountInRaw: 40_000_000_000_000_008n,
      usd: 99.7,
      because: 'WETH fell through the stop.',
    };

    const s = await settle(close, { isClose: true, send: { via: 'closePosition', amount: 40_000_000_000_000_008n } });

    expect(deliveredOnChain).toHaveBeenCalledWith(
      expect.objectContaining({ via: 'closePosition', token: WETH, amount: 40_000_000_000_000_008n, tokenOut: USDC }),
    );
    // 99 USDC less 1.35%.
    expect(s.floor).toEqual({ tokenOut: USDC, minOut: 97_663_500n });
  });

  it('routes a partial close for exactly the wei the delegation sends, never a second scaling of the float', async () => {
    /*
     * A rebalance sells $10 of WETH in coins worked out from dollars. Rounded to wei that float is one more than the
     * close floors it to, and a router built for the rounded figure pulled a wei more than the delegation had approved:
     * SafeTransferFromFailed on the fork (2026-09-15), in 42% of such sales.
     */
    const amountIn = 0.0030908927998572837;
    expect(BigInt(Math.round(amountIn * 1e18))).toBe(3_090_892_799_857_284n);
    const sends = 3_090_892_799_857_283n;
    vi.mocked(deliveredOnChain).mockResolvedValue(9_900_000n);
    const partial: TradeIntent = {
      inSymbol: 'WETH',
      outSymbol: 'USDC',
      amountIn,
      usd: 10,
      because: 'WETH is 1.8% over its target weight.',
    };

    await settle(partial, { isClose: true, send: { via: 'closePosition', amount: sends } });

    expect(vi.mocked(buildSwap).mock.calls[0]![0]).toMatchObject({ amount: amountIn, amountRaw: sends });
    expect(deliveredOnChain).toHaveBeenCalledWith(expect.objectContaining({ via: 'closePosition', amount: sends }));
  });

  it('takes a book that serves when the route cannot run on the fork, whatever the quote says', async () => {
    vi.mocked(deliveredOnChain).mockRejectedValue(new Error(REFUSED));
    vi.mocked(buildAquaFill).mockResolvedValue({ ...AQUA_SHORT, quotedOut: 30_000_000_000_000_000n });

    expect((await settle(buy())).venue).toBe('aqua');
  });

  it("fails with the chain's own refusal when the route cannot run and no book serves", async () => {
    vi.mocked(deliveredOnChain).mockRejectedValue(new Error(REFUSED));

    await expect(settle(buy())).rejects.toThrow('ReturnAmountIsNotEnough');
  });

  it('measures nothing for a direct leg, and nothing off a fork', async () => {
    const direct: NonNullable<TradeIntent['direct']> = {
      venue: AAVE_POOL,
      data: '0x617ba037',
      unitPriceUsd: 1,
      tokenOut: A_USDC,
      minOut: 99_990_000n,
    };
    expect((await settle(buy({ outSymbol: 'aUSDC', direct }))).venue).toBe('aave');
    expect(deliveredOnChain).not.toHaveBeenCalled();

    fork.drifts = false;
    await settle(buy());
    expect(deliveredOnChain).not.toHaveBeenCalled();
  });
});

describe('"route to 1inch" skips the books only when an Aqua index gave that answer (PLAN.md 3.4)', () => {
  it('skips both books when the Aqua index is configured', async () => {
    vi.mocked(aquaIndexConfigured).mockReturnValue(true);
    vi.mocked(buildAquaFill).mockResolvedValue(AQUA_FILL);
    vi.mocked(buildSwapVmFill).mockResolvedValue(SWAPVM_FILL);

    const s = await settle(buy(), { preferred: '1inch' });

    expect(buildAquaFill).not.toHaveBeenCalled();
    expect(buildSwapVmFill).not.toHaveBeenCalled();
    expect(s.venue).toBe('1inch');
    expect(s.floor).toEqual({ tokenOut: WETH, minOut: 39_820_000_000_000_000n });
  });

  it('still asks Aqua when no Aqua index is configured, and a book there wins', async () => {
    vi.mocked(buildAquaFill).mockResolvedValue(AQUA_FILL);

    const s = await settle(buy(), { preferred: '1inch' });

    expect(buildAquaFill).toHaveBeenCalledTimes(1);
    expect(s.venue).toBe('aqua');
    expect(buildSwap).not.toHaveBeenCalled();
  });

  it('still asks SwapVM when no Aqua index is configured, and a program there wins', async () => {
    vi.mocked(buildSwapVmFill).mockResolvedValue(SWAPVM_FILL);

    const s = await settle(buy(), { preferred: '1inch' });

    expect(buildSwapVmFill).toHaveBeenCalledTimes(1);
    expect(s.venue).toBe('swapvm');
    expect(buildSwap).not.toHaveBeenCalled();
  });

  it('leaves the books in play for any other recommendation, with or without an index', async () => {
    vi.mocked(aquaIndexConfigured).mockReturnValue(true);
    vi.mocked(buildAquaFill).mockResolvedValue(AQUA_FILL);

    expect((await settle(buy(), { preferred: 'aqua' })).venue).toBe('aqua');
    expect((await settle(buy(), { preferred: undefined })).venue).toBe('aqua');
    expect(buildAquaFill).toHaveBeenCalledTimes(2);
  });
});
