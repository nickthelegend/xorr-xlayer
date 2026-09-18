/**
 * `priceOf` could not price a tokenized equity, and that is most of what the executor does.
 *
 * `IDS` is CoinGecko's id table and has no equities in it, so on the Base build `priceOf` threw
 * `No price feed for …` for every equity — and with it went sizing, cap-checking and recording for
 * every equity trade. It surfaced the first time tier 7 tried to open a real position, which is the
 * one strategy whose entire remit is equities. On X Layer the wrapped xStocks are priced by the
 * Uniswap v3 pools that would fill them (`venues/stocks.ts#stockPriceUsd`), and these hold `priceOf`
 * to that.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const uniswapQuote = vi.fn();
// The venue, mocked: a unit test does not ask X Layer's pools what a share costs.
vi.mock('../venues/uniswap.js', () => ({
  quote: (p: unknown) => uniswapQuote(p),
}));
vi.mock('../http/get.js', () => ({
  getJson: async () => ({}),
  staleValue: () => undefined,
  UpstreamUnavailable: class extends Error {},
}));
vi.mock('../db/index.js', () => ({ query: vi.fn(async () => []), one: vi.fn() }));

const { priceOf } = await import('./prices.js');
const { stockPriceUsd, clearStockPriceCache } = await import('../venues/stocks.js');

beforeEach(() => {
  uniswapQuote.mockReset();
  // A 30s cache is right in production and poison across test cases.
  clearStockPriceCache();
});

describe('an equity is priced by the venue that would fill it', () => {
  it('derives the price from a real route', async () => {
    // $1,000 buys 4.3103 NVDAx, so a share is $232.
    uniswapQuote.mockResolvedValue({ outAmount: 1000 / 232, venues: ['Uniswap v3'] });
    expect(await priceOf('NVDAx')).toBeCloseTo(232, 6);
  });

  it('probes with USDC in and the equity out — the direction a buyer trades', async () => {
    uniswapQuote.mockResolvedValue({ outAmount: 4, venues: [] });
    await stockPriceUsd('TSLAx');
    expect(uniswapQuote).toHaveBeenCalledWith(
      expect.objectContaining({ inSymbol: 'USDC', outSymbol: 'TSLAx' }),
    );
  });

  it('says there is no price rather than inventing one when nothing routes', async () => {
    uniswapQuote.mockResolvedValue({ outAmount: 0, venues: [] });
    await expect(priceOf('NVDAx')).rejects.toThrow(/No route for NVDAx/);
  });

  it('says the same when the venue itself is down', async () => {
    uniswapQuote.mockRejectedValue(new Error('QuoterV2 unavailable'));
    await expect(priceOf('METAx')).rejects.toThrow(/No route for METAx/);
    expect(await stockPriceUsd('METAx')).toBeNull();
  });

  it('resolves case-insensitively — the suffix is what callers lose', async () => {
    /*
     * `/price/:symbol` uppercased its parameter, so an equity's lookup missed and every equity
     * price answered "No price feed for …" for an asset on the app's own markets screen.
     */
    uniswapQuote.mockResolvedValue({ outAmount: 4, venues: [] });
    expect(await stockPriceUsd('NVDAX')).toBeCloseTo(250, 6);
    clearStockPriceCache();
    expect(await stockPriceUsd('nvdax')).toBeCloseTo(250, 6);
    // And the venue is asked with the spelling it knows, not the one the caller sent.
    expect(uniswapQuote).toHaveBeenLastCalledWith(expect.objectContaining({ outSymbol: 'NVDAx' }));
  });

  it('asks the venue NOT to price-impact the probe — the cycle that OOMed the executor', async () => {
    /*
     * `priceImpact` prices both legs with `priceOf` to find a mid. For an equity `priceOf` derives
     * its answer from a quote, so the quote asked for an impact, which priced the legs, which
     * quoted again. The deployed Base executor reached a 2GB heap and died with "Ineffective
     * mark-compacts near heap limit" about fifty seconds after boot.
     *
     * It is also meaningless for this caller: it is establishing what the price IS, so there is no
     * independent mid for it to be impacted against.
     */
    uniswapQuote.mockResolvedValue({ outAmount: 4, venues: [] });
    await stockPriceUsd('NVDAx');
    expect(uniswapQuote).toHaveBeenCalledWith(expect.objectContaining({ skipPriceImpact: true }));
  });

  it('is not a stock, so it is not routed here', async () => {
    // Crypto must still go to the feed; this must not swallow every symbol.
    expect(await stockPriceUsd('WETH')).toBeNull();
    expect(uniswapQuote).not.toHaveBeenCalled();
  });
});
