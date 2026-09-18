/**
 * What a line chart says, in words, for a screen reader (FEATURES.md #74, PLAN.md 5.11).
 *
 * A drawn curve is nothing to someone who cannot see it, and "image" is all a bare SVG announces. This says which way
 * the series went over its range and by how much. Unitless on purpose: the chart does not know whether it drew a
 * dollar balance or a price, so a screen that does passes its own label instead.
 *
 * Pure, so it is tested without a renderer.
 */
import { percent } from '../format';

/** Below this, a move rounds to nothing at one decimal and is called flat rather than "+0.0%". */
const FLAT_PCT = 0.05;

export function describeSeries(data: readonly number[]): string {
  if (data.length < 2) return 'Chart';
  const first = data[0]!;
  const last = data[data.length - 1]!;
  if (first === 0) {
    return last === 0 ? 'Chart, flat over its range' : `Chart, ${last > 0 ? 'rising' : 'falling'} over its range`;
  }
  const change = ((last - first) / Math.abs(first)) * 100;
  if (Math.abs(change) < FLAT_PCT) return 'Chart, flat over its range';
  return `Chart, ${percent(change)} over its range`;
}
