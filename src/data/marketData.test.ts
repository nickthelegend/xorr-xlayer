/**
 * What each chart pill and each range asks the feed for, and what it draws from the answer.
 *
 * The chart's `15m` pill fetched the same day as `1H` and drew the same candles; the asset screen's
 * `1Y` and `All` both fetched ninety days and called them a year and all time. These pin lengths to
 * labels, against rows shaped like the feed's own as the executor relays them: thirty minutes for a
 * day, four hours for a week or a month, four days for ninety days or a year.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHART_PLAN,
  CHART_TIMEFRAMES,
  HISTORY_DAYS,
  aggregateBars,
  candlesOfLength,
  clearMarketDataCache,
  fetchCandles,
  fetchChartCandles,
  fetchHistory,
  foldWindow,
  isStockSymbol,
  resetPricedSymbols,
  type OhlcRow,
} from './marketData';
import type { Bar } from './types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** `n` rows `step` apart, oldest first. Row i opens at i, closes at i + 1, spans i − 1 to i + 2. */
function rows(n: number, step: number, end = Date.UTC(2026, 8, 14, 12)): OhlcRow[] {
  return Array.from({ length: n }, (_, i) => [end - (n - 1 - i) * step, i, i + 2, i - 1, i + 1] as const);
}

const bars = (r: readonly OhlcRow[]): Bar[] => r.map((x) => [x[1], x[2], x[3], x[4]] as const);

describe('candles exactly as long as their label', () => {
  it('cuts a day of thirty-minute rows into twelve hourly candles — twelve hours, not a day', () => {
    const out = candlesOfLength(rows(48, 30 * MIN), HOUR);
    expect(out).toHaveLength(12);
    // The newest hour is the last two rows: the first one's open, the second one's close.
    expect(out[11]).toEqual([46, 49, 45, 48]);
    expect(out[0]).toEqual([24, 27, 23, 26]);
  });

  it('takes one four-hour row per 4H candle, and six per daily candle', () => {
    const four = candlesOfLength(rows(42, 4 * HOUR), 4 * HOUR);
    expect(four).toHaveLength(12);
    expect(four[11]).toEqual([41, 43, 40, 42]);
    const daily = candlesOfLength(rows(180, 4 * HOUR), DAY);
    expect(daily).toHaveLength(12);
    expect(daily[11]).toEqual([174, 181, 173, 180]);
  });

  it('draws no candle it cannot make: nothing finer than a row, nothing that cuts a row in two', () => {
    expect(candlesOfLength(rows(48, 30 * MIN), 15 * MIN)).toEqual([]);
    expect(candlesOfLength(rows(23, 4 * DAY), 7 * DAY)).toEqual([]);
    expect(candlesOfLength(rows(1, HOUR), HOUR)).toEqual([]);
  });

  it('thins one candle for a missing row instead of shifting every candle after it', () => {
    const out = candlesOfLength(rows(48, 30 * MIN).filter((_, i) => i !== 45), HOUR);
    expect(out).toHaveLength(12);
    expect(out[10]).toEqual([44, 46, 43, 45]);
    expect(out[11]).toEqual([46, 49, 45, 48]);
  });

  it('leaves out the oldest candle when the rows stop partway through it', () => {
    // Twenty-three rows is eleven and a half hours: eleven whole candles and half of one.
    const out = candlesOfLength(rows(23, 30 * MIN), HOUR);
    expect(out).toHaveLength(11);
    expect(out[0]).toEqual([1, 4, 0, 3]);
  });
});

describe('a range drawn whole', () => {
  it('keeps every row of a week, letting the oldest candle be short', () => {
    const week = bars(rows(42, 4 * HOUR));
    const out = foldWindow(week);
    expect(out).toHaveLength(11);
    expect(out[0]![0]).toBe(week[0]![0]);
    expect(out[10]![3]).toBe(week[41]![3]);
    // `aggregateBars` drops the six oldest rows to make twelve equal candles: six days, not seven.
    expect(aggregateBars(week)[0]![0]).toBe(week[6]![0]);
  });

  it('folds a year of four-day rows to twelve, from the year’s own first open', () => {
    const year = bars(rows(92, 4 * DAY));
    const out = foldWindow(year);
    expect(out).toHaveLength(12);
    expect(out[0]![0]).toBe(year[0]![0]);
    expect(out[11]![3]).toBe(year[91]![3]);
  });

  it('passes a short window through untouched', () => {
    const few = bars(rows(5, HOUR));
    expect(foldWindow(few)).toEqual(few);
  });
});

