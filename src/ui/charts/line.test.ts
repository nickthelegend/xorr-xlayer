/**
 * The line's projection, which the line, the scrub's crosshair and a fill's mark all draw from (FEATURES.md #9, #45).
 * If these three ever used different arithmetic, a mark would float beside the line it belongs on.
 */
import { describe, expect, it } from 'vitest';
import { lineFrame, linePaths, lineX, lineY, nearestIndex, nearestMark } from './line';

/** 100 wide and 50 tall inside a 2pt inset. */
const BOX = { width: 104, height: 54 };

describe('where a value lands', () => {
  const f = lineFrame([10, 20, 30], BOX, 2);

  it('spreads the points evenly inside the inset, the extent touching its edges', () => {
    expect([lineX(f, 0), lineX(f, 1), lineX(f, 2)]).toEqual([2, 52, 102]);
    expect(lineY(f, 30)).toBe(2);
    expect(lineY(f, 10)).toBe(52);
  });

  it('puts a fractional position between its two points', () => {
    expect(lineX(f, 0.5)).toBe(27);
    expect(lineX(f, 1.25)).toBe(64.5);
  });

  it('draws the line and closes the area along the bottom of the box', () => {
    const { line, area } = linePaths(f, [10, 20, 30]);
    expect(line).toBe('M 2,52 L 52,27 L 102,2');
    expect(area).toBe('M 2,52 L 52,27 L 102,2 L 102,54 L 2,54 Z');
  });

  it('makes room for a mark priced beyond every point, on the same scale as the line', () => {
    const marked = lineFrame([10, 20, 30], BOX, 2, undefined, [5]);
    expect(marked.min).toBe(5);
    expect(lineY(marked, 5)).toBe(52);
    expect(lineY(marked, 30)).toBe(2);
  });

  it('keeps bounds a screen fixed, marks or not', () => {
    const fixed = lineFrame([10, 20, 30], BOX, 2, { min: 0, max: 40 }, [5, 50]);
    expect([fixed.min, fixed.max]).toEqual([0, 40]);
  });

  it('centres a single point, and projects an empty or flat series without NaN', () => {
    expect(lineX(lineFrame([7], BOX, 2), 0)).toBe(52);
    const empty = lineFrame([], BOX, 2);
    expect([empty.min, empty.max]).toEqual([0, 1]);
    expect(linePaths(empty, [])).toEqual({ line: '', area: '' });
    expect(Number.isFinite(lineY(lineFrame([4, 4], BOX, 2), 4))).toBe(true);
  });
});

describe('the point under a finger', () => {
  const f = lineFrame([10, 20, 30], BOX, 2);

  it('is the nearest point, halfway breaking toward the later one', () => {
    expect(nearestIndex(f, 26)).toBe(0);
    expect(nearestIndex(f, 27)).toBe(1);
    expect(nearestIndex(f, 60)).toBe(1);
    expect(nearestIndex(f, 90)).toBe(2);
  });

  it('holds the end point when the finger runs off either edge', () => {
    expect(nearestIndex(f, -40)).toBe(0);
    expect(nearestIndex(f, 500)).toBe(2);
  });

  it('is nothing on an empty series, and the one point on a single one', () => {
    expect(nearestIndex(lineFrame([], BOX, 2), 10)).toBeNull();
    expect(nearestIndex(lineFrame([7], BOX, 2), 90)).toBe(0);
    expect(nearestIndex(lineFrame([1, 2], { width: 4, height: 10 }, 2), 3)).toBe(0);
  });
});

describe('a lone reading is a point, not a line', () => {
  const f = lineFrame([42], BOX, 2);

  /*
   * `M x,y` with nothing after it draws nothing in SVG, and an area closed from a single x is a zero-width sliver. Both
   * were emitted before and both were invisible, so a chart handed one reading rendered as an empty box — which is what
   * a chart handed NO readings looks like. Saying there is no path makes the caller draw the reading instead.
   */
  it('has no line and no area for one point', () => {
    expect(linePaths(f, [42])).toEqual({ line: '', area: '' });
  });

  it('still places that point, centred, so it can be drawn', () => {
    expect(lineX(f, 0)).toBe(BOX.width / 2);
    expect(Number.isFinite(lineY(f, 42))).toBe(true);
  });

  it('draws a line again as soon as there are two', () => {
    expect(linePaths(lineFrame([10, 20], BOX, 2), [10, 20]).line).not.toBe('');
  });
});

describe('the mark under a tap (FEATURES.md #77)', () => {
  // Points at x = 2, 52, 102; values 10 → y 52, 30 → y 2.
  const f = lineFrame([10, 20, 30], BOX, 2);
  const marks = [
    { position: 0.5, price: 15 }, // (27, 39.5)
    { position: 1, price: 20 }, // (52, 27)
  ];

  it('is the mark drawn nearest the finger, measured on the line’s own projection', () => {
    expect(nearestMark(f, marks, 27, 39.5, 10)).toBe(0);
    expect(nearestMark(f, marks, 50, 28, 10)).toBe(1);
    // Between the two, the nearer wins.
    expect(nearestMark(f, marks, 42, 31, 30)).toBe(1);
  });

  it('is nothing when no mark is within reach, or there are none', () => {
    expect(nearestMark(f, marks, 90, 5, 10)).toBeNull();
    expect(nearestMark(f, [], 27, 39.5, 100)).toBeNull();
  });
});
