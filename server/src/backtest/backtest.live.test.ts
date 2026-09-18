/** Real historical replay against the live feed — PLAN.md 12.22 [G32]. */
import { describe, expect, it } from 'vitest';
import { backtestDca } from './engine.js';

describe('a backtest computed from REAL history, not hardcoded rows', () => {
  it('replays a weekly $50 SOL buy over 90 days', async () => {
    const r = await backtestDca({
      symbol: 'SOL',
      lookback: '90d',
      perRunUsd: 50,
      dailyCapUsd: 1600,
      everyNDays: 7,
    });
    expect(r.lookback).toBe('90d');
    expect(r.feed).toBe('live');
    expect(r.source).toContain('coingecko');
    expect(r.disclaimer).toBe('Nothing here is a promise.');
    // ~90 daily points at one buy a week.
    expect(r.trades).toBeGreaterThanOrEqual(11);
    expect(r.trades).toBeLessThanOrEqual(15);
    expect(Number.isFinite(r.ret)).toBe(true);
    expect(r.maxDd).toBeLessThanOrEqual(0);
    expect(r.equity.length).toBeGreaterThan(5);
  }, 90_000);

  it('honours the daily cap — screen 17 promises "at your current limits"', async () => {
    const capped = await backtestDca({
      symbol: 'SOL',
      lookback: '30d',
      perRunUsd: 5000,
      dailyCapUsd: 200, // the cap, not the ask, is what gets deployed
      everyNDays: 7,
    });
    const uncapped = await backtestDca({
      symbol: 'SOL',
      lookback: '30d',
      perRunUsd: 200,
      dailyCapUsd: 5000,
      everyNDays: 7,
    });
    // Same money deployed either way, so the same return.
    expect(capped.ret).toBeCloseTo(uncapped.ret, 1);
  }, 90_000);

  it('different lookbacks give genuinely different results', async () => {
    /*
     * The LONGER window first, deliberately.
     *
     * A year of history contains the last thirty days of it, so asking for `1y` and then `30d`
     * costs one upstream request instead of two — and the two results are then provably the same
     * data measured over different spans rather than two fetches that could disagree. Asked the
     * other way round this made two cold calls through a rate-limited queue, each waiting out its
     * own retry ladder, and timed out.
     */
    const b = await backtestDca({ symbol: 'BTC', lookback: '1y', perRunUsd: 50, dailyCapUsd: 1600, everyNDays: 7 });
    const a = await backtestDca({ symbol: 'BTC', lookback: '30d', perRunUsd: 50, dailyCapUsd: 1600, everyNDays: 7 });
    expect(b.trades).toBeGreaterThan(a.trades);
    expect(a.equity).not.toEqual(b.equity);
    // The shorter span is a slice of the longer one, so its last close is the same day's close.
    expect(a.equity.length).toBeLessThan(b.equity.length);
  }, 120_000);
});
