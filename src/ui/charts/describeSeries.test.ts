import { describe, expect, it } from 'vitest';
import { describeSeries } from './describeSeries';

describe('describeSeries', () => {
  it('says only "Chart" when there is no line to describe', () => {
    expect(describeSeries([])).toBe('Chart');
    expect(describeSeries([42])).toBe('Chart');
  });

  it('gives the move over the range, signed as every percentage in the app is', () => {
    expect(describeSeries([100, 90, 110])).toBe('Chart, +10.0% over its range');
    expect(describeSeries([200, 150])).toMatch(/^Chart, −25\.0% over its range$/);
  });

  it('calls a move that rounds to nothing flat', () => {
    expect(describeSeries([1000, 1000.2])).toBe('Chart, flat over its range');
  });

  it('does not divide by a zero start', () => {
    expect(describeSeries([0, 5])).toBe('Chart, rising over its range');
    expect(describeSeries([0, -5])).toBe('Chart, falling over its range');
    expect(describeSeries([0, 0])).toBe('Chart, flat over its range');
  });
});
