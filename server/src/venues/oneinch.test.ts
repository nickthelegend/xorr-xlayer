/**
 * The 1inch client, with the network stood in for (PLAN.md 3.8).
 *
 * `oneinch.live.test.ts` proves 1inch answers; this proves what the client ASKS and what it makes of the answer. The
 * query strings `quote` and `buildSwap` send — tokens by address, the amount in base units, the AMM-only restriction
 * on a fork and never on real Base, the key as a bearer token — and the output, floor, venues and price impact read
 * back from Swap API v6 responses. A chain with nothing to settle on refuses a fill before any request is made.
 *
 * The module reads its key and the chain at import, and refuses to load without a key, so each case loads it fresh
 * after setting the environment it needs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainKey } from '../evm/chains.js';

const h = vi.hoisted(() => ({ getJson: vi.fn(), priceOf: vi.fn() }));

// The client's one way onto the network. What it is handed is the assertion; what it answers is set per case.
vi.mock('../http/get.js', () => ({ getJson: h.getJson }));
// The independent mid that price impact is measured against.
vi.mock('../market/prices.js', () => ({ priceOf: h.priceOf }));
// `stocks.ts` reaches the database only to price an equity, which nothing here asks it to.
vi.mock('../db/index.js', () => ({ query: vi.fn() }));

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const NVDAC = '0xb20000000000000000000078ee7ce2fE4908108C';
const ROUTER = '0x111111125421cA6dc452d289314280a0f8842A65';
/** Holds the tokens while the swap executes. */
const DELEGATION = '0x6c5528Fd8E74a047A85bAb413856A9239E73540e';
/** Receives what the swap buys. */
const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615';
const PARTIES = { from: DELEGATION, receiver: OWNER } as const;

const API = 'https://api.1inch.dev/swap/v6.0/8453';
const AUTH = { Authorization: 'Bearer test-key' };

/** The AMMs a fork may route through, in the order the client names them. */
const FORK_AMMS = [
  'BASE_UNISWAP_V2',
  'BASE_UNISWAP_V3',
  'BASE_UNISWAP_V4',
  'BASE_AERODROME',
  'BASE_AERODROME_V3',
  'BASE_AERODROME_SLIPSTREAM',
  'BASE_PANCAKESWAP_V2',
  'BASE_PANCAKESWAP_V3',
  'BASE_SUSHI_V2',
  'BASE_SUSHI_V3',
  'BASE_SOLIDLY_V3',
  'BASE_BALANCER_V2',
  'BASE_CURVE',
];
const AMM_ONLY = `&complexityLevel=0&mainRouteParts=1&parts=1&protocols=${FORK_AMMS.join(',')}`;

const SWAP_DATA = '0x07ed2379000000000000000000000000de9e4fe32b049f821c7f3e9802381aa470ffca73';

/** Load the client as a process started with `XORR_CHAIN=<chain>` would. */
async function load(chain: ChainKey) {
  vi.resetModules();
  vi.stubEnv('ONEINCH_API_KEY', 'test-key');
  vi.stubEnv('XORR_CHAIN', chain);
  // `chains.ts` refuses real Base without a deliberate opt-in.
  vi.stubEnv('ALLOW_MAINNET', chain === 'base' ? 'yes' : '');
  return import('./oneinch.js');
}

/** A `/quote` answer: `dstAmount` in raw OUT units, protocols as routes → hops → parts, and the gas asked for. */
function quoteResponse(dstAmount: string, over: Record<string, unknown> = {}) {
  return {
    dstAmount,
    protocols: [
      [[{ name: 'BASE_UNISWAP_V3', part: 60, fromTokenAddress: USDC.toLowerCase(), toTokenAddress: WETH }]],
      [[{ name: 'BASE_AERODROME_SLIPSTREAM', part: 40, fromTokenAddress: USDC.toLowerCase(), toTokenAddress: WETH }]],
    ],
    gas: 184_000,
    ...over,
  };
}

/** A `/swap` answer: what the route expects to deliver, and the router call. */
function swapResponse(dstAmount: string | undefined) {
  return {
    ...(dstAmount === undefined ? {} : { dstAmount }),
    tx: { from: DELEGATION, to: ROUTER, data: SWAP_DATA, value: '0', gas: 0, gasPrice: '8521000' },
  };
}

/** The URL of the nth request the client made, and its query parameters. */
const requested = (n = 0) => h.getJson.mock.calls[n]![0] as string;
const paramsOf = (n = 0) => new URL(requested(n)).searchParams;

