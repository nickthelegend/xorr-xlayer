/**
 * The funding clock and its words come from the venue's interval, not from an assumed hour.
 */
import { describe, expect, it } from 'vitest';
import { intervalWords, nextPaymentAt, paymentsPerYear } from './funding';

const HOUR = 3_600_000;
const at = Date.UTC(2026, 8, 14, 13);

describe('the next payment', () => {
  it('is the venue’s own time while it is still ahead', () => {
    expect(nextPaymentAt(at, 1, at - 42 * 60_000)).toBe(at);
  });

  it('rolls on by the venue’s interval once that time has passed, never sitting at zero', () => {
    expect(nextPaymentAt(at, 1, at)).toBe(at + HOUR);
    expect(nextPaymentAt(at, 8, at + 3 * HOUR)).toBe(at + 8 * HOUR);
    expect(nextPaymentAt(at, 8, at + 17 * HOUR)).toBe(at + 24 * HOUR);
  });

  it('keeps the venue’s time when there is no interval to roll by', () => {
    expect(nextPaymentAt(at, 0, at + HOUR)).toBe(at);
  });
});

describe('the words for an interval', () => {
  it('reads an hour as an hour, and anything else in hours', () => {
    expect(intervalWords(1)).toEqual({ unit: 'hour', short: 'h', every: 'every hour' });
    expect(intervalWords(8)).toEqual({ unit: '8h', short: '8h', every: 'every 8 hours' });
  });

  it('annualises by the interval actually paid', () => {
    expect(paymentsPerYear(1)).toBe(8760);
    expect(paymentsPerYear(8)).toBe(1095);
  });
});
