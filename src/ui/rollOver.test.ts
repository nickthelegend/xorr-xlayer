import { describe, expect, it } from 'vitest';
import { figureValue, rollDirection } from './rollOver';
import { money, percent, quantity } from './format';

describe('figureValue — reading a formatted figure back, only to pick a direction', () => {
  it('reads the money format this app prints, separators and all', () => {
    expect(figureValue(money(4862.18))).toBe(4862.18);
    expect(figureValue(money(1_234_567.89))).toBe(1234567.89);
    expect(figureValue(money(0))).toBe(0);
  });

  it('reads U+2212 as the minus it is, not as punctuation to be dropped', () => {
    // A hyphen here would have made every debit read as a credit of the same size.
    expect(money(-12.5)).toContain('−');
    expect(figureValue(money(-12.5))).toBe(-12.5);
    expect(figureValue(percent(-1.4))).toBe(-1.4);
  });

  it('reads a signed percentage and a bare quantity', () => {
    expect(figureValue(percent(1.4))).toBe(1.4);
    expect(figureValue(quantity(0.489))).toBe(0.489);
  });

  it('a dash states no figure — it is the app’s "no value", not a zero', () => {
    expect(figureValue('—')).toBeUndefined();
    expect(figureValue('')).toBeUndefined();
    expect(figureValue('No live SOL price')).toBeUndefined();
  });

  it('the hidden-balance mask states no figure either', () => {
    expect(figureValue('••••')).toBeUndefined();
  });
});

describe('rollDirection — up when it rose, down when it fell', () => {
  it('turns up on a rise and down on a fall', () => {
    expect(rollDirection(money(4862.18), money(4901.02), 1)).toBe(1);
    expect(rollDirection(money(4901.02), money(4862.18), 1)).toBe(-1);
  });

  it('a loss deepening turns down, and a loss shrinking turns up', () => {
    expect(rollDirection(money(-12.5), money(-31.4), 1)).toBe(-1);
    expect(rollDirection(money(-31.4), money(-12.5), -1)).toBe(1);
  });

  it('keeps the last direction when the figure did not move', () => {
    expect(rollDirection(money(10), money(10), -1)).toBe(-1);
    expect(rollDirection(money(10), money(10), 1)).toBe(1);
  });

  /*
   * A balance appearing where a dash was has not risen from nothing — it has become known. Rolling
   * every character of a figure that replaced no figure is motion with no event behind it.
   */
  it('keeps the last direction when either side states no figure', () => {
    expect(rollDirection('—', money(4862.18), -1)).toBe(-1);
    expect(rollDirection(money(4862.18), '—', 1)).toBe(1);
  });
});