/** A price feed: dollars per token. */
const MID: Record<string, number> = { USDC: 1, WETH: 2_500 };

beforeEach(() => {
  h.getJson.mockReset();
  // No feed unless a case supplies one — impact is then null, not an error.
  h.priceOf.mockReset().mockRejectedValue(new Error('no price feed in this case'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('what a quote asks 1inch', () => {
  it('names both tokens by address, sends the amount in base units, and asks for the route and its gas', async () => {
    const { quote } = await load('base');
    h.getJson.mockResolvedValue(quoteResponse('40000000000000000'));

    await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, skipPriceImpact: true });

    expect(h.getJson).toHaveBeenCalledTimes(1);
    expect(h.getJson).toHaveBeenCalledWith(
      `${API}/quote?src=${USDC}&dst=${WETH}&amount=100000000&includeProtocols=true&includeGas=true`,
      15_000,
      15_000,
      AUTH,
    );
  });

  it('scales the amount by the decimals of the token being spent', async () => {
    const { quote } = await load('base');
    h.getJson.mockResolvedValue(quoteResponse('2500000000'));
    const cases = [
      { inSymbol: 'WETH', amount: 1.5, src: WETH, raw: '1500000000000000000' },
      { inSymbol: 'ETH', amount: 0.1, src: ETH, raw: '100000000000000000' },
      { inSymbol: 'CBBTC', amount: 0.25, src: CBBTC, raw: '25000000' },
      { inSymbol: 'NVDAc', amount: 0.5, src: NVDAC, raw: '50000000' },
    ];

    for (const [i, c] of cases.entries()) {
      await quote({ inSymbol: c.inSymbol, outSymbol: 'USDC', amount: c.amount, skipPriceImpact: true });
      expect(paramsOf(i).get('src'), c.inSymbol).toBe(c.src);
      expect(paramsOf(i).get('dst'), c.inSymbol).toBe(USDC);
      expect(paramsOf(i).get('amount'), c.inSymbol).toBe(c.raw);
    }
  });

  it("resolves the caller's casing at the boundary and reports the registry spelling", async () => {
    const { quote } = await load('base');
    h.getJson.mockResolvedValue(quoteResponse('138504155'));

    const q = await quote({ inSymbol: 'usdc', outSymbol: 'NVDAC', amount: 250, skipPriceImpact: true });

    expect(paramsOf().get('src')).toBe(USDC);
    expect(paramsOf().get('dst')).toBe(NVDAC);
    expect(paramsOf().get('amount')).toBe('250000000');
    expect(q.inSymbol).toBe('USDC');
    expect(q.outSymbol).toBe('NVDAc');
    // Read back in the equity's eight decimals.
    expect(q.outAmount).toBe(1.38504155);
  });

  it('refuses a symbol with no registry entry before asking anything', async () => {
    const { quote } = await load('base');
    await expect(quote({ inSymbol: 'USDC', outSymbol: 'DOGE', amount: 1 })).rejects.toThrow('No route for USDC -> DOGE');
    expect(h.getJson).not.toHaveBeenCalled();
  });
});

describe('what a quote returns', () => {
  it("reads dstAmount in the output token's decimals and shows the floor at the default 0.3%", async () => {
    const { quote } = await load('base');
    h.getJson.mockResolvedValue(quoteResponse('39600000000000000'));

    expect(await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, skipPriceImpact: true })).toEqual({
      inSymbol: 'USDC',
      outSymbol: 'WETH',
      inAmount: 100,
      outAmount: 0.0396,
      minimumOut: 0.0394812,
      slippagePct: 0.3,
      venues: ['Uniswap V3', 'Aerodrome Slipstream'],
      route: 'Best of 2 venues',
      estimatedGas: 184_000,
      priceImpactPct: null,
    });
  });

  it('applies the slippage the caller passes to the floor it shows', async () => {
    const { quote } = await load('base');
    h.getJson.mockResolvedValue(quoteResponse('2480000000'));

    const q = await quote({ inSymbol: 'WETH', outSymbol: 'USDC', amount: 1, slippagePct: 1, skipPriceImpact: true });

    expect(q.outAmount).toBe(2_480);
    expect(q.minimumOut).toBe(2_455.2);
    expect(q.slippagePct).toBe(1);
  });

  it('names a single venue, calls an empty route "Direct", and leaves a missing or zero gas estimate undefined', async () => {
    const { quote } = await load('base');
    h.getJson
      .mockResolvedValueOnce({
        dstAmount: '40000000000000000',
        protocols: [[[{ name: 'BASE_UNISWAP_V4', part: 100, fromTokenAddress: USDC.toLowerCase(), toTokenAddress: WETH }]]],
      })
      .mockResolvedValueOnce({ dstAmount: '40000000000000000', protocols: [], gas: 0 });

    const one = await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, skipPriceImpact: true });
    expect(one.venues).toEqual(['Uniswap V4']);
    expect(one.route).toBe('Uniswap V4');
    expect(one.estimatedGas).toBeUndefined();

    const none = await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, skipPriceImpact: true });
    expect(none.venues).toEqual([]);
    expect(none.route).toBe('Direct');
    expect(none.estimatedGas).toBeUndefined();
  });
});

