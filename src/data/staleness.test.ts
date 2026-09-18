/**
 * Saying that a number on screen is from before the outage.
 *
 * Keeping the last good read rather than emptying the screen avoids one lie — an account that
 * looks empty because the connection dropped — and introduces the opposite one: a balance from
 * twenty minutes ago drawn exactly like a live one, on a screen someone is reading to decide
 * whether to intervene.
 *
 * The rule under test is that there is no third option. A figure is live, or it says when it was
 * read.
 */
import { describe, expect, it } from 'vitest';
import { ageLabel, freshness, isLive } from './staleness';

const NOW = new Date('2026-09-17T12:00:00Z').getTime();
const MIN = 60_000;

describe('while the executor is answering', () => {
  it('is live, with nothing to label', () => {
    const f = freshness({ hasData: true, settledAt: NOW - MIN, reachable: true, now: NOW });
    expect(f).toEqual({ state: 'live' });
    expect(isLive(f)).toBe(true);
  });
});

describe('while it is not', () => {
  it('reports the last read and how old it is', () => {
    const f = freshness({ hasData: true, settledAt: NOW - 20 * MIN, reachable: false, now: NOW });
    expect(f).toMatchObject({ state: 'last-known', at: NOW - 20 * MIN });
    expect(f.state === 'last-known' && f.label).toBe('Last read 20 minutes ago');
  });

  it('is never live, however recent the read was', () => {
    // A read that succeeded a second before the connection dropped has no idea it is now stale.
    // Only the heartbeat knows, which is why `reachable` and not the read decides this.
    const f = freshness({ hasData: true, settledAt: NOW - 1_000, reachable: false, now: NOW });
    expect(isLive(f)).toBe(false);
    expect(f.state).toBe('last-known');
  });
});

describe('when nothing has ever been read', () => {
  it('says so rather than dressing up an absence', () => {
    // There is no figure to label. The screen shows its empty state, which is honest.
    expect(freshness({ hasData: false, settledAt: undefined, reachable: false, now: NOW })).toEqual({
      state: 'never',
    });
  });

  it('says so even with a settle time but no data', () => {
    expect(freshness({ hasData: false, settledAt: NOW, reachable: true, now: NOW }).state).toBe('never');
  });

  it('says so with data but no settle time, rather than guessing one', () => {
    // An undated figure cannot be labelled, and drawing it plainly is the thing being prevented.
    expect(freshness({ hasData: true, settledAt: undefined, reachable: false, now: NOW }).state).toBe(
      'never',
    );
  });
});

describe('how old, in words', () => {
  it('is pessimistic under a minute', () => {
    // "Less than a minute" is a smaller claim than "just now", and on a screen about money the
    // smaller claim is the safer one.
    expect(ageLabel(NOW - 5_000, NOW)).toBe('less than a minute ago');
    expect(ageLabel(NOW - 59_000, NOW)).toBe('less than a minute ago');
  });

  it('counts minutes, hours and days', () => {
    expect(ageLabel(NOW - MIN, NOW)).toBe('1 minute ago');
    expect(ageLabel(NOW - 45 * MIN, NOW)).toBe('45 minutes ago');
    expect(ageLabel(NOW - 60 * MIN, NOW)).toBe('1 hour ago');
    expect(ageLabel(NOW - 5 * 60 * MIN, NOW)).toBe('5 hours ago');
    expect(ageLabel(NOW - 48 * 60 * MIN, NOW)).toBe('2 days ago');
  });

  it('rounds down, so a reading never claims to be older than it is', () => {
    // Overstating the age would have someone dismiss a figure that is still good.
    expect(ageLabel(NOW - 119_000, NOW)).toBe('1 minute ago');
  });

  it('does not report a negative age from a skewed clock', () => {
    expect(ageLabel(NOW + 10_000, NOW)).toBe('less than a minute ago');
  });
});
