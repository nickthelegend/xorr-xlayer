/**
 * A chart can tell "nothing prices this" from "that did not load", and says how long its window is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMarketDataCache, resetPricedSymbols } from '@/data/marketData';
import { chartSeries, historySeries, spanWords } from './series';

describe('the words for a window', () => {
  it('says hours under two days and days after', () => {
    expect(spanWords(12 * 3_600_000)).toBe('past 12 hours');
    expect(spanWords(3_600_000)).toBe('past hour');
    expect(spanWords(48 * 3_600_000)).toBe('past 2 days');
    expect(spanWords(12 * 86_400_000)).toBe('past 12 days');
  });
});

describe('three answers, not one', () => {
  let ohlcStatus = 200;

  beforeEach(() => {
    clearMarketDataCache();
    resetPricedSymbols();
    ohlcStatus = 200;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/market/symbols')) return Promise.resolve(new Response(JSON.stringify(['BTC'])));
      if (ohlcStatus !== 200) return Promise.resolve(new Response('{}', { status: ohlcStatus }));
      const now = Date.UTC(2026, 8, 14);
      const rows = Array.from({ length: 48 }, (_, i) => [now - (47 - i) * 1_800_000, 1, 2, 0.5, 1.5]);
      return Promise.resolve(new Response(JSON.stringify({ rows })));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('answers live candles with the question they answer', async () => {
    const s = await chartSeries('BTC', '1H');
    expect(s).toMatchObject({ symbol: 'BTC', window: '1H', feed: 'live' });
    expect(s.bars).toHaveLength(12);
  });

  it('answers a symbol nothing prices as unavailable, without asking for its history', async () => {
    expect(await historySeries('IWM', '1W')).toEqual({ symbol: 'IWM', window: '1W', bars: [], feed: 'unavailable' });
  });

  it('throws a failed read instead of calling it no feed', async () => {
    ohlcStatus = 500;
    await expect(historySeries('BTC', '1M')).rejects.toThrow(/500/);
  });
});
