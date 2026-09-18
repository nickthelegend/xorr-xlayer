/**
 * `priceOf` could not price a tokenized equity, and that is most of what the executor does.
 *
 * `IDS` is CoinGecko's id table and has no equities in it, so `priceOf('NVDAc')` threw
 * `No price feed for NVDAc` — and with it went sizing, cap-checking and recording for every equity
 * trade. It surfaced the first time tier 7 tried to open a real position, which is the one strategy
 * whose entire remit is equities. `/market/stocks` had the number the whole time; the derivation
 * just lived inside a route handler where only the UI could reach it.
 */
process.env.ONEINCH_API_KEY ??= 'test-key';
process.env.XORR_CHAIN ??= 'base-sepolia';

import { describe, expect, it, vi, beforeEach } from 'vitest';

const oneinchQuote = vi.fn();
// Mocked outright rather than partially: the real module throws at import time without an API key,
// and `vi.mock` is hoisted above the env assignment above, so `importActual` never gets the chance.
vi.mock('../venues/oneinch.js', () => ({
  quote: (p: unknown) => oneinchQuote(p),
  TOKENS: {},
  canonicalSymbol: (x: string) => x,
  DEFAULT_SLIPPAGE_PCT: 0.3,
}));
vi.mock('../http/get.js', () => ({
  getJson: async () => ({}),
  staleValue: () => undefined,
  UpstreamUnavailable: class extends Error {},
}));

const { priceOf } = await import('./prices.js');
const { stockPriceUsd, clearStockPriceCache } = await import('../venues/stocks.js');

beforeEach(() => {
  oneinchQuote.mockReset();
  // A 30s cache is right in production and poison across test cases.
  clearStockPriceCache();
});

describe('an equity is priced by the venue that would fill it', () => {
  it('derives the price from a real route', async () => {
    // $1,000 buys 4.3103 NVDAc, so a share is $232.
    oneinchQuote.mockResolvedValue({ outAmount: 1000 / 232, venues: ['Elfomofi'] });
    expect(await priceOf('NVDAc')).toBeCloseTo(232, 6);
  });

  it('probes with USDC in and the equity out — the direction a buyer trades', async () => {
    oneinchQuote.mockResolvedValue({ outAmount: 4, venues: [] });
    await stockPriceUsd('TSLAc');
    expect(oneinchQuote).toHaveBeenCalledWith(
      expect.objectContaining({ inSymbol: 'USDC', outSymbol: 'TSLAc' }),
    );
  });

  it('says there is no price rather than inventing one when nothing routes', async () => {
    oneinchQuote.mockResolvedValue({ outAmount: 0, venues: [] });
    await expect(priceOf('NVDAc')).rejects.toThrow(/No route for NVDAc/);
  });

  it('says the same when the venue itself is down', async () => {
    oneinchQuote.mockRejectedValue(new Error('1inch unavailable'));
    await expect(priceOf('METAc')).rejects.toThrow(/No route for METAc/);
    expect(await stockPriceUsd('METAc')).toBeNull();
  });

  it('resolves case-insensitively — the suffix is what callers lose', async () => {
    /*
     * `/price/:symbol` uppercased its parameter, so `isStock('NVDAC')` was false and every equity
     * price answered "No price feed for NVDAC" for an asset on the app's own markets screen.
     */
    oneinchQuote.mockResolvedValue({ outAmount: 4, venues: [] });
    expect(await stockPriceUsd('NVDAC')).toBeCloseTo(250, 6);
    clearStockPriceCache();
    expect(await stockPriceUsd('nvdac')).toBeCloseTo(250, 6);
    // And the venue is asked with the spelling it knows, not the one the caller sent.
    expect(oneinchQuote).toHaveBeenLastCalledWith(expect.objectContaining({ outSymbol: 'NVDAc' }));
  });

  it('asks the venue NOT to price-impact the probe — the cycle that OOMed the executor', async () => {
    /*
     * `priceImpact` prices both legs with `priceOf` to find a mid. For an equity `priceOf` derives
     * its answer from a quote, so the quote asked for an impact, which priced the legs, which
     * quoted again. The deployed executor reached a 2GB heap and died with "Ineffective
     * mark-compacts near heap limit" about fifty seconds after boot.
     *
     * It is also meaningless for this caller: it is establishing what the price IS, so there is no
     * independent mid for it to be impacted against.
     */
    oneinchQuote.mockResolvedValue({ outAmount: 4, venues: [] });
    await stockPriceUsd('NVDAc');
    expect(oneinchQuote).toHaveBeenCalledWith(expect.objectContaining({ skipPriceImpact: true }));
  });

  it('is not a stock, so it is not routed here', async () => {
    // Crypto must still go to the feed; this must not swallow every symbol.
    expect(await stockPriceUsd('WETH')).toBeNull();
    expect(oneinchQuote).not.toHaveBeenCalled();
  });
});