describe('bar aggregation — the repository’s window fold', () => {
  it('folds n raw bars into 12: first open, max high, min low, last close', () => {
    const raw: Bar[] = Array.from({ length: 48 }, (_, i) => [i, i + 2, i - 1, i + 1]);
    const out = aggregateBars(raw, 12);
    expect(out).toHaveLength(12);
    for (const [o, h, l, c] of out) {
      expect(h).toBeGreaterThanOrEqual(Math.max(o, c));
      expect(l).toBeLessThanOrEqual(Math.min(o, c));
    }
    expect(out[11]![3]).toBe(raw[47]![3]);
  });

  it('passes through when there are already 12 or fewer', () => {
    const raw: Bar[] = [[1, 2, 0, 1], [1, 3, 1, 2]];
    expect(aggregateBars(raw, 12)).toEqual(raw);
  });
});

describe('what each pill and range asks the executor for', () => {
  let asked: string[];

  /** The feed's granularity for each window, as measured through the executor on 2026-09-14. */
  function feedRows(url: string): OhlcRow[] {
    const days = Number(new URL(url).searchParams.get('days'));
    if (days <= 2) return rows(48 * days, 30 * MIN);
    if (days <= 30) return rows(6 * days, 4 * HOUR);
    return rows(Math.floor(days / 4) + 1, 4 * DAY);
  }

  beforeEach(() => {
    clearMarketDataCache();
    resetPricedSymbols();
    asked = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      const body = url.includes('/market/symbols')
        ? ['BTC', 'XBTC']
        : url.includes('/market/ohlc')
          ? { rows: feedRows(url) }
          : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const ohlcDays = () =>
    asked.filter((u) => u.includes('/market/ohlc')).map((u) => Number(new URL(u).searchParams.get('days')));

  it('offers only the chart timeframes the feed can cut exactly', () => {
    expect(CHART_TIMEFRAMES).toEqual(['1H', '4H', '1D']);
  });

  it.each(CHART_TIMEFRAMES)('draws twelve %s candles from the window that holds them', async (tf) => {
    const out = await fetchChartCandles('BTC', tf);
    expect(ohlcDays()).toEqual([CHART_PLAN[tf].days]);
    expect(out).toHaveLength(12);
  });

  it('asks a year of history for 1Y, and draws the whole of it', async () => {
    expect(HISTORY_DAYS['1Y']).toBe(365);
    const year = await fetchHistory('BTC', '1Y');
    expect(ohlcDays()).toEqual([365]);
    expect(year).toHaveLength(12);
    const week = await fetchHistory('BTC', '1W');
    expect(ohlcDays()).toEqual([365, 7]);
    // Forty-two four-hour rows, all of them: eleven candles, the oldest one short.
    expect(week).toHaveLength(11);
  });

  it('asks nothing for 15m, which fetched the same day as 1H', async () => {
    expect(await fetchCandles('BTC', '15m')).toBeNull();
    expect(ohlcDays()).toEqual([]);
  });

  it('keeps the repository’s windows: a day for 1H, which Portfolio’s cards read, and a week for 4H', async () => {
    await fetchCandles('BTC', '1H');
    await fetchCandles('BTC', '4H');
    expect(ohlcDays()).toEqual([1, 7]);
  });

  it('asks no history for a symbol nothing prices, and says so with null', async () => {
    expect(await fetchHistory('IWM', '1M')).toBeNull();
    expect(await fetchChartCandles('NVDAx', '1H')).toBeNull();
    expect(ohlcDays()).toEqual([]);
  });

  it('knows a tokenized share by its suffix, and nothing else as one', () => {
    expect(isStockSymbol('NVDAx')).toBe(true);
    // SPYx is a wrapped xStock on X Layer, a fund rather than a company, and priced the same way.
    expect(isStockSymbol('SPYx')).toBe(true);
    for (const s of ['BTC', 'XBTC', 'WOKB', 'USDC', 'WETH']) expect(isStockSymbol(s)).toBe(false);
  });
});
