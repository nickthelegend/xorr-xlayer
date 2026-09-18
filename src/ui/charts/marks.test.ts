/**
 * Where a fill is marked (FEATURES.md #9). Every rule a mark obeys is here: the candle or the place along the line it
 * lands on, what is left off because it is outside the chart, and the projection making room for its price.
 */
import { describe, expect, it } from 'vitest';
import {
  candleMarks,
  closeLine,
  describeMarks,
  lineMarks,
  markDetail,
  markPath,
  sameFill,
  type TimedFill,
} from './marks';
import { tightProjection, toPct } from './projection';

const buy = (at: number, price = 100): TimedFill => ({ at, side: 'buy', price });
const sell = (at: number, price = 100): TimedFill => ({ at, side: 'sell', price });

describe('the line a run of candles draws', () => {
  it('starts at the window’s first open and ends each candle at its close', () => {
    const candles = [
      { open: 1, close: 2 },
      { open: 2, close: 3 },
    ];
    const spans = [
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ];
    expect(closeLine(candles, spans)).toEqual({ values: [1, 2, 3], times: [0, 10, 20] });
  });

  it('draws nothing without candles, and pairs no further than the shorter list', () => {
    expect(closeLine([], [])).toEqual({ values: [], times: [] });
    expect(closeLine([{ open: 1, close: 2 }], [])).toEqual({ values: [], times: [] });
  });
});

describe('a fill on a line', () => {
  const times = [0, 10, 20];

  it('sits between the two points either side of it, by time', () => {
    expect(lineMarks([buy(15, 7)], times)).toEqual([{ position: 1.5, side: 'buy', price: 7, at: 15 }]);
    expect(lineMarks([sell(2.5)], times)).toEqual([{ position: 0.25, side: 'sell', price: 100, at: 2.5 }]);
  });

  it('sits on a point when it happened at that point’s time, the ends included', () => {
    expect(lineMarks([buy(0), buy(10), buy(20)], times).map((m) => m.position)).toEqual([0, 1, 2]);
  });

  it('is left off before the line starts and after its newest point', () => {
    expect(lineMarks([buy(-1), sell(21)], times)).toEqual([]);
  });

  it('has no line to sit on when there is none, and one place on a single point', () => {
    expect(lineMarks([buy(5)], [])).toEqual([]);
    expect(lineMarks([buy(5), buy(6)], [5])).toEqual([{ position: 0, side: 'buy', price: 100, at: 5 }]);
  });
});

describe('a fill on a candle chart', () => {
  const spans = [
    { start: 0, end: 10 },
    { start: 10, end: 20 },
  ];

  it('goes in the candle whose stretch holds it — one at a close belongs to the candle that closed', () => {
    expect(candleMarks([buy(5), sell(10), buy(10.5), sell(20)], spans)).toEqual([
      { index: 0, side: 'buy', price: 100, at: 5 },
      { index: 0, side: 'sell', price: 100, at: 10 },
      { index: 1, side: 'buy', price: 100, at: 10.5 },
      { index: 1, side: 'sell', price: 100, at: 20 },
    ]);
  });

  it('is left off at or before the window’s start, and after its end', () => {
    expect(candleMarks([buy(0), buy(-3), sell(20.001)], spans)).toEqual([]);
  });

  it('is in frame on the tight projection even when priced outside every candle', () => {
    const series = [{ open: 100, high: 110, low: 90, close: 105 }];
    const p = tightProjection(series, [80]);
    expect(p.lo).toBeLessThan(80);
    expect(toPct(p, 80)).toBeLessThan(100);
    expect(toPct(p, 80)).toBeGreaterThan(0);
    // No fills, no change: the projection is exactly what the candles alone asked for.
    expect(tightProjection(series, [])).toEqual(tightProjection(series));
  });
});

describe('what a mark looks like and says', () => {
  const corners = (d: string) =>
    d
      .replace(/[MLZ]/g, ' ')
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(',').map(Number));

  it('points up for a buy and down for a sell, centred on its point', () => {
    const [apexUp, ...baseUp] = corners(markPath(50, 50, 'buy', 4));
    expect(apexUp).toEqual([50, 46]);
    for (const [, y] of baseUp) expect(y).toBe(52);
    const [apexDown, ...baseDown] = corners(markPath(50, 50, 'sell', 4));
    expect(apexDown).toEqual([50, 54]);
    for (const [, y] of baseDown) expect(y).toBe(48);
  });

  it('counts buys and sells for a screen reader, and says nothing of none', () => {
    expect(describeMarks([{ side: 'buy' }])).toBe('1 buy marked');
    expect(describeMarks([{ side: 'sell' }, { side: 'buy' }, { side: 'buy' }])).toBe('2 buys and 1 sell marked');
    expect(describeMarks([{ side: 'sell' }, { side: 'sell' }])).toBe('2 sells marked');
    expect(describeMarks([])).toBe('');
  });
});

describe('an entry or exit, inspected (FEATURES.md #77)', () => {
  const times = [0, 10, 20];

  it('keeps the fill’s own recorded time, venue and run — not the time of the point it sits beside', () => {
    const fill: TimedFill = { at: 13, side: 'sell', price: 101.5, venue: 'uniswap-v3', id: 'run-1' };
    const [onLine] = lineMarks([fill], times);
    expect(onLine).toEqual({ position: 1.3, side: 'sell', price: 101.5, at: 13, venue: 'uniswap-v3', id: 'run-1' });
    const [inCandle] = candleMarks([fill], [{ start: 10, end: 20 }]);
    expect(inCandle).toEqual({ index: 0, side: 'sell', price: 101.5, at: 13, venue: 'uniswap-v3', id: 'run-1' });
  });

  it('adds no venue or run the fill did not have', () => {
    const [m] = lineMarks([buy(10)], times);
    expect(m).not.toHaveProperty('venue');
    expect(m).not.toHaveProperty('id');
  });

  it('names a Uniswap v3 swap as routed, and an Aave supply as Aave — never a trade', () => {
    expect(markDetail({ side: 'buy', venue: 'uniswap-v3' })).toEqual({
      action: 'Bought',
      venue: 'Uniswap v3',
      routed: true,
    });
    const supply = markDetail({ side: 'sell', venue: 'aave' });
    expect(supply).toEqual({ action: 'Sold', venue: 'Aave', routed: false });
    expect(supply.venue).not.toMatch(/swap|route|uniswap/i);
  });

  it('says a venue was not recorded rather than borrowing one, and shows one it cannot name verbatim', () => {
    expect(markDetail({ side: 'buy', venue: null })).toEqual({ action: 'Bought', venue: 'Venue not recorded' });
    expect(markDetail({ side: 'buy' })).toEqual({ action: 'Bought', venue: 'Venue not recorded' });
    expect(markDetail({ side: 'sell', venue: 'phoenix-v9' }).venue).toBe('phoenix-v9');
  });

  it('knows the same fill by its run, or by its moment, side and price when there is no run', () => {
    expect(sameFill({ at: 1, side: 'buy', price: 2, id: 'a' }, { at: 9, side: 'sell', price: 3, id: 'a' })).toBe(true);
    expect(sameFill({ at: 1, side: 'buy', price: 2, id: 'a' }, { at: 1, side: 'buy', price: 2, id: 'b' })).toBe(false);
    expect(sameFill({ at: 1, side: 'buy', price: 2 }, { at: 1, side: 'buy', price: 2 })).toBe(true);
    expect(sameFill({ at: 1, side: 'buy', price: 2 }, { at: 1, side: 'sell', price: 2 })).toBe(false);
  });
});