describe('price impact on a quote', () => {
  it('is measured against the price feed mid for both legs, under a four-second deadline', async () => {
    const { quote } = await load('base');
    h.getJson.mockResolvedValue(quoteResponse('39600000000000000'));
    h.priceOf.mockImplementation(async (symbol: string) => MID[symbol]);

    // 100 USDC is 0.04 WETH at mid; the route delivers 0.0396, one percent short.
    const q = await quote({ inSymbol: 'usdc', outSymbol: 'weth', amount: 100 });

    expect(q.priceImpactPct).toBeCloseTo(1, 10);
    expect(h.priceOf.mock.calls).toEqual([
      ['USDC', 4_000],
      ['WETH', 4_000],
    ]);
  });

  it('is zero, not negative, when the route beats the mid', async () => {
    const { quote } = await load('base');
    h.getJson.mockResolvedValue(quoteResponse('40400000000000000'));
    h.priceOf.mockImplementation(async (symbol: string) => MID[symbol]);

    expect((await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100 })).priceImpactPct).toBe(0);
  });

  it('is null — not zero — when either leg has no usable price', async () => {
    const { quote } = await load('base');
    h.getJson.mockResolvedValue(quoteResponse('39600000000000000'));

    h.priceOf.mockImplementation(async (symbol: string) => {
      if (symbol === 'WETH') throw new Error('price deadline for WETH');
      return 1;
    });
    expect((await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100 })).priceImpactPct).toBeNull();

    h.priceOf.mockImplementation(async (symbol: string) => (symbol === 'USDC' ? 1 : 0));
    expect((await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100 })).priceImpactPct).toBeNull();
  });

  it('is not measured when the caller is establishing the price itself', async () => {
    const { quote } = await load('base');
    h.getJson.mockResolvedValue(quoteResponse('39600000000000000'));
    h.priceOf.mockImplementation(async (symbol: string) => MID[symbol]);

    expect((await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, skipPriceImpact: true })).priceImpactPct).toBeNull();
    expect(h.priceOf).not.toHaveBeenCalled();
  });

  it('is not measured when the route delivers nothing', async () => {
    const { quote } = await load('base');
    h.getJson.mockResolvedValue(quoteResponse('0'));
    h.priceOf.mockImplementation(async (symbol: string) => MID[symbol]);

    const q = await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100 });

    expect(q.priceImpactPct).toBeNull();
    expect(q.minimumOut).toBe(0);
    expect(h.priceOf).not.toHaveBeenCalled();
  });
});

