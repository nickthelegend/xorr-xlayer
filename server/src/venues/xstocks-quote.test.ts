/**
 * The order breakdown, with the Uniswap quoter stood in for.
 *
 * `xstocks-quote.ts` does no modelling — every number is read off the venue's answer — so what is
 * worth pinning is the reading: which field becomes which figure, in which token's units, which
 * pools the route names, and what happens to a figure the venue did not produce. The route itself
 * is the real `routeBetween` over the real registry: TSLAx has a USDC pool, NVDAx trades against
 * USDG, and the ticket must say so.
 *
 * The case that matters most: a quote whose impact could not be measured must produce a null, not
 * a zero. On the screen this feeds, "0.00%" says the cost was measured and found to be nothing,
 * which is the opposite of not knowing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  // A unit test needs no chain, and the repo-root `.env` may name one this executor no longer knows.
  process.env.XORR_CHAIN = 'xlayer-testnet';
  return { quote: vi.fn(), xStockPriceUsd: vi.fn() };
});

vi.mock('./uniswap.js', async (orig) => ({
  ...(await orig<typeof import('./uniswap.js')>()),
  quote: h.quote,
}));
vi.mock('./xstocks.js', async (orig) => ({
  ...(await orig<typeof import('./xstocks.js')>()),
  xStockPriceUsd: h.xStockPriceUsd,
}));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn() }));
vi.mock('../db/index.js', () => ({ query: vi.fn(async () => []) }));

const MARK = 181.62;

/** $250 of USDC into NVDAx through USDG, in `uniswap.quote`'s own shape. */
const BUY_QUOTE = {
  inSymbol: 'USDC',
  outSymbol: 'NVDAx',
  inAmount: 250,
  outAmount: 1.3741,
  minimumOut: 1.3741 * (1 - 0.3 / 100),
  slippagePct: 0.3,
  venues: ['Uniswap v3'],
  priceImpactPct: 0.12,
  route: 'Uniswap v3 via USDG',
  estimatedGas: 182_000,
};

beforeEach(() => {
  h.quote.mockReset().mockResolvedValue(BUY_QUOTE);
  h.xStockPriceUsd.mockReset().mockResolvedValue(MARK);
});

afterEach(() => vi.resetModules());

describe('a buy', () => {
  it('pays USDC and receives the token, in each side’s own units', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });

    expect(q.pay).toBe(250);
    expect(q.payToken).toBe('USDC');
    expect(q.receive).toBeCloseTo(1.3741, 8);
    expect(q.receiveToken).toBe('NVDAx');
  });

  it('asks the venue for the size given, at the tolerance given, as a percent', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    await xStockQuote({ symbol: 'nvdax', side: 'buy', usd: 250, slippageBps: 25 });

    expect(h.quote).toHaveBeenCalledWith({ inSymbol: 'USDC', outSymbol: 'NVDAx', amount: 250, slippagePct: 0.25 });
  });

  it('takes the floor from the quote rather than computing another', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });

    expect(q.minimumReceive).toBe(BUY_QUOTE.minimumOut);
    expect(q.slippageBps).toBe(30);
  });

  it('carries the measured impact as a percentage, and into money', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });

    expect(q.priceImpactPct).toBe(0.12);
    expect(q.priceImpactUsd).toBeCloseTo(0.3, 8);
  });

  it('prices the tolerance in dollars, through the mark', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });

    expect(q.slippageWorstUsd).toBeCloseTo((BUY_QUOTE.outAmount - BUY_QUOTE.minimumOut) * MARK, 8);
    expect(q.effectivePrice).toBeCloseTo(250 / 1.3741, 8);
    expect(q.markPrice).toBe(MARK);
    expect(q.estimatedGas).toBe(182_000);
  });

  it('names each pool of a USDG-pooled ticker, in order', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    const { hops } = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });

    expect(hops).toEqual([
      { label: 'Uniswap v3 USDC→USDG 0.01%', percent: 100, venue: 'Uniswap v3', from: 'USDC', to: 'USDG', feePct: 0.01 },
      { label: 'Uniswap v3 USDG→NVDAx 0.05%', percent: 100, venue: 'Uniswap v3', from: 'USDG', to: 'NVDAx', feePct: 0.05 },
    ]);
  });

  it('names the single pool of a USDC-pooled ticker', async () => {
    h.quote.mockResolvedValue({ ...BUY_QUOTE, outSymbol: 'TSLAx' });
    const { xStockQuote } = await import('./xstocks-quote.js');
    const { hops } = await xStockQuote({ symbol: 'TSLAx', side: 'buy', usd: 250 });

    expect(hops).toEqual([
      { label: 'Uniswap v3 USDC→TSLAx 0.05%', percent: 100, venue: 'Uniswap v3', from: 'USDC', to: 'TSLAx', feePct: 0.05 },
    ]);
  });
});

