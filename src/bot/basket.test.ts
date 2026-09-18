import { describe, expect, it } from 'vitest';
import {
  driftText,
  nextLeg,
  nextRebalanceSentence,
  outOfBand,
  unpricedNote,
  weightText,
  type Sleeve,
} from './basket';
import { MINUS } from '../format';

const sleeve = (symbol: string, targetPct: number, actualPct: number | null): Sleeve => ({
  symbol,
  targetPct,
  units: 1,
  usd: actualPct === null ? null : 100,
  actualPct,
  driftPct: actualPct === null ? null : actualPct - targetPct,
});

describe('driftText', () => {
  it('signs the direction with a real minus', () => {
    expect(driftText(6)).toBe('+6.0');
    expect(driftText(-6)).toBe(`${MINUS}6.0`);
    expect(driftText(-6)).not.toContain('-');
  });

  it('gives a sleeve that is on target no sign at all', () => {
    expect(driftText(0)).toBe('0.0');
    expect(driftText(0.01)).toBe('0.0');
  });
});

describe('outOfBand', () => {
  it('is true at the band, not only past it', () => {
    expect(outOfBand(sleeve('NVDAx', 50, 55), 5)).toBe(true);
    expect(outOfBand(sleeve('NVDAx', 50, 54.9), 5)).toBe(false);
  });

  it('counts a drift in either direction', () => {
    expect(outOfBand(sleeve('NVDAx', 50, 44), 5)).toBe(true);
  });

  /* An unpriced sleeve has no drift to compare, and must not read as in-band. */
  it('is false for a sleeve nothing could price', () => {
    expect(outOfBand(sleeve('NVDAx', 50, null), 5)).toBe(false);
  });
});

describe('nextLeg', () => {
  it('names the largest drift once it is past the band', () => {
    const sleeves = [sleeve('NVDAx', 40, 52), sleeve('TSLAx', 30, 26), sleeve('AAPLx', 30, 22)];
    expect(nextLeg(sleeves, 5)?.symbol).toBe('NVDAx');
  });

  it('is null while everything is inside the band', () => {
    expect(nextLeg([sleeve('NVDAx', 50, 52), sleeve('TSLAx', 50, 48)], 5)).toBeNull();
  });

  /* The largest drift decides, even when a smaller one is also out of band. */
  it('picks the worst rather than the first out of band', () => {
    const sleeves = [sleeve('TSLAx', 30, 24), sleeve('NVDAx', 40, 52)];
    expect(nextLeg(sleeves, 5)?.symbol).toBe('NVDAx');
  });

  it('ignores sleeves with no drift to compare', () => {
    expect(nextLeg([sleeve('NVDAx', 50, null), sleeve('TSLAx', 50, 58)], 5)?.symbol).toBe('TSLAx');
  });

  it('is null for an empty basket', () => {
    expect(nextLeg([], 5)).toBeNull();
  });
});

describe('unpricedNote', () => {
  it('says nothing when everything could be priced', () => {
    expect(unpricedNote([])).toBeNull();
  });

  /*
   * The sentence that keeps the screen honest: an unpriceable sleeve is not worth zero, so none of
   * the percentages mean anything while one is missing — and nothing will be rebalanced either.
   */
  it('explains that the weights cannot be worked out, and that nothing will trade', () => {
    const note = unpricedNote(['TSLAx']);
    expect(note).toContain('TSLAx is unpriced');
    expect(note).toContain('cannot be worked out');
    expect(note).toContain('nothing will be rebalanced');
  });

  it('agrees with itself in the plural', () => {
    const note = unpricedNote(['TSLAx', 'AAPLx']);
    expect(note).toContain('TSLAx, AAPLx are unpriced');
    expect(note).toContain('until they can be');
  });
});

describe('weightText', () => {
  it('shows one decimal, because a basket is set in whole points', () => {
    expect(weightText(52.34)).toBe('52.3%');
    expect(weightText(50)).toBe('50.0%');
  });
});

describe('nextRebalanceSentence', () => {
  /*
   * Three genuinely different answers, not one answer with blanks: the weights are unknowable, it
   * looked and chose not to act, or it will trade.
   */
  it('says nothing will happen while a sleeve is unpriced', () => {
    const s = nextRebalanceSentence([sleeve('NVDAx', 50, null)], 5, ['NVDAx']);
    expect(s).toContain('until every sleeve can be priced');
  });

  it('says it looked and will not trade when everything is in band', () => {
    const s = nextRebalanceSentence([sleeve('NVDAx', 50, 52), sleeve('TSLAx', 50, 48)], 5, []);
    expect(s).toContain('inside the 5-point band');
    expect(s).toContain('will not trade');
  });

  it('names the side, the symbol and the distance when it will trade', () => {
    const s = nextRebalanceSentence([sleeve('NVDAx', 40, 52), sleeve('TSLAx', 60, 48)], 5, []);
    expect(s).toContain('sell NVDAx');
    expect(s).toContain('12.0 points');
    expect(s).toContain('40% target');
  });

  it('says buy for a sleeve that has lagged', () => {
    const s = nextRebalanceSentence([sleeve('NVDAx', 50, 38), sleeve('TSLAx', 50, 62)], 5, []);
    expect(s).toContain('buy NVDAx');
  });
});
