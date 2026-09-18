/**
 * LIVE integration test — real prices, no mocks.
 *
 * These now go through the running executor's public /market routes, which is exactly what the app
 * does on web: a direct browser call to CoinGecko dies in a CORS preflight. So this test also
 * proves the proxy is up and the symbol map on both sides agrees.
 *
 * The pure folding and the requests each pill makes are covered offline in `marketData.test.ts`.
 *
 * Run with: npm run test:live   (excluded from the default suite so CI stays hermetic)
 */
import { describe, expect, it } from 'vitest';
import {
  CHART_TIMEFRAMES,
  fetchCandles,
  fetchChartCandles,
  fetchHistory,
  fetchQuotes,
  pricedSymbols,
} from './marketData';
import { assetClasses } from './fixtures/markets';
import type { Bar } from './types';

const wellFormed = (bars: readonly Bar[]) => {
  for (const [o, h, l, cl] of bars) {
    expect(h).toBeGreaterThanOrEqual(Math.max(o, cl));
    expect(l).toBeLessThanOrEqual(Math.min(o, cl));
    expect(o).toBeGreaterThan(0);
  }
};

describe('live market data', () => {
  it('prices all 9 crypto instruments for real', async () => {
    const crypto = assetClasses.find((c) => c.id === 'crypto')!;
    const symbols = crypto.instruments.map((i) => i.sym);
    expect(symbols).toHaveLength(9);
    const quotes = await fetchQuotes(symbols);
    for (const sym of symbols) {
      const q = quotes[sym];
      expect(q, `${sym} has no live quote`).toBeDefined();
      expect(q!.price).toBeGreaterThan(0);
      expect(Number.isFinite(q!.change24h)).toBe(true);
      expect(q!.source).toBe('coingecko');
    }
    // Sanity: BTC should be the most expensive of the nine.
    const btc = quotes.BTC!.price;
    for (const [sym, q] of Object.entries(quotes)) {
      if (sym !== 'BTC') expect(btc).toBeGreaterThan(q.price);
    }
  }, 90_000);

  it('prices the X Layer assets the delegation actually trades', async () => {
    // XBTC and WOKB are what an X Layer strategy holds; if they have no feed the order ticket and the
    // executor are pricing different things.
    const quotes = await fetchQuotes(['XBTC', 'WOKB', 'USDC']);
    for (const sym of ['XBTC', 'WOKB', 'USDC']) {
      expect(quotes[sym], `${sym} has no live quote`).toBeDefined();
      expect(quotes[sym]!.price).toBeGreaterThan(0);
    }
    // XBTC must track BTC: same asset, one wrapped. Anything past a few percent is a broken map.
    const btc = await fetchQuotes(['BTC']);
    const drift = Math.abs(quotes.XBTC!.price - btc.BTC!.price) / btc.BTC!.price;
    expect(drift, `XBTC ${quotes.XBTC!.price} vs BTC ${btc.BTC!.price}`).toBeLessThan(0.05);
    // A dollar stablecoin that is not within a cent of a dollar is a feed bug, not a market move.
    expect(Math.abs(quotes.USDC!.price - 1)).toBeLessThan(0.01);
  }, 90_000);

  it('returns real 12-candle OHLC for every repository window [G8]', async () => {
    for (const tf of ['1H', '4H', '1D', '1W'] as const) {
      const c = await fetchCandles('BTC', tf);
      expect(c, `${tf} returned nothing`).not.toBeNull();
      expect(c!.feed).toBe('live');
      expect(c!.bars.length).toBeGreaterThan(0);
      expect(c!.bars.length).toBeLessThanOrEqual(12);
      wellFormed(c!.bars);
    }
    // `15m` fetched `1H`'s day under another name; nothing the feed sends is fine enough for it.
    expect(await fetchCandles('BTC', '15m')).toBeNull();
  }, 90_000);

  it('cuts twelve candles of every chart length from the feed’s real rows', async () => {
    for (const tf of CHART_TIMEFRAMES) {
      const bars = await fetchChartCandles('BTC', tf);
      // Twelve exactly: fewer means the feed's row length changed and the pill is no longer true.
      expect(bars, `${tf} could not be cut from the feed's rows`).toHaveLength(12);
      wellFormed(bars!);
    }
  }, 90_000);

  it('reaches a whole year back for 1Y', async () => {
    const year = await fetchHistory('BTC', '1Y');
    expect(year!.length).toBeGreaterThan(0);
    expect(year!.length).toBeLessThanOrEqual(12);
    wellFormed(year!);
  }, 120_000);

  it('different windows really do return different series — the pills are no longer decorative', async () => {
    const short = await fetchCandles('BTC', '1H');
    const long = await fetchCandles('BTC', '1W');
    expect(short!.bars).not.toEqual(long!.bars);
    // A 90-day window must span a wider price range than a 1-day window.
    const range = (b: Bar[]) => Math.max(...b.map((x) => x[1])) - Math.min(...b.map((x) => x[2]));
    expect(range(long!.bars)).toBeGreaterThan(range(short!.bars));
  }, 60_000);

  it('the priceable symbols come from the SERVER, and include the ones we trade', async () => {
    /*
     * The point of this test changed with the code it covers. It used to assert that a
     * client-side copy of the id map was well-formed — which it always was, right up to the
     * moment it drifted from the server's and started filtering gold out of its own price
     * request. There is no copy now, so what is worth asserting is that the real list arrives
     * and carries the assets the app actually trades.
     */
    const priced = await pricedSymbols();
    expect(priced.size).toBeGreaterThan(0);
    for (const sym of ['XBTC', 'WOKB', 'USDC', 'BTC', 'ETH']) expect(priced.has(sym)).toBe(true);
    // The two that drifted. A real gold feed exists; the commodities tab must be able to ask.
    for (const sym of ['XAUT', 'PAXG']) expect(priced.has(sym)).toBe(true);
  });
});
