/**
 * The order breakdown, with Jupiter stood in for.
 *
 * `xstocks-quote.ts` does no modelling — every number is read off the venue's answer — so what is
 * worth pinning is the reading: which field becomes which figure, in which token's units, and what
 * happens to a figure the venue did not send. The quote fixture is a real `api.jup.ag/swap/v1`
 * response for $250 of NVDAx, field for field.
 *
 * The case that matters most is the last one. A venue that returns no `priceImpactPct` must produce
 * a null, not a zero: on the screen this feeds, "0.00%" says the cost was measured and found to be
 * nothing, which is the opposite of not knowing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  quote: vi.fn(),
  xStockPriceUsd: vi.fn(),
  readMintScale: vi.fn(),
}));

class UnpricedError extends Error {}

vi.mock('./jupiter.js', () => ({ quote: h.quote, UnpricedError }));
vi.mock('./xstocks.js', async (orig) => ({
  ...(await orig<typeof import('./xstocks.js')>()),
  xStockPriceUsd: h.xStockPriceUsd,
}));
// The scaled-UI read a sell converts through. No validator is reached here.
vi.mock('../solana/balances.js', async (orig) => ({
  ...(await orig<typeof import('../solana/balances.js')>()),
  readMintScale: h.readMintScale,
}));
vi.mock('../db/index.js', () => ({ query: vi.fn() }));

const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** $250 of USDC into NVDAx, as Jupiter answered it. */
const BUY_QUOTE = {
  inputMint: USDC,
  inAmount: '250000000',
  outputMint: NVDAX,
  outAmount: '115331082',
  otherAmountThreshold: '114754427',
  swapMode: 'ExactIn',
  slippageBps: 50,
  platformFee: null,
  priceImpactPct: '0.0005634572989743139578265942',
  routePlan: [
    { swapInfo: { label: 'Whirlpool', inAmount: '250000000', outAmount: '115331082' }, percent: 100 },
  ],
};

const MARK = 216.8341;

beforeEach(() => {
  h.quote.mockReset().mockResolvedValue(BUY_QUOTE);
  h.xStockPriceUsd.mockReset().mockResolvedValue(MARK);
  h.readMintScale.mockReset().mockResolvedValue({ decimals: 8, multiplier: 1, pending: null });
});

afterEach(() => vi.resetModules());

describe('a buy', () => {
  it('pays USDC and receives the token, in each side’s own units', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });

    expect(q.pay).toBeCloseTo(250, 6);
    expect(q.payToken).toBe('USDC');
    expect(q.receive).toBeCloseTo(1.15331082, 8);
    expect(q.receiveToken).toBe('NVDAx');
  });

  it('takes the floor from the venue rather than computing one', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });

    // `otherAmountThreshold` is the number the swap is submitted with. Arithmetic on `outAmount`
    // would show a floor the venue never agreed to.
    expect(q.minimumReceive).toBeCloseTo(1.14754427, 8);
  });

  it('turns the wire’s fraction into a percentage, and into money', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });

    expect(q.priceImpactPct).toBeCloseTo(0.05634572989, 8);
    expect(q.priceImpactUsd).toBeCloseTo(0.1408643, 6);
  });

  it('prices the tolerance in dollars, through the mark', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });

    // (expected − floor) shares, valued at the mark. The percentage alone is homework.
    expect(q.slippageWorstUsd).toBeCloseTo((1.15331082 - 1.14754427) * MARK, 4);
  });

  it('reports the tolerance the venue echoed, not the one asked for', async () => {
    h.quote.mockResolvedValue({ ...BUY_QUOTE, slippageBps: 100 });
    const { xStockQuote } = await import('./xstocks-quote.js');

    // A venue that clamped the tolerance would otherwise have the ticket promise a floor nobody
    // agreed to.
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250, slippageBps: 25 });
    expect(q.slippageBps).toBe(100);
    expect(h.quote).toHaveBeenCalledWith(expect.objectContaining({ slippageBps: 25 }));
  });

  it('names each hop of the route', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    expect((await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 })).hops).toEqual([
      { label: 'Whirlpool', percent: 100 },
    ]);
  });

  it('asks the venue in USDC base units for the size given', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });

    expect(h.quote).toHaveBeenCalledWith(
      expect.objectContaining({ inSymbolOrMint: 'USDC', outSymbolOrMint: NVDAX, amountUnits: 250_000_000n }),
    );
  });
});

