/**
 * reservesScale.ts — the vertical scale for a backing-ratio chart.
 *
 * A backing ratio lives in a very narrow band: 1.0011, 1.0014, 1.0009. Auto-scaling a line to its
 * own extent, which is what every other chart in this app correctly does, would stretch four
 * ten-thousandths across the full height of the plot and draw a mountain range. The data would be
 * real and the impression false — a reader would see a token whose backing swings wildly, when in
 * fact it has never left a hair above fully backed.
 *
 * So the scale is anchored to include 1.0, the line that actually means something, and given a
 * floor of a whole percentage point of headroom. A fully backed token then draws as what it is: a
 * flat line sitting just above the mark. A real shortfall still shows, because 1.0 stays in frame
 * and the line visibly crosses under it.
 */

/** Ratio 1.0 — fully backed. The only value on this axis a reader needs to find. */
export const FULLY_BACKED = 1;

/** At least this much of the axis either side of 1.0, so a flat series is not magnified. */
const MIN_HALF_SPAN = 0.01;

export function reservesBounds(ratios: readonly number[]): { min: number; max: number } {
  if (ratios.length === 0) return { min: FULLY_BACKED - MIN_HALF_SPAN, max: FULLY_BACKED + MIN_HALF_SPAN };

  // The extent has to contain 1.0 even when every point sits above it.
  const lo = Math.min(FULLY_BACKED, ...ratios);
  const hi = Math.max(FULLY_BACKED, ...ratios);

  // Grow the smaller side out to the floor, measured from 1.0 rather than from the series.
  const half = Math.max(MIN_HALF_SPAN, FULLY_BACKED - lo, hi - FULLY_BACKED);
  return { min: FULLY_BACKED - half, max: FULLY_BACKED + half };
}

/**
 * What a series of this length can honestly be said to show.
 *
 * One observation is not a trend and must not be drawn as a line; none at all is not an error.
 */
export type SeriesReadiness = 'none' | 'single' | 'drawable';

export function seriesReadiness(observations: number): SeriesReadiness {
  if (observations <= 0) return 'none';
  if (observations === 1) return 'single';
  return 'drawable';
}
