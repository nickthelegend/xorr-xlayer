/**
 * The chart's honesty lives in its scale.
 *
 * Backing ratios sit in a band four ten-thousandths wide. Auto-scaled to their own extent they
 * would draw a mountain range out of a flat line — real numbers, false impression. These pin the
 * two properties that stop that: 1.0 is always in frame, and the axis never gets narrower than a
 * whole percentage point either side of it.
 */
import { describe, expect, it } from 'vitest';
import { reservesBounds, seriesReadiness, FULLY_BACKED } from './reservesScale';

describe('reserves chart scale', () => {
  it('keeps a flat, fully backed series flat instead of magnifying noise', () => {
    // Real NVDAx observations: a band 0.0003 wide.
    const ratios = [1.001099, 1.001101, 1.001367, 1.001432];
    const { min, max } = reservesBounds(ratios);

    // Auto-scaling would give a span of 0.000333; this must be far wider.
    expect(max - min).toBeGreaterThanOrEqual(0.02);
    expect(min).toBeLessThan(FULLY_BACKED);
    expect(max).toBeGreaterThan(Math.max(...ratios));
  });

  it('always keeps the fully-backed line in frame', () => {
    for (const ratios of [[1.5, 1.6], [0.4, 0.5], [1.0001], []]) {
      const { min, max } = reservesBounds(ratios);
      expect(min).toBeLessThanOrEqual(FULLY_BACKED);
      expect(max).toBeGreaterThanOrEqual(FULLY_BACKED);
    }
  });

  it('shows a real shortfall crossing under the line', () => {
    const { min, max } = reservesBounds([1.0011, 0.982]);
    // The dip has to be inside the plot, not clipped off the bottom.
    expect(min).toBeLessThanOrEqual(0.982);
    expect(max).toBeGreaterThanOrEqual(FULLY_BACKED);
  });

  it('stays centred on 1.0 so distance above and below reads the same', () => {
    const { min, max } = reservesBounds([1.03]);
    expect(FULLY_BACKED - min).toBeCloseTo(max - FULLY_BACKED, 12);
  });

  it('survives an empty series without producing NaN', () => {
    const { min, max } = reservesBounds([]);
    expect(Number.isFinite(min)).toBe(true);
    expect(Number.isFinite(max)).toBe(true);
    expect(max).toBeGreaterThan(min);
  });
});

describe('what a series can honestly claim', () => {
  it('refuses to call one observation a trend', () => {
    expect(seriesReadiness(0)).toBe('none');
    expect(seriesReadiness(1)).toBe('single');
    expect(seriesReadiness(2)).toBe('drawable');
    expect(seriesReadiness(180)).toBe('drawable');
  });
});
