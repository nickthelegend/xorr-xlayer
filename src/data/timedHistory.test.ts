/**
 * The two reads a marked chart is built from (FEATURES.md #9, #45, #83): a range of history that keeps the time each
 * candle covers, and your fills of one token out of the executor's runs.
 *
 * The rows are shaped like the feed's own as the executor relays them, stamped with the moment each row CLOSES — which
 * is what a four-hour row matching the eight thirty-minute rows before its stamp showed on 2026-09-14.
 */
import { describe, expect, it } from 'vitest';
import { fillsKnownFrom, fillsOf, foldWindow, foldWindowTimed, type FillRun, type OhlcRow } from './marketData';
import type { Bar } from './types';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** `n` rows `step` apart, oldest first. Row i opens at i, closes at i + 1, spans i − 1 to i + 2. */
function rows(n: number, step: number, end = Date.UTC(2026, 8, 14, 12)): OhlcRow[] {
  return Array.from({ length: n }, (_, i) => [end - (n - 1 - i) * step, i, i + 2, i - 1, i + 1] as const);
}

const bars = (r: readonly OhlcRow[]): Bar[] => r.map((x) => [x[1], x[2], x[3], x[4]] as const);

describe('a range that keeps its times', () => {
  it('draws the same candles as the untimed fold, bar for bar', () => {
    for (const r of [rows(48, 30 * MIN), rows(42, 4 * HOUR), rows(92, 4 * 24 * HOUR), rows(7, HOUR), rows(1, HOUR)]) {
      expect(foldWindowTimed(r).map((c) => c.bar)).toEqual(foldWindow(bars(r)));
    }
  });

  it('ends each candle at its last row’s stamp, the moment that row closed', () => {
    const r = rows(48, 30 * MIN);
    const day = foldWindowTimed(r);
    expect(day).toHaveLength(12);
    expect(day[0]!.end).toBe(r[3]![0]);
    expect(day.at(-1)!.end).toBe(r.at(-1)![0]);
  });

  it('tiles the window: each candle starts where the last ended, the first a row before its first stamp', () => {
    const r = rows(48, 30 * MIN);
    const day = foldWindowTimed(r);
    expect(day[0]!.start).toBe(r[0]![0] - 30 * MIN);
    for (let i = 1; i < day.length; i++) expect(day[i]!.start).toBe(day[i - 1]!.end);
  });

  it('leaves no gap for a fill to fall through where a row is missing', () => {
    const r = rows(48, 30 * MIN);
    r.splice(20, 1);
    const day = foldWindowTimed(r);
    for (let i = 1; i < day.length; i++) expect(day[i]!.start).toBe(day[i - 1]!.end);
    expect(day[0]!.start).toBe(r[0]![0] - 30 * MIN);
  });

  it('lets a short oldest candle of a week start one row before its own first stamp', () => {
    const r = rows(42, 4 * HOUR);
    const week = foldWindowTimed(r);
    expect(week).toHaveLength(11);
    expect(week[0]).toMatchObject({ start: r[0]![0] - 4 * HOUR, end: r[1]![0] });
  });

  it('has no candles for no rows', () => {
    expect(foldWindowTimed([])).toEqual([]);
  });
});

describe('your fills of one token', () => {
  const run = (over: Partial<FillRun>): FillRun => ({
    symbol: 'XBTC',
    status: 'filled',
    side: 'buy',
    price: 2400,
    finishedAt: '2026-09-14T10:00:00.000Z',
    ...over,
  });

  it('are its filled buys and sells, oldest first, at the time each settled and the price recorded', () => {
    const later = run({ side: 'sell', price: 2510.5, finishedAt: '2026-09-14T11:00:00.000Z' });
    expect(fillsOf([later, run({})], 'XBTC')).toEqual([
      { at: Date.parse('2026-09-14T10:00:00.000Z'), side: 'buy', price: 2400, venue: null },
      { at: Date.parse('2026-09-14T11:00:00.000Z'), side: 'sell', price: 2510.5, venue: null },
    ]);
  });

  it('match the token without regard to case — a route param may spell it xbtc', () => {
    expect(fillsOf([run({ symbol: 'XBTC' })], 'xbtc')).toHaveLength(1);
  });

  it('leave out what is not a fill of this token: refusals, waits, other tokens, cash supplied, a rebalance', () => {
    expect(
      fillsOf(
        [
          run({ status: 'blocked' }),
          run({ status: 'skipped' }),
          run({ status: 'pending' }),
          run({ symbol: 'WOKB' }),
          run({ side: 'supply' }),
          run({ symbol: 'PORTFOLIO' }),
        ],
        'XBTC',
      ),
    ).toEqual([]);
  });

  it('place nothing that would be a guess: no side, no price, no settlement time', () => {
    expect(
      fillsOf(
        [
          run({ side: null }),
          run({ side: undefined }),
          run({ price: null }),
          run({ price: 0 }),
          run({ finishedAt: null }),
          run({ finishedAt: 'not a time' }),
        ],
        'XBTC',
      ),
    ).toEqual([]);
  });
});

describe('where each fill happened, and which run recorded it (FEATURES.md #77)', () => {
  const run = (over: Partial<FillRun>): FillRun => ({
    symbol: 'NVDAX',
    status: 'filled',
    side: 'buy',
    price: 180,
    finishedAt: '2026-09-17T10:00:00.000Z',
    ...over,
  });

  it('carries the recorded venue and the run id with the fill, unchanged', () => {
    expect(fillsOf([run({ id: 'r1', venue: 'uniswap-v3' })], 'NVDAx')).toEqual([
      { at: Date.parse('2026-09-17T10:00:00.000Z'), side: 'buy', price: 180, venue: 'uniswap-v3', id: 'r1' },
    ]);
    expect(fillsOf([run({ venue: 'okx-dex', side: 'sell' })], 'NVDAx')[0]!.venue).toBe('okx-dex');
  });

  it('records no venue as null — a run that wrote none is not given one', () => {
    expect(fillsOf([run({ venue: null }), run({ venue: '  ' }), run({})], 'NVDAx').map((f) => f.venue)).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe('how far back the runs are known to hold every fill', () => {
  const at = (iso: string) => ({ at: iso });

  it('is all of it when the page is short of the limit', () => {
    expect(fillsKnownFrom([at('2026-09-17T10:00:00Z')], 200)).toBeNull();
    expect(fillsKnownFrom([], 200)).toBeNull();
  });

  it('is from the oldest run when the page is full, since an older run may be missing', () => {
    const page = [at('2026-09-17T10:00:00Z'), at('2026-09-15T08:00:00Z'), at('2026-09-16T00:00:00Z')];
    expect(fillsKnownFrom(page, 3)).toBe(Date.parse('2026-09-15T08:00:00Z'));
  });

  it('is nothing known at all when a full page carries no readable time', () => {
    expect(fillsKnownFrom([at('garbage')], 1)).toBe(Number.POSITIVE_INFINITY);
  });
});
