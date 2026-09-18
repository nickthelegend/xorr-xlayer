/**
 * `usePrice` returned nothing for a tokenized equity, on the screens that buy them.
 *
 * `/market/symbols` lists what CoinGecko covers, which is crypto, and `fetchQuotes` filtered every
 * symbol against it — so `NVDAx` and `TSLAx` were dropped before the request was made. The market
 * list did not show the gap because it merges `/market/stocks` itself. Every other screen did:
 * the order ticket read **"No live NVDAx price"** immediately above "At worst — 1.0738 NVDAx", calling an asset unpriced on the same screen that had just quoted a real route
 * for it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchQuotes,
  clearMarketDataCache,
  resetPricedSymbols,
} from './marketData';

const CRYPTO_FEED = ['BTC', 'ETH', 'SOL'];

function mockApi(handler: (url: string) => unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    const body = handler(url);
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });
}

beforeEach(() => {
  clearMarketDataCache();
  resetPricedSymbols();
});
afterEach(() => vi.restoreAllMocks());

describe('an equity has a price, from the venue that would fill it', () => {
  it('prices NVDAx even though CoinGecko has never heard of it', async () => {
    mockApi((url) => {
      if (url.includes('/market/symbols')) return CRYPTO_FEED;
      if (url.includes('/market/stocks'))
        return [
          { symbol: 'NVDAx', name: 'NVIDIA', address: '0x0', price: 232.14, venues: ['Uniswap v3'], feed: 'live' },
        ];
      if (url.includes('/market/quotes')) return {};
      return {};
    });

    const q = await fetchQuotes(['NVDAx']);
    expect(q.NVDAx?.price).toBe(232.14);
    expect(q.NVDAx?.source).toBe('uniswap-v3');
    // One observation is not a delta. Inventing one would be the lie this file exists to avoid.
    expect(q.NVDAx?.change24h).toBe(0);
  });

  it('does not fetch the stock list when nothing asked for an equity', async () => {
    const spy = mockApi((url) => {
      if (url.includes('/market/symbols')) return CRYPTO_FEED;
      if (url.includes('/market/quotes')) return { BTC: { price: 80000, change24h: 1, source: 'coingecko' } };
      return {};
    });
    const q = await fetchQuotes(['BTC']);
    expect(q.BTC?.price).toBe(80000);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/market/stocks'))).toBe(false);
  });

  it('crypto and equities in one call both come back', async () => {
    mockApi((url) => {
      if (url.includes('/market/symbols')) return CRYPTO_FEED;
      if (url.includes('/market/stocks'))
        return [{ symbol: 'TSLAx', name: 'Tesla', address: '0x0', price: 356.7, venues: ['Uniswap v3'], feed: 'live' }];
      if (url.includes('/market/quotes')) return { ETH: { price: 2510, change24h: 0.8, source: 'coingecko' } };
      return {};
    });
    const q = await fetchQuotes(['ETH', 'TSLAx']);
    expect(q.ETH?.price).toBe(2510);
    expect(q.TSLAx?.price).toBe(356.7);
  });

  it('nothing routing right now is still no price, not a zero', async () => {
    mockApi((url) => {
      if (url.includes('/market/symbols')) return CRYPTO_FEED;
      if (url.includes('/market/stocks'))
        return [{ symbol: 'METAx', name: 'Meta', address: '0x0', price: null, venues: [], feed: 'unavailable' }];
      if (url.includes('/market/quotes')) return {};
      return {};
    });
    const q = await fetchQuotes(['METAx']);
    // A price of 0 would render as "$0.00" and read as a real quote.
    expect(q.METAx).toBeUndefined();
  });
});
