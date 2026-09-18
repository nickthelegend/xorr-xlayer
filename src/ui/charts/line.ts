/**
 * line.ts — where a line chart puts a value, and which point sits under a finger.
 *
 * `AreaChart` projected its line with two closures inside the component. That was enough while the line was the
 * only thing drawn on it; a fill's mark and the scrub's crosshair have to land on that same line to the pixel, so the
 * projection lives here once, pure, and all three ask it. Values run down the height; points are spread evenly across
 * the width, by index rather than by time, exactly as the line has always been drawn.
 */

/** Everything a point needs to become a coordinate: the series' extent and the box it is drawn in. */
export interface LineFrame {
  /** How many points the line has. */
  count: number;
  /** The inset on every side, so a stroke, a dot or a mark at the very edge is not cut in half. */
  pad: number;
  width: number;
  height: number;
  min: number;
  max: number;
}

/**
 * The frame for a series in a box.
 *
 * `bounds` fixes the vertical scale. Otherwise it is the extent of the series and of `alsoValues` — the prices of the
 * fills marked on it, which a line of closes does not always reach: a sale measured after fees, or a fill on a fork
 * whose pools lag the feed, can sit below every close. The line makes room, rather than drawing the mark off the chart.
 * With nothing at all the scale is the old 0 to 1, so an empty chart projects without NaN.
 */
export function lineFrame(
  data: readonly number[],
  box: { width: number; height: number },
  pad: number,
  bounds?: { min: number; max: number },
  alsoValues: readonly number[] = [],
): LineFrame {
  const values = [...data, ...alsoValues];
  return {
    count: data.length,
    pad,
    width: box.width,
    height: box.height,
    min: bounds?.min ?? (values.length > 0 ? Math.min(...values) : 0),
    max: bounds?.max ?? (values.length > 0 ? Math.max(...values) : 1),
  };
}

/** A point index → x. Fractional is fine: 2.5 is halfway between the third and fourth points. One point sits centred. */
export function lineX(f: LineFrame, position: number): number {
  if (f.count < 2) return f.width / 2;
  const plot = Math.max(0, f.width - f.pad * 2);
  return f.pad + (position / (f.count - 1)) * plot;
}

/** A value → y, from the top. A flat series spans 1, so it draws along the top inset instead of dividing by zero. */
export function lineY(f: LineFrame, value: number): number {
  const span = f.max - f.min || 1;
  const plot = Math.max(0, f.height - f.pad * 2);
  return f.pad + ((f.max - value) / span) * plot;
}

/**
 * The point nearest an x, for the scrub — or null when there is no point to be near.
 *
 * Past either end the nearest point is that end, so a finger that runs off the edge of the chart holds the first or
 * the last point instead of dropping the crosshair.
 */
export function nearestIndex(f: LineFrame, x: number): number | null {
  if (f.count === 0) return null;
  if (f.count === 1) return 0;
  const plot = Math.max(0, f.width - f.pad * 2);
  if (plot === 0) return 0;
  const at = Math.round(((x - f.pad) / plot) * (f.count - 1));
  return Math.min(f.count - 1, Math.max(0, at));
}

/**
 * The line's path, and the area under it closed along the bottom of the box.
 *
 * Empty for an empty series, and **empty for a series of one**. A lone reading has no line: `M x,y` with nothing after
 * it draws nothing at all in SVG, and the area closed from a single x is a zero-width sliver. Rather than emit two
 * shapes that happen to be invisible, this says there is no path, and the caller draws the reading as the point it is.
 * A line needs two observations; one is a fact without a direction.
 */
export function linePaths(f: LineFrame, data: readonly number[]): { line: string; area: string } {
  if (data.length < 2) return { line: '', area: '' };
  const points = data.map((v, i) => `${lineX(f, i)},${lineY(f, v)}`);
  const line = `M ${points.join(' L ')}`;
  return {
    line,
    area: `${line} L ${lineX(f, data.length - 1)},${f.height} L ${lineX(f, 0)},${f.height} Z`,
  };
}

/**
 * The mark a tap at (x, y) lands on, or null — the nearest one whose drawn point is within `reach`.
 *
 * Measured against the same projection the mark is drawn with, so what a finger picks is what it is on. Nothing is
 * chosen from further away than `reach`: a tap on bare line beside a mark is not a question about that mark.
 */
export function nearestMark(
  f: LineFrame,
  marks: readonly { position: number; price: number }[],
  x: number,
  y: number,
  reach: number,
): number | null {
  let best: number | null = null;
  let bestDistance = reach;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    const d = Math.hypot(lineX(f, m.position) - x, lineY(f, m.price) - y);
    if (d <= bestDistance) {
      best = i;
      bestDistance = d;
    }
  }
  return best;
}