describe('the AMM-only restriction', () => {
  it('restricts a fork quote to one unsplit route through the named AMMs', async () => {
    const { quote } = await load('base-fork');
    h.getJson.mockResolvedValue(quoteResponse('40000000000000000'));

    await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, skipPriceImpact: true });

    expect(requested()).toBe(
      `${API}/quote?src=${USDC}&dst=${WETH}&amount=100000000&includeProtocols=true&includeGas=true${AMM_ONLY}`,
    );
    // The venue that routes equities is a solver a fork cannot reproduce, and is left out on purpose.
    expect(paramsOf().get('protocols')).not.toContain('ELFOMOFI');
  });

  it('restricts a fork fill exactly as its quote, so the price shown is the price attempted', async () => {
    const { buildSwap } = await load('base-fork');
    h.getJson.mockResolvedValue(swapResponse('40000000000000000'));

    await buildSwap({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, ...PARTIES });

    // The router's own slippage is the widest 1inch accepts on a fork (PLAN.md X77); the floor keeps the tolerance.
    expect(h.getJson).toHaveBeenCalledWith(
      `${API}/swap?src=${USDC}&dst=${WETH}&amount=100000000&from=${DELEGATION}&origin=${DELEGATION}` +
        `&receiver=${OWNER}&slippage=50&disableEstimate=true${AMM_ONLY}`,
      15_000,
      15_000,
      AUTH,
    );
  });

  it('asks real Base for the unrestricted route, on the quote and on the fill', async () => {
    const { quote, buildSwap } = await load('base');
    h.getJson
      .mockResolvedValueOnce(quoteResponse('40000000000000000'))
      .mockResolvedValueOnce(swapResponse('40000000000000000'));

    await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, skipPriceImpact: true });
    await buildSwap({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, ...PARTIES });

    expect(requested(0)).toContain('/quote?');
    expect(requested(1)).toContain('/swap?');
    for (const call of [0, 1]) {
      for (const key of ['complexityLevel', 'mainRouteParts', 'parts', 'protocols']) {
        expect(paramsOf(call).has(key), `${key} on request ${call}`).toBe(false);
      }
    }
  });

  it('restricts quotes on the local Sepolia fork too, and not on Base Sepolia', async () => {
    for (const [chain, restricted] of [
      ['localnet', true],
      ['base-sepolia', false],
    ] as const) {
      const { quote } = await load(chain);
      h.getJson.mockReset().mockResolvedValue(quoteResponse('40000000000000000'));

      await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, skipPriceImpact: true });

      expect(requested().endsWith(AMM_ONLY), chain).toBe(restricted);
      expect(paramsOf().has('protocols'), chain).toBe(restricted);
    }
  });
});

describe('the API key', () => {
  it('is required to load the client at all — there is no offline fallback to route through', async () => {
    vi.resetModules();
    vi.stubEnv('ONEINCH_API_KEY', '');
    vi.stubEnv('XORR_CHAIN', 'base-fork');
    await expect(import('./oneinch.js')).rejects.toThrow('ONEINCH_API_KEY is required');
  });
});

describe('what a fill asks 1inch', () => {
  it('is sent from the delegation, delivered to the owner, at the slippage it was given, with the key', async () => {
    const { buildSwap } = await load('base');
    h.getJson.mockResolvedValue(swapResponse('40000000000000000'));

    await buildSwap({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, slippagePct: 1.2, ...PARTIES });

    expect(h.getJson).toHaveBeenCalledTimes(1);
    expect(h.getJson).toHaveBeenCalledWith(
      `${API}/swap?src=${USDC}&dst=${WETH}&amount=100000000&from=${DELEGATION}&origin=${DELEGATION}` +
        `&receiver=${OWNER}&slippage=1.2&disableEstimate=true`,
      15_000,
      15_000,
      AUTH,
    );
  });

  it('sends amountRaw verbatim instead of rescaling the float', async () => {
    const { buildSwap } = await load('base');
    h.getJson.mockResolvedValue(swapResponse('308641975'));
    // A whole-position close: the chain's own wei figure, which the float cannot represent.
    const amount = 0.123456789012345678;
    const amountRaw = 123_456_789_012_345_671n;
    expect(BigInt(Math.round(amount * 1e18))).not.toBe(amountRaw);

    await buildSwap({ inSymbol: 'WETH', outSymbol: 'USDC', amount, amountRaw, ...PARTIES });

    expect(paramsOf().get('amount')).toBe('123456789012345671');
  });

  it("resolves an equity's casing at the boundary and scales by its eight decimals", async () => {
    const { buildSwap } = await load('base');
    h.getJson.mockResolvedValue(swapResponse('90250000'));

    await buildSwap({ inSymbol: 'nvdac', outSymbol: 'usdc', amount: 0.5, ...PARTIES });

    expect(paramsOf().get('src')).toBe(NVDAC);
    expect(paramsOf().get('dst')).toBe(USDC);
    expect(paramsOf().get('amount')).toBe('50000000');
  });

  it('refuses a symbol with no registry entry before asking anything', async () => {
    const { buildSwap } = await load('base');
    await expect(buildSwap({ inSymbol: 'USDC', outSymbol: 'DOGE', amount: 1, ...PARTIES })).rejects.toThrow(
      'No route for USDC -> DOGE',
    );
    expect(h.getJson).not.toHaveBeenCalled();
  });
});