describe('a sell', () => {
  const SELL_QUOTE = {
    ...BUY_QUOTE,
    inSymbol: 'NVDAx',
    outSymbol: 'USDC',
    inAmount: 250 / MARK,
    outAmount: 249.1,
    minimumOut: 249.1 * (1 - 0.3 / 100),
  };

  it('sells usd / mark wrapped shares — the wrapper does not rebase', async () => {
    h.quote.mockResolvedValue(SELL_QUOTE);
    const { xStockQuote } = await import('./xstocks-quote.js');
    await xStockQuote({ symbol: 'NVDAx', side: 'sell', usd: 250 });

    expect(h.quote).toHaveBeenCalledWith(
      expect.objectContaining({ inSymbol: 'NVDAx', outSymbol: 'USDC', amount: 250 / MARK }),
    );
  });

  it('reads the received side in USDC and walks the route backwards', async () => {
    h.quote.mockResolvedValue(SELL_QUOTE);
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'sell', usd: 250 });

    expect(q.receiveToken).toBe('USDC');
    expect(q.payToken).toBe('NVDAx');
    expect(q.receive).toBe(249.1);
    // A dollar is a dollar: the tolerance needs no mark on this side.
    expect(q.slippageWorstUsd).toBeCloseTo(SELL_QUOTE.outAmount - SELL_QUOTE.minimumOut, 8);
    expect(q.hops.map((x) => `${x.from}>${x.to}`)).toEqual(['NVDAx>USDG', 'USDG>USDC']);
  });
});

describe('what the venue did not say', () => {
  it('leaves price impact null rather than zero', async () => {
    h.quote.mockResolvedValue({ ...BUY_QUOTE, priceImpactPct: null });
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });

    expect(q.priceImpactPct).toBeNull();
    expect(q.priceImpactUsd).toBeNull();
  });

  it('leaves the gas estimate null when the quoter gave none', async () => {
    h.quote.mockResolvedValue({ ...BUY_QUOTE, estimatedGas: undefined });
    const { xStockQuote } = await import('./xstocks-quote.js');
    expect((await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 })).estimatedGas).toBeNull();
  });

  it('reports no platform fee as null, not as an absent line', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });
    expect(q).toHaveProperty('platformFeeUsd', null);
  });
});

describe('what cannot be broken down', () => {
  it('a symbol that is not a tokenized equity here', async () => {
    const { xStockQuote, UnpricedError } = await import('./xstocks-quote.js');
    await expect(xStockQuote({ symbol: 'WETH', side: 'buy', usd: 250 })).rejects.toBeInstanceOf(UnpricedError);
    expect(h.quote).not.toHaveBeenCalled();
  });

  it('a size of nothing', async () => {
    const { xStockQuote, UnpricedError } = await import('./xstocks-quote.js');
    await expect(xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 0 })).rejects.toBeInstanceOf(UnpricedError);
  });

  it('a symbol with no mark, since every figure is read against one', async () => {
    h.xStockPriceUsd.mockResolvedValue(null);
    const { xStockQuote, UnpricedError } = await import('./xstocks-quote.js');

    await expect(xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 })).rejects.toBeInstanceOf(UnpricedError);
    expect(h.quote).not.toHaveBeenCalled();
  });

  it('turns the venue’s refusal into UnpricedError, keeping its words', async () => {
    h.quote.mockRejectedValue(new Error('No liquidity for USDC -> NVDAx at this size'));
    const { xStockQuote, UnpricedError } = await import('./xstocks-quote.js');

    const err = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 }).catch((e) => e);
    expect(err).toBeInstanceOf(UnpricedError);
    expect(err.message).toMatch(/No liquidity/);
  });

  it('is the same UnpricedError class the routes import from venues/errors', async () => {
    const quoteMod = await import('./xstocks-quote.js');
    const errors = await import('./errors.js');
    expect(quoteMod.UnpricedError).toBe(errors.UnpricedError);
  });
});
