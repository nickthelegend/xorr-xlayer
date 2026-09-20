/**
 * The book's read path, against the real exported data.
 *
 * Not mocked: `data/strategies` is committed, so these assert on the same bytes the deployed executor
 * serves. What is pinned is the honesty, not the numbers — a regeneration will move every return, and
 * these should still pass. What must never change is that an unmeasured field stays absent, that a thin
 * sample is marked thin, and that a tier is something the evidence earned.
 */
import { describe, expect, it } from 'vitest';
import { catalogDetail, catalogIndex, counts, isSlug, selectRows } from './catalog.js';

const index = await catalogIndex();

describe('the book', () => {
  it('carries the window every number was measured over', () => {
    const w = index.window;
    expect(w.bars).toBeGreaterThan(1000);
    expect(w.barsUnseen).toBeGreaterThan(0);
    expect(w.symbols.length).toBeGreaterThan(1);
    // Costs are part of the measurement, not a footnote: a return quoted without them is a different claim.
    expect(w.feeBpsPerSide).toBeGreaterThan(0);
    expect(w.interval).toBe('1h');
  });

  it('is every registered strategy, not the flattering ones', () => {
    expect(index.strategies.length).toBeGreaterThan(300);
    const c = counts(index.strategies);
    expect(c.archive).toBeGreaterThan(0);
    expect(c.total).toBe(index.strategies.length);
    expect(c.verified + c.measured + c.archive).toBe(c.total);
  });

  it('never publishes a win rate for a strategy that never traded', () => {
    for (const r of index.strategies) {
      if (r.trades === 0) {
        // Absent, never zero. A 0% win rate asserts that every trade lost.
        expect(r.winRate ?? null, r.slug).toBeNull();
        expect(r.profitFactor ?? null, r.slug).toBeNull();
      }
    }
  });

  it('marks a thin sample as thin', () => {
    for (const r of index.strategies) {
      expect(r.trusted, r.slug).toBe(r.trades >= 30);
    }
  });

  it('only calls a strategy verified when the gauntlet passed it', () => {
    for (const r of index.strategies) {
      if (r.tier === 'verified') expect(r.survives, r.slug).toBe(true);
    }
  });
});

describe('ordering', () => {
  it('sorts by the measured column, and seats the unmeasured last', () => {
    const rows = selectRows(index.strategies, { sort: 'sharpe' });
    const measured = rows.filter((r) => typeof r.sharpe === 'number');
    const rest = rows.slice(measured.length);
    // Every measured row comes before every unmeasured one — not interleaved as though zero were a reading.
    expect(rest.every((r) => typeof r.sharpe !== 'number')).toBe(true);
    for (let i = 1; i < measured.length; i += 1) {
      expect(measured[i - 1]!.sharpe!).toBeGreaterThanOrEqual(measured[i]!.sharpe!);
    }
  });

  it('sorts drawdown the way a reader means it — smallest first', () => {
    const rows = selectRows(index.strategies, { sort: 'drawdown', trustedOnly: true });
    const dd = rows.map((r) => r.maxDrawdownPct).filter((v): v is number => typeof v === 'number');
    for (let i = 1; i < dd.length; i += 1) expect(dd[i - 1]!).toBeLessThanOrEqual(dd[i]!);
  });

  it('filters to a tier and to the trusted', () => {
    const verified = selectRows(index.strategies, { tier: 'verified' });
    expect(verified.every((r) => r.tier === 'verified')).toBe(true);
    const trusted = selectRows(index.strategies, { trustedOnly: true });
    expect(trusted.every((r) => r.trades >= 30)).toBe(true);
  });
});

describe('one strategy', () => {
  it('reads back with a curve, a distribution and trades that reconcile', async () => {
    const traded = selectRows(index.strategies, { trustedOnly: true, sort: 'trades' })[0]!;
    const d = (await catalogDetail(traded.slug)) as Record<string, any>;
    expect(d.slug).toBe(traded.slug);
    expect(d.equityCurve.length).toBeGreaterThan(10);
    // The curve starts at the index base and ends where the summary says the account ended.
    expect(d.equityCurve[0]).toBe(100);
    expect(d.equityCurve.at(-1)).toBeCloseTo(d.unseen.finalEquity, 1);
    expect(d.distribution.length).toBeGreaterThan(0);
    expect(d.trades.length).toBe(Math.min(d.tradesTotal, 150));

    /*
     * Gross, costs and net are one equation, and this is the assertion that keeps them one.
     *
     * The research engine's per-trade `pnl_usd` is net of the EXIT fee only — the entry fee is taken from
     * cash when the position opens — so a structure built from it reported a profit beside a losing curve.
     * The export builds it from the trade log's own gross and fees instead.
     */
    const s = d.structure;
    expect(s.grossProfitUsd + s.grossLossUsd + s.commissionUsd).toBeCloseTo(s.netPnlUsd, 1);
    // And the equation's answer is the account's own result, not a second opinion about it.
    expect(s.netPnlUsd).toBeCloseTo(d.unseen.finalEquity - d.window.startEquity, 1);
  });

  it('refuses a slug that could name a file somewhere else', () => {
    expect(isSlug('../../../etc/passwd')).toBe(false);
    expect(isSlug('b100_vol_5')).toBe(true);
    expect(catalogDetail('../index')).toBeUndefined();
  });

  it('is undefined for a strategy the book does not have', async () => {
    expect(await catalogDetail('no_such_strategy_here')).toBeUndefined();
  });
});