describe('what a fill returns', () => {
  it('is the router call, with a floor of dstAmount less the slippage in raw output units', async () => {
    const { buildSwap } = await load('base-fork');
    h.getJson.mockResolvedValue(swapResponse('40000000000000000'));

    const tx = await buildSwap({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, ...PARTIES });

    // 0.04 WETH less the default 0.3%.
    expect(tx).toMatchObject({ to: ROUTER, data: SWAP_DATA, value: '0', minOut: 39_880_000_000_000_000n });
  });

  it('on a fork, asks the router for the widest slippage 1inch accepts and still holds the floor to the tolerance given (PLAN.md X77)', async () => {
    const { buildSwap, FORK_ROUTER_SLIPPAGE_PCT } = await load('base-fork');
    h.getJson.mockResolvedValue(swapResponse('40000000000000000'));

    const tx = await buildSwap({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, slippagePct: 1.2, ...PARTIES });

    expect(FORK_ROUTER_SLIPPAGE_PCT).toBe(50);
    expect(paramsOf().get('slippage')).toBe('50');
    // 0.04 WETH less the 1.2% it was given, not less 50%.
    expect(tx.minOut).toBe(39_520_000_000_000_000n);
  });

  it('lowers the floor by exactly the wider tolerance it was given', async () => {
    const { buildSwap } = await load('base');
    h.getJson.mockResolvedValue(swapResponse('40000000000000000'));

    const tx = await buildSwap({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, slippagePct: 1.2, ...PARTIES });

    expect(tx.minOut).toBe(39_520_000_000_000_000n);
  });

  it('rounds the floor down to a whole raw unit', async () => {
    const { buildSwap } = await load('base');
    h.getJson.mockResolvedValue(swapResponse('2481234567'));

    const tx = await buildSwap({ inSymbol: 'WETH', outSymbol: 'USDC', amount: 1, ...PARTIES });

    // 2,481.234567 USDC less 0.3% is 2,473.790863299 — the floor is the unit below.
    expect(tx.minOut).toBe(2_473_790_863n);
  });

  it('refuses an answer with no usable dstAmount, before anything is signed', async () => {
    const { buildSwap } = await load('base');
    for (const dstAmount of [undefined, '', '4e16', '-1', '0x8e1bc9bf040000']) {
      h.getJson.mockResolvedValueOnce(swapResponse(dstAmount));
      await expect(
        buildSwap({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, ...PARTIES }),
        String(dstAmount),
      ).rejects.toThrow('1inch returned no dstAmount for USDC -> WETH');
    }
  });

  it('refuses a route that delivers nothing once the slippage is taken', async () => {
    const { buildSwap } = await load('base');
    for (const dstAmount of ['0', '1']) {
      h.getJson.mockResolvedValueOnce(swapResponse(dstAmount));
      await expect(
        buildSwap({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, ...PARTIES }),
        dstAmount,
      ).rejects.toThrow('The USDC -> WETH route delivers nothing at this size');
    }
  });
});

describe('a chain where nothing settles', () => {
  it('refuses a fill on Base Sepolia before any request is made, and says what would work', async () => {
    const { buildSwap, CAN_SETTLE } = await load('base-sepolia');
    expect(CAN_SETTLE).toBe(false);

    await expect(buildSwap({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, ...PARTIES })).rejects.toThrow(
      'Cannot fill on base-sepolia: 1inch has no deployment there. Prices are real (quoted against Base mainnet); ' +
        'settlement needs XORR_CHAIN=base-fork or base.',
    );
    expect(h.getJson).not.toHaveBeenCalled();
  });

  it('refuses a fill on the local Sepolia fork the same way', async () => {
    const { buildSwap } = await load('localnet');
    await expect(buildSwap({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, ...PARTIES })).rejects.toThrow(
      'Cannot fill on localnet',
    );
    expect(h.getJson).not.toHaveBeenCalled();
  });

  it('settles only on Base and its mainnet fork', async () => {
    const settles: Record<string, boolean> = {};
    for (const chain of ['localnet', 'base-sepolia', 'base-fork', 'base'] as const) {
      settles[chain] = (await load(chain)).CAN_SETTLE;
    }
    expect(settles).toEqual({ localnet: false, 'base-sepolia': false, 'base-fork': true, base: true });
  });

  it('still quotes against Base mainnet tokens there — prices are real even where settlement is not', async () => {
    const { quote, TOKENS } = await load('base-sepolia');
    h.getJson.mockResolvedValue(quoteResponse('40000000000000000'));

    // Mainnet USDC, not Circle's Sepolia deployment: 1inch is only ever asked about chain 8453.
    expect(TOKENS.USDC).toEqual({ address: USDC, decimals: 6 });
    await quote({ inSymbol: 'USDC', outSymbol: 'WETH', amount: 100, skipPriceImpact: true });
    expect(requested()).toBe(
      `${API}/quote?src=${USDC}&dst=${WETH}&amount=100000000&includeProtocols=true&includeGas=true`,
    );
  });
});

