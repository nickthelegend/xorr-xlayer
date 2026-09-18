import { describe, expect, it } from 'vitest';
import { advance, isDue, nextRuns, periodKey } from './schedule';

describe('9.3 schedule arithmetic', () => {
  it('advances each cadence', () => {
    const base = new Date('2026-09-07T09:00:00Z'); // a Monday
    expect(advance(base, 'daily').toISOString().slice(0, 10)).toBe('2026-09-08');
    expect(advance(base, 'weekly').toISOString().slice(0, 10)).toBe('2026-09-14');
    expect(advance(base, 'biweekly').toISOString().slice(0, 10)).toBe('2026-09-21');
    expect(advance(base, 'monthly').toISOString().slice(0, 10)).toBe('2026-10-07');
  });

  it('a weekly schedule keeps the same weekday — "every Monday" stays Monday', () => {
    const base = new Date('2026-09-07T09:00:00Z');
    for (const d of nextRuns('weekly', 6, base)) {
      expect(d.getUTCDay()).toBe(base.getUTCDay());
    }
  });

  it('gives the next N runs in order', () => {
    const runs = nextRuns('weekly', 3, new Date('2026-09-07T09:00:00Z'));
    expect(runs).toHaveLength(3);
    expect(runs[0]!.getTime()).toBeLessThan(runs[1]!.getTime());
    expect(runs[1]!.getTime()).toBeLessThan(runs[2]!.getTime());
  });
});

describe('9.3 / 12.8 idempotency keys — the thing that stops a double-buy', () => {
  it('two attempts in the same day share a key', () => {
    const a = periodKey('s1', 'daily', new Date('2026-09-07T09:00:00Z'));
    const b = periodKey('s1', 'daily', new Date('2026-09-07T23:59:00Z'));
    expect(a).toBe(b);
  });

  it('different days do not', () => {
    expect(periodKey('s1', 'daily', new Date('2026-09-07T09:00:00Z'))).not.toBe(
      periodKey('s1', 'daily', new Date('2026-09-08T09:00:00Z')),
    );
  });

  it('a whole week collapses to one weekly key', () => {
    const keys = new Set(
      ['07', '08', '09', '10', '11', '12', '13'].map((d) =>
        periodKey('s1', 'weekly', new Date(`2026-09-${d}T09:00:00Z`)),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it('different strategies never collide', () => {
    const at = new Date('2026-09-07T09:00:00Z');
    expect(periodKey('s1', 'daily', at)).not.toBe(periodKey('s2', 'daily', at));
  });

  it('monthly collapses a month', () => {
    expect(periodKey('s1', 'monthly', new Date('2026-09-01T00:00:00Z'))).toBe(
      periodKey('s1', 'monthly', new Date('2026-09-30T23:00:00Z')),
    );
  });
});

describe('due checks', () => {
  it('is due at or after the scheduled time', () => {
    expect(isDue(1000, 1000)).toBe(true);
    expect(isDue(1000, 1001)).toBe(true);
    expect(isDue(1000, 999)).toBe(false);
  });
});
