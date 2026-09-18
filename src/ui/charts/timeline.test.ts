import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  continuityWindowMs,
  netInvestedSteps,
  observedRuns,
  recordedCount,
  timelineBounds,
  type TimelineFill,
  type TimelineObservation,
} from './timeline';

const MIN = 60_000;
const buy = (at: number, usd: number): TimelineFill => ({ at, usd, side: 'buy' });
const sell = (at: number, usd: number): TimelineFill => ({ at, usd, side: 'sell' });
const obs = (at: number, totalUsd: number): TimelineObservation => ({ at, totalUsd });

describe('netInvestedSteps — one step per recorded fill, and nothing between them', () => {
  it('adds a buy and subtracts a sale, in time order', () => {
    expect(netInvestedSteps([buy(3, 50), buy(1, 100), sell(2, 30)])).toEqual([
      { at: 1, netInvestedUsd: 100 },
      { at: 2, netInvestedUsd: 70 },
      { at: 3, netInvestedUsd: 120 },
    ]);
  });

  /*
   * The line is flat between fills because the value IS flat between fills — not approximately, exactly. That is what
   * makes this the one series here that can be joined between two points without claiming anything.
   */
  it('produces a point only where a fill happened', () => {
    const steps = netInvestedSteps([buy(1_000, 10), buy(9_000_000, 10)]);
    expect(steps.map((s) => s.at)).toEqual([1_000, 9_000_000]);
  });

  /* A wallet that has taken out more than it put in has recovered its stake; flooring that at zero hides the moment. */
  it('goes below zero rather than clamping', () => {
    const steps = netInvestedSteps([buy(1, 100), sell(2, 250)]);
    expect(steps[1]!.netInvestedUsd).toBe(-150);
  });

  /* The executor records the side. Guessing it would move the line in the wrong direction. */
  it('ignores a fill that does not say which way it went', () => {
    expect(netInvestedSteps([{ at: 1, usd: 100, side: null }, { at: 2, usd: 50, side: undefined }])).toEqual([]);
  });

  it('leaves out amounts that are not amounts', () => {
    expect(
      netInvestedSteps([
        buy(1, Number.NaN),
        buy(2, Number.POSITIVE_INFINITY),
        buy(3, 0),
        buy(4, -5),
        buy(5, 25),
      ]),
    ).toEqual([{ at: 5, netInvestedUsd: 25 }]);
  });

  it('collapses fills recorded at the same instant into one step', () => {
    const steps = netInvestedSteps([buy(7, 100), buy(7, 50)]);
    expect(steps).toEqual([{ at: 7, netInvestedUsd: 150 }]);
  });

  it('has nothing to draw for a wallet that has never filled', () => {
    expect(netInvestedSteps([])).toEqual([]);
  });
});

describe('observedRuns — a line only where looking was continuous', () => {
  const window = 45 * MIN;

  it('joins readings recorded close together', () => {
    const runs = observedRuns([obs(0, 100), obs(15 * MIN, 110), obs(30 * MIN, 120)], window);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(3);
  });

  /*
   * The break is the point. A line drawn across three unobserved days is a claim about three days nobody looked at,
   * and it is indistinguishable from a line across three observed minutes.
   */
  it('breaks where nothing was recorded for longer than the window', () => {
    const runs = observedRuns([obs(0, 100), obs(15 * MIN, 110), obs(3 * 24 * 60 * MIN, 400)], window);
    expect(runs.map((r) => r.length)).toEqual([2, 1]);
    expect(runs[1]![0]!.totalUsd).toBe(400);
  });

  it('sorts readings that arrive out of order', () => {
    const runs = observedRuns([obs(30 * MIN, 120), obs(0, 100)], window);
    expect(runs[0]!.map((p) => p.at)).toEqual([0, 30 * MIN]);
  });

  it('leaves out readings that are not readings', () => {
    const runs = observedRuns([obs(0, Number.NaN), obs(1 * MIN, 100)], window);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(1);
  });

  /* A lone reading surrounded by silence is a point, not a line to nowhere. */
  it('keeps a lone reading as a run of one', () => {
    expect(observedRuns([obs(0, 100)], window)).toEqual([[{ at: 0, totalUsd: 100 }]]);
  });

  it('has nothing to draw with no readings', () => {
    expect(observedRuns([], window)).toEqual([]);
  });
});

describe('continuityWindowMs — what counts as still watching', () => {
  it('is a few cadences wide, so a tick that ran late is still continuous', () => {
    expect(continuityWindowMs(15)).toBe(45 * MIN);
  });

  /*
   * Not knowing the cadence must not become an assumption that everything is continuous. Zero joins nothing, so every
   * reading stands alone — the safe direction to be wrong in.
   */
  it('joins nothing when the cadence is unknown or nonsense', () => {
    for (const v of [undefined, 0, -5, Number.NaN]) expect(continuityWindowMs(v as number | undefined)).toBe(0);
    expect(observedRuns([obs(0, 1), obs(1, 2)], continuityWindowMs(undefined)).length).toBe(2);
  });
});

describe('timelineBounds — the axis says what the data reached', () => {
  it('spans both series together so they can be read against each other', () => {
    const steps = netInvestedSteps([buy(10, 100)]);
    const runs = observedRuns([obs(20, 250), obs(25, 80)], 60 * MIN);
    expect(timelineBounds(steps, runs)).toEqual({ minAt: 10, maxAt: 25, minUsd: 80, maxUsd: 250 });
  });

  it('is undefined when there is nothing recorded at all', () => {
    expect(timelineBounds([], [])).toBeUndefined();
  });
});

describe('recordedCount — enough to draw, or not', () => {
  it('counts every recorded thing across both series', () => {
    const steps = netInvestedSteps([buy(1, 10), buy(2, 10)]);
    const runs = observedRuns([obs(3, 5)], 60 * MIN);
    expect(recordedCount(steps, runs)).toBe(3);
  });

  /* Zero and one are the two the chart must refuse to draw as a trend; the screen says which it is. */
  it('reports nothing and one, so the screen can say so instead of drawing a trend', () => {
    expect(recordedCount([], [])).toBe(0);
    expect(recordedCount(netInvestedSteps([buy(1, 10)]), [])).toBe(1);
  });
});

describe('the drawing keeps the same promise as the arithmetic', () => {
  const src = fs
    .readFileSync(new URL('./ValueTimeline.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');

  /*
   * The rule the allocation donut established and this chart inherits: motion may reveal what is there, never move a
   * value from one number to another. An interpolated point is a value the wallet never had, drawn at full confidence.
   */
  it('reveals, and never animates a value', () => {
    expect(src).toMatch(/ClipPath/);
    expect(src).toMatch(/duration\.draw/);
    // No easing of a datum: the clip's width is the one thing driven by an animation.
    expect(src.match(/useAnimatedProps\(/g) ?? []).toHaveLength(1);
    expect(/withRepeat|withSequence|withSpring/.test(src)).toBe(false);
  });

  /* Curve commands are how a chart starts implying values between the points it was given. */
  it('draws straight segments only — no curve is ever fitted', () => {
    expect(/[ "']C |[ "']Q |[ "']S |[ "']T |curve|bezier/i.test(src)).toBe(false);
  });

  /* Fewer than two recorded things is not a trend, and must not reach the drawing at all. */
  it('refuses to draw a chart from fewer than two recorded things', () => {
    expect(src).toMatch(/count < 2/);
  });
});
