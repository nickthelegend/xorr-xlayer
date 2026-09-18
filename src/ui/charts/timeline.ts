/**
 * timeline.ts — a portfolio's history as the things that were actually recorded.
 *
 * Two different facts, drawn two different ways, because they are true in two different ways.
 *
 * ## Net invested — a step line, and genuinely one
 *
 * Every fill the executor recorded moves it: a buy adds what was spent, a sale subtracts what came back. Between two
 * fills it does not move **at all** — not approximately, not probably, exactly. So a flat run between two fills is not
 * an interpolation standing in for values nobody saw; it is the value, held, until the next recorded event changed it.
 * This is the one line on the chart that can be drawn between two points without claiming anything.
 *
 * It can go below zero, and that is a real answer rather than a floor to clamp: a wallet that has taken out more than it
 * put in has recovered its stake, and showing that as zero would hide the moment it happened.
 *
 * ## Observed value — points, and a line only where looking was continuous
 *
 * What the portfolio was *worth* is different. It moves between observations, and nothing recorded how. The executor
 * snapshots on a cadence and at every fill, close and withdrawal, so consecutive snapshots minutes apart can honestly be
 * joined: the reading held until the next reading replaced it. Two observations three days apart cannot — the line
 * between them would be a claim about three days nobody looked at.
 *
 * So observations are split into runs of readings recorded close enough together to be continuous, and the gaps between
 * those runs are drawn as gaps. A break in the line means "nothing was recorded here", which is the truth, and is a
 * thing the reader can see.
 *
 * ## What is never done
 *
 * No value is interpolated, smoothed or curve-fitted. No point is synthesised at the edges to make a line reach the
 * axis. A single observation is a single observation and is never drawn as a trend — one point has no direction, and a
 * chart that gives it one is inventing the only thing the reader came for.
 */

/** One recorded fill, as `/runs` reports it. */
export type TimelineFill = {
  at: number;
  /** What was spent on a buy, or received on a sale. */
  usd: number;
  side: 'buy' | 'sell' | null | undefined;
};

/** One recorded reading of what the whole wallet was worth. */
export type TimelineObservation = {
  at: number;
  totalUsd: number;
};

/** A step in the net-invested line: from this moment, it was this. */
export type InvestedStep = {
  at: number;
  netInvestedUsd: number;
};

/**
 * Whether a recorded number can take part.
 *
 * A fill with an unreadable amount is not a fill of zero, and letting one through would move the invested line by an
 * amount nobody spent.
 */
function usable(n: number): boolean {
  return Number.isFinite(n);
}

/**
 * The net invested line, one step per recorded fill, oldest first.
 *
 * Fills at the very same millisecond collapse into one step: two steps at one x are a vertical line the eye reads as a
 * single jump anyway, and keeping both would put two points at the same place in the path.
 */
export function netInvestedSteps(fills: readonly TimelineFill[]): InvestedStep[] {
  const usableFills = fills
    .filter((f) => Number.isFinite(f.at) && usable(f.usd) && f.usd > 0)
    .sort((a, b) => a.at - b.at);

  const steps: InvestedStep[] = [];
  let running = 0;
  for (const fill of usableFills) {
    // A sale returns money to the wallet, so it reduces what is still committed. An unlabelled fill is not assumed to
    // be either: the executor records the side, and guessing it would put the line in the wrong direction.
    if (fill.side === 'buy') running += fill.usd;
    else if (fill.side === 'sell') running -= fill.usd;
    else continue;

    const last = steps[steps.length - 1];
    if (last && last.at === fill.at) last.netInvestedUsd = running;
    else steps.push({ at: fill.at, netInvestedUsd: running });
  }
  return steps;
}

/**
 * Observations grouped into runs that were recorded continuously.
 *
 * A new run begins wherever the gap to the previous reading is longer than `maxGapMs` — the point at which "the last
 * reading held" stops being a fair account of the time in between and becomes a guess about it.
 *
 * Every returned run has at least one point. A run of one is a lone reading surrounded by silence and is drawn as a
 * point, never as a line to nowhere.
 */
export function observedRuns(
  observations: readonly TimelineObservation[],
  maxGapMs: number,
): TimelineObservation[][] {
  const points = observations
    .filter((p) => Number.isFinite(p.at) && usable(p.totalUsd))
    .sort((a, b) => a.at - b.at);

  const runs: TimelineObservation[][] = [];
  for (const point of points) {
    const current = runs[runs.length - 1];
    const previous = current?.[current.length - 1];
    if (!current || !previous || point.at - previous.at > maxGapMs) runs.push([point]);
    else current.push(point);
  }
  return runs;
}

/**
 * How far apart two readings may be and still be joined.
 *
 * Taken from the cadence the executor actually snapshots at, with room for a tick that ran late — a snapshot every
 * fifteen minutes that arrives at sixteen has not stopped being continuous. Where the cadence is not known, nothing is
 * assumed to be continuous and every reading stands alone, which is the safe direction to be wrong in.
 */
export function continuityWindowMs(everyMinutes: number | undefined, tolerance = 3): number {
  if (typeof everyMinutes !== 'number' || !Number.isFinite(everyMinutes) || everyMinutes <= 0) return 0;
  return everyMinutes * 60_000 * tolerance;
}

export type TimelineBounds = {
  minAt: number;
  maxAt: number;
  minUsd: number;
  maxUsd: number;
};

/**
 * The extent of everything drawn, or `undefined` when there is nothing to draw.
 *
 * Over both series at once, so the invested line and the observed value share one scale and can be read against each
 * other. Nothing is padded out to a round number: the axis says what the data reached.
 */
export function timelineBounds(
  steps: readonly InvestedStep[],
  runs: readonly (readonly TimelineObservation[])[],
): TimelineBounds | undefined {
  const times: number[] = [];
  const values: number[] = [];
  for (const s of steps) {
    times.push(s.at);
    values.push(s.netInvestedUsd);
  }
  for (const run of runs) {
    for (const p of run) {
      times.push(p.at);
      values.push(p.totalUsd);
    }
  }
  if (times.length === 0) return undefined;
  return {
    minAt: Math.min(...times),
    maxAt: Math.max(...times),
    minUsd: Math.min(...values),
    maxUsd: Math.max(...values),
  };
}

/** How many readings there are in total — what decides between a chart, a single reading, and nothing at all. */
export function recordedCount(
  steps: readonly InvestedStep[],
  runs: readonly (readonly TimelineObservation[])[],
): number {
  return steps.length + runs.reduce((n, run) => n + run.length, 0);
}