describe('a sell', () => {
  const SELL_QUOTE = {
    ...BUY_QUOTE,
    inputMint: NVDAX,
    inAmount: '115300000',
    outputMint: USDC,
    outAmount: '249303604',
    otherAmountThreshold: '248057086',
    routePlan: [
      { swapInfo: { label: 'Whirlpool', inAmount: '115300000', outAmount: '249303604' }, percent: 100 },
    ],
  };

  it('converts the size through the mint’s scale, as the fill does', async () => {
    // xStocks are Token-2022 with the Scaled UI Amount extension: an issuer multiplier decides how
    // many raw units a displayed holding is. A preview on the wrong conversion quotes a different
    // order from the one that would fill.
    h.quote.mockResolvedValue(SELL_QUOTE);
    h.readMintScale.mockResolvedValue({ decimals: 8, multiplier: 1.001, pending: null });
    const { xStockQuote } = await import('./xstocks-quote.js');

    await xStockQuote({ symbol: 'NVDAx', side: 'sell', usd: 250 });

    const asked = h.quote.mock.calls[0]![0].amountUnits as bigint;
    expect(asked).toBe(BigInt(Math.floor((250 / MARK / 1.001) * 1e8)));
  });

  it('reads the received side in USDC', async () => {
    h.quote.mockResolvedValue(SELL_QUOTE);
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'sell', usd: 250 });

    expect(q.receiveToken).toBe('USDC');
    expect(q.receive).toBeCloseTo(249.303604, 6);
    expect(q.minimumReceive).toBeCloseTo(248.057086, 6);
    // A dollar is a dollar: the tolerance needs no mark on this side.
    expect(q.slippageWorstUsd).toBeCloseTo(249.303604 - 248.057086, 6);
  });
});

describe('what the venue did not say', () => {
  it('leaves price impact null rather than zero', async () => {
    h.quote.mockResolvedValue({ ...BUY_QUOTE, priceImpactPct: undefined });
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });

    expect(q.priceImpactPct).toBeNull();
    expect(q.priceImpactUsd).toBeNull();
  });

  it('reports no platform fee as null, not as an absent line', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    expect((await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 })).platformFeeUsd).toBeNull();
  });

  it('prices a platform fee in USD when there is one', async () => {
    h.quote.mockResolvedValue({ ...BUY_QUOTE, platformFee: { amount: '115331', feeBps: 10 } });
    const { xStockQuote } = await import('./xstocks-quote.js');
    const q = await xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 });

    expect(q.platformFeeUsd).toBeCloseTo((115331 / 1e8) * MARK, 6);
  });
});

describe('what cannot be broken down', () => {
  it('a symbol that is not a tokenized equity here', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    await expect(xStockQuote({ symbol: 'WETH', side: 'buy', usd: 250 })).rejects.toBeInstanceOf(
      UnpricedError,
    );
    expect(h.quote).not.toHaveBeenCalled();
  });

  it('a size of nothing', async () => {
    const { xStockQuote } = await import('./xstocks-quote.js');
    await expect(xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 0 })).rejects.toBeInstanceOf(
      UnpricedError,
    );
  });

  it('a symbol with no mark, since every figure is read against one', async () => {
    h.xStockPriceUsd.mockResolvedValue(null);
    const { xStockQuote } = await import('./xstocks-quote.js');

    // Without a mark there is no honest way to put a token figure into money. A breakdown with a
    // guessed denominator is worse than no breakdown.
    await expect(xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 })).rejects.toBeInstanceOf(
      UnpricedError,
    );
  });

  it('passes the venue’s own refusal straight up', async () => {
    h.quote.mockRejectedValue(new UnpricedError('No Jupiter quote for USDC -> NVDAx: 429'));
    const { xStockQuote } = await import('./xstocks-quote.js');

    await expect(xStockQuote({ symbol: 'NVDAx', side: 'buy', usd: 250 })).rejects.toThrow(/429/);
  });
});