describe('the pure helpers', () => {
  it('canonicalSymbol resolves casing and whitespace to the registry spelling, and leaves the unknown alone', async () => {
    const { canonicalSymbol } = await load('base');
    expect(canonicalSymbol(' cbbtc ')).toBe('CBBTC');
    expect(canonicalSymbol('msftC')).toBe('MSFTc');
    expect(canonicalSymbol('Eth')).toBe('ETH');
    // Aave's receipt token is not a swap token: it comes back as asked, for the caller's error to name.
    expect(canonicalSymbol('aUSDC')).toBe('aUSDC');
  });

  it('TOKENS carries each venue token with the decimals its amounts are scaled by', async () => {
    const { TOKENS, SETTLEMENT_SYMBOL } = await load('base');
    expect(TOKENS.ETH).toEqual({ address: ETH, decimals: 18 });
    expect(TOKENS.WETH).toEqual({ address: WETH, decimals: 18 });
    expect(TOKENS.USDC).toEqual({ address: USDC, decimals: 6 });
    expect(TOKENS.CBBTC).toEqual({ address: CBBTC, decimals: 8 });
    expect(TOKENS.NVDAc).toEqual({ address: NVDAC, decimals: 8 });
    expect(SETTLEMENT_SYMBOL).toBe('USDC');
  });

  it('venuesFrom flattens routes, hops and parts into distinct readable names', async () => {
    const { venuesFrom } = await load('base');
    expect(
      venuesFrom([
        [[{ name: 'BASE_UNISWAP_V3' }, { name: 'BASE_AERODROME_SLIPSTREAM' }], [{ name: 'BASE_CURVE' }]],
        [[{ name: 'BASE_UNISWAP_V3' }]],
      ]),
    ).toEqual(['Uniswap V3', 'Aerodrome Slipstream', 'Curve']);
    expect(venuesFrom(undefined)).toEqual([]);
    expect(venuesFrom([[[{ name: '' }]]])).toEqual([]);
  });

  it('prettyVenue drops the chain prefix and keeps version tags upper-case', async () => {
    const { prettyVenue } = await load('base');
    expect(prettyVenue('BASE_UNISWAP_V4')).toBe('Uniswap V4');
    expect(prettyVenue('BASE_PANCAKESWAP_V3')).toBe('Pancakeswap V3');
    expect(prettyVenue('BASE_BALANCER_V2')).toBe('Balancer V2');
    expect(prettyVenue('UNISWAP_V2')).toBe('Uniswap V2');
  });

  it('routeLabel names one venue, counts several, and calls none "Direct"', async () => {
    const { routeLabel } = await load('base');
    expect(routeLabel([])).toBe('Direct');
    expect(routeLabel(['Curve'])).toBe('Curve');
    expect(routeLabel(['Uniswap V3', 'Curve', 'Balancer V2'])).toBe('Best of 3 venues');
  });

  it('slippageFor settles binary noise before rounding up, and stops at 3%', async () => {
    const { slippageFor, SLIPPAGE, DEFAULT_SLIPPAGE_PCT } = await load('base');
    expect(SLIPPAGE).toEqual({ scheduled: 0.3, stop: 1, panic: 2 });
    expect(DEFAULT_SLIPPAGE_PCT).toBe(SLIPPAGE.scheduled);

    // 0.2 × 1.5 is 0.30000000000000004: noise, not a reason to round a 0.3 ceiling up to 0.31.
    expect(slippageFor(SLIPPAGE.scheduled, 0.2)).toBe(0.3);
    // 1.9 × 1.5 is 2.8499999999999996: noise the other way, not a reason to allow only 2.84.
    expect(slippageFor(SLIPPAGE.panic, 1.9)).toBe(2.85);
    // A genuine third decimal still rounds up: 0.67 × 1.5 = 1.005.
    expect(slippageFor(SLIPPAGE.stop, 0.67)).toBe(1.01);
    // Exactly at the cap.
    expect(slippageFor(SLIPPAGE.stop, 2)).toBe(3);
    // An impact that is not a finite number is no measurement at all.
    expect(slippageFor(SLIPPAGE.scheduled, Number.POSITIVE_INFINITY)).toBe(SLIPPAGE.scheduled);
  });
});
