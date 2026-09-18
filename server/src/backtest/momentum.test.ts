/**
 * That the momentum backtest implements the momentum strategy.
 *
 * `GET /agents/:id/backtest` used to run a weekly DCA for every agent, and never read `:id` at all
 * — `const id = await walletId(c)` shadowed the route param — so Momentum Scout's published track
 * record was a $50-a-week buy of SOL. It returned a plausible number, which is exactly why nothing
 * caught it: the only way to know a backtest runs the right rule is to feed it a series built to
 * trigger that rule and check it did.
 *
 * The rule under test is tier 6 in `executor/kinds/index.ts`: enter when the close exceeds the
 * highest close of the preceding window AND the fast average is above the slow one; exit when the
 * close falls to the stop set below the entry.
 */
import { describe, expect, it } from 'vitest';
import { momentumReplay } from './engine.js';

const OPTS = { days: 1000, window: 5, stopPct: 10, size: 1000 };

/** A dead-flat stretch. Breaks out of nothing — see the trend-filter test below. */
const flat = (n: number, at = 100) => Array.from({ length: n }, () => at);

/**
 * A gently rising stretch — what the run-up to a real breakout looks like.
 *
 * Fixtures here were flat before a break, and every entry test failed: on a flat window the fast
 * and slow averages are the SAME number, and the rule requires the fast to be strictly greater.
 * That is the live planner's behaviour, not an artefact, so the fixtures moved rather than the
 * comparison.
 */
const ramp = (n: number, from = 100, step = 0.5) =>
  Array.from({ length: n }, (_, i) => from + i * step);

describe('momentumReplay', () => {
  it('does nothing at all on a flat market', () => {
    const { trades, equity } = momentumReplay(flat(40), OPTS);
    expect(trades).toBe(0);
    expect(new Set(equity)).toEqual(new Set([1000]));
  });

  it('never enters on a falling market, however far it falls', () => {
    expect(momentumReplay(ramp(40, 200, -2), OPTS).trades).toBe(0);
  });

  it('needs the trend, not just the high: a break out of a flat range does not fire', () => {
    // 130 clears the window high of 100 easily. The fast and slow averages are both exactly 100,
    // and the rule wants fast > slow — so this is deliberately not a trade. Pinned because it is
    // the difference between "buys strength" and "buys any spike".
    expect(momentumReplay([...flat(12, 100), 130, ...flat(12, 130)], OPTS).trades).toBe(0);
  });

  it('enters once on a sustained uptrend and then holds', () => {
    // A Donchian breakout fires on the first bar that clears its window, which on a steady climb
    // is early — the entry here is at 103, not at some later dramatic bar. That IS the strategy:
    // it buys the start of strength. Pinned so a later "improvement" that waits cannot pass.
    const { trades, equity } = momentumReplay([...ramp(12), ...flat(8, 105.5)], OPTS);
    expect(trades).toBe(1);
    // Entered and held: the tail is the position's value, a touch above the capital committed.
    expect(equity.at(-1)!).toBeGreaterThan(1000);
    expect(equity.at(-1)!).toBeLessThan(1100);
  });

  it('does not re-enter a position it already holds', () => {
    // Every bar after the entry is a new high. Without the open-position guard this buys on all
    // of them, which is how one breakout becomes four times the intended size into the reversal.
    const { trades, equity } = momentumReplay([...ramp(12), ...ramp(20, 130, 5)], OPTS);
    expect(trades).toBe(1);
    // One position, ridden the whole way up: 103 to 225 is a bit over a double.
    expect(equity.at(-1)!).toBeGreaterThan(2000);
  });

  it('exits when the close reaches the stop, and the exit is a second trade', () => {
    // Entry at 103 puts the stop at 92.70. The 92 bar is the first to reach it.
    const { trades, equity } = momentumReplay([...ramp(12), 92, ...flat(4, 92)], OPTS);
    expect(trades).toBe(2);
    // A 10% stop on 1000 is 900 before costs; both legs pay fee and slippage, so slightly less.
    expect(equity.at(-1)!).toBeLessThan(900);
    expect(equity.at(-1)!).toBeGreaterThan(870);
  });

  it('stays in cash after a stop until a new trend forms', () => {
    // Stopped out at 92, then flat. A flat window means fast === slow, so nothing re-enters.
    const { trades } = momentumReplay([...ramp(12), 92, ...flat(10, 92)], OPTS);
    expect(trades).toBe(2);
  });

  it('can re-enter once a fresh trend clears a fresh high', () => {
    const series = [...ramp(12), 92, 93, 94, 95, 96, 97, ...flat(3, 97)];
    expect(momentumReplay(series, OPTS).trades).toBe(3); // in, out, in
  });

  it('reports only the requested window, using the bars before it as warm-up', () => {
    const series = ramp(40);
    expect(momentumReplay(series, { ...OPTS, days: 10 }).equity).toHaveLength(10);
    expect(momentumReplay(series, { ...OPTS, days: 5 }).equity).toHaveLength(5);
  });

  it('never spends more than the size it was given', () => {
    const { equity } = momentumReplay([...ramp(12), ...ramp(20, 130, 5)], OPTS);
    // Equity can grow with the position, but the first bar is bounded by the capital committed.
    expect(equity[0]!).toBeLessThanOrEqual(1000);
  });
});
