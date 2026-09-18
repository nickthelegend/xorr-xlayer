/**
 * A screen come back to reads again, at a pace the executor can take, and never trades the numbers it showed for a
 * failure (FEATURES.md #27).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REREAD_AFTER_MS, settleReread, shouldReread, type Settled } from './reread';

const ROOT = path.resolve(import.meta.dirname, '../..');
const AT = 1_757_800_000_000;

describe('shouldReread', () => {
  it('reads again once the last answer is fifteen seconds old', () => {
    expect(REREAD_AFTER_MS).toBe(15_000);
    expect(shouldReread({ now: AT + 15_000, lastSettledAt: AT, inFlight: false })).toBe(true);
    expect(shouldReread({ now: AT + 60 * 60_000, lastSettledAt: AT, inFlight: false })).toBe(true);
  });

  it('does not read again sooner, so switching between two tabs is not a stream of requests', () => {
    expect(shouldReread({ now: AT + 14_999, lastSettledAt: AT, inFlight: false })).toBe(false);
    expect(shouldReread({ now: AT, lastSettledAt: AT, inFlight: false })).toBe(false);
  });

  it('never stacks a read on one already on its way', () => {
    expect(shouldReread({ now: AT + 60_000, lastSettledAt: AT, inFlight: true })).toBe(false);
  });

  it('waits for the first answer rather than asking for it twice', () => {
    expect(shouldReread({ now: AT, lastSettledAt: undefined, inFlight: false })).toBe(false);
    expect(shouldReread({ now: AT + 60_000, lastSettledAt: undefined, inFlight: true })).toBe(false);
  });

  it('reads when a clock set back makes the age unknowable', () => {
    expect(shouldReread({ now: AT - 1, lastSettledAt: AT, inFlight: false })).toBe(true);
  });

  it('takes another threshold when a caller has one', () => {
    expect(shouldReread({ now: AT + 5_000, lastSettledAt: AT, inFlight: false }, 5_000)).toBe(true);
    expect(shouldReread({ now: AT + 4_999, lastSettledAt: AT, inFlight: false }, 5_000)).toBe(false);
  });
});

describe('settleReread', () => {
  const shown: Settled<{ total: number }> = { key: '[[],0]', data: { total: 24_207.43 }, at: AT };

  it('replaces the answer, and clears the failure before it', () => {
    const failed = { ...shown, error: new Error('The executor answered 502.') };
    expect(settleReread(failed, '[[],0]', { ok: true, data: { total: 24_950.1 }, at: AT + 20_000 })).toEqual({
      key: '[[],0]',
      data: { total: 24_950.1 },
      at: AT + 20_000,
    });
  });

  it('keeps the numbers on screen through a failed re-read, beside the failure', () => {
    const error = new Error('The executor did not answer within 45s.');
    expect(settleReread(shown, '[[],0]', { ok: false, error })).toEqual({
      key: '[[],0]',
      data: { total: 24_207.43 },
      at: AT,
      error,
    });
  });

  it('before any answer, a failed re-read is only a failure: there is no number to keep', () => {
    const before: Settled<number> = { key: '[[],0]', at: AT, error: new Error('down') };
    const next = settleReread(before, '[[],0]', { ok: false, error: new Error('still down') });
    expect(next.data).toBeUndefined();
    expect(next.error?.message).toBe('still down');
  });

  it('drops an answer to a question the screen stopped asking while it was out', () => {
    expect(settleReread(shown, '[[],1]', { ok: true, data: { total: 1 }, at: AT + 1 })).toBe(shown);
    expect(settleReread(shown, '[[],1]', { ok: false, error: new Error('late') })).toBe(shown);
  });
});

describe('the screens that read again on return', () => {
  it('Portfolio, Assets, Balance and Activity opt in', () => {
    for (const f of ['app/portfolio.tsx', 'app/(tabs)/holdings.tsx', 'app/balance.tsx', 'app/activity.tsx']) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).toMatch(/useFreshOnReturn\(/);
    }
  });
});
