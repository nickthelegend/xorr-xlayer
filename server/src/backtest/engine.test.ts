import { describe, expect, it, vi } from 'vitest';
import { getJson } from '../http/get.js';
import {
  LOOKBACKS,
  backtestDca,
  backtestGrid,
  backtestMomentum,
  curvePoints,
  daily,
  isLookback,
  maxDrawdown,
  sharpeRatio,
  type Lookback,
} from './engine.js';

// No test here reaches an upstream, and a refused lookback must be refused before any history is asked for.
vi.mock('../http/get.js', () => ({ getJson: vi.fn() }));

describe('a lookback there is no window for (docs/qa/ENDPOINTS.md E026)', () => {
  it('is refused before any history is fetched — never replayed as a flat 0% over 0 trades', async () => {
    const week = '7d' as Lookback;
    await expect(backtestMomentum({ symbol: 'WETH', lookback: week, usdPerEntry: 500, dailyCapUsd: 1_600 })).rejects.toThrow('7d');
    await expect(
      backtestDca({ symbol: 'WETH', lookback: week, perRunUsd: 50, dailyCapUsd: 1_600, everyNDays: 7 }),
    ).rejects.toThrow('7d');
    await expect(
      backtestGrid({ symbol: 'WETH', lookback: week, lower: 1_000, upper: 2_000, steps: 4, usdPerStep: 25 }),
    ).rejects.toThrow('7d');
    expect(getJson).not.toHaveBeenCalled();
  });

  it('knows exactly the four windows a caller may ask for, and nothing that merely looks like one', () => {
    expect(LOOKBACKS).toEqual(['30d', '90d', '6m', '1y']);
    expect(LOOKBACKS.every((l) => isLookback(l))).toBe(true);
    for (const other of ['7d', '2y', '', '90D', 'constructor']) expect(isLookback(other), other).toBe(false);
  });
});

describe('12.22 backtest maths', () => {
  it('max drawdown is the worst peak-to-trough, as a negative percentage', () => {
    expect(maxDrawdown([100, 120, 60, 90])).toBeCloseTo(-50, 6);
    expect(maxDrawdown([100, 110, 120])).toBe(0);
    expect(maxDrawdown([100, 90, 95, 80])).toBeCloseTo(-20, 6);
  });

  it('sharpe is zero for a flat series and positive for a steady climb', () => {
    expect(sharpeRatio([0, 0, 0, 0])).toBe(0);
    expect(sharpeRatio([0.01, 0.011, 0.009, 0.01])).toBeGreaterThan(0);
    expect(sharpeRatio([-0.01, -0.011, -0.009])).toBeLessThan(0);
  });

  it('the curve downsamples to a readable length and keeps the real values', () => {
    const equity = Array.from({ length: 365 }, (_, i) => 1000 + i);
    const pts = curvePoints(equity);
    expect(pts.length).toBeGreaterThan(5);
    expect(pts.length).toBeLessThan(60); // downsampled to stay readable
    // Values, not viewBox coordinates: every point is one the series actually held.
    for (const v of pts) expect(equity).toContain(v);
    // A rising series still rises.
    expect(pts[pts.length - 1]!).toBeGreaterThan(pts[0]!);
  });

  it('the last point survives the downsample', () => {
    // The screen quotes the final equity beside the chart. A line that stops a stride short
    // of it disagrees with the number next to it.
    for (const n of [7, 40, 41, 100, 365]) {
      const equity = Array.from({ length: n }, (_, i) => 1000 + i * 3);
      expect(curvePoints(equity).at(-1)).toBe(equity.at(-1));
    }
  });

  it('a falling series ends lower', () => {
    const pts = curvePoints(Array.from({ length: 100 }, (_, i) => 1000 - i));
    expect(pts[pts.length - 1]!).toBeLessThan(pts[0]!);
  });

  it('an empty series gives no points rather than a fabricated one', () => {
    expect(curvePoints([])).toEqual([]);
  });
});

describe('daily sampling', () => {
  const DAY = 86_400_000;

  it('keeps one point per UTC day — the last, which is that day\'s close', () => {
    const pts: [number, number][] = [
      [DAY * 10, 1],
      [DAY * 10 + 3_600_000, 2],
      [DAY * 10 + 7_200_000, 3],
      [DAY * 11, 4],
    ];
    expect(daily(pts)).toEqual([
      [DAY * 10 + 7_200_000, 3],
      [DAY * 11, 4],
    ]);
  });

  it('leaves an already-daily series alone', () => {
    /*
     * The whole point: past 90 days CoinGecko returns daily points, under it hourly. One code
     * path has to serve both, or a 90-day backtest runs twenty-four times the trades a weekly
     * schedule should — which is exactly what happened when the granularity was left to the API.
     */
    const pts: [number, number][] = [
      [DAY * 1, 1],
      [DAY * 2, 2],
      [DAY * 3, 3],
    ];
    expect(daily(pts)).toEqual(pts);
  });

  it('is empty for an empty series rather than inventing a day', () => {
    expect(daily([])).toEqual([]);
  });
});
