/**
 * The banner that says the app is still trying.
 *
 * The offline banner was true and inert — "Can't reach xorr" with nothing moving, while a health
 * check was in fact going out every few seconds. Someone on a train had no way to tell a dropped
 * connection from a broken app, and the difference decides whether they wait or start pulling their
 * money out by hand.
 */
import { describe, expect, it } from 'vitest';
import {
  RECOVERED_NOTICE_MS,
  outageLabel,
  reconnectBanner,
  retryDelayMs,
  type ReconnectState,
} from './reconnect';

const NOW = new Date('2026-09-17T12:00:00Z').getTime();

const state = (over: Partial<ReconnectState> = {}): ReconnectState => ({
  reachable: true,
  downSince: null,
  attempts: 0,
  nextAttemptAt: null,
  recoveredAt: null,
  ...over,
});

describe('while everything is fine', () => {
  it('says nothing at all', () => {
    expect(reconnectBanner(state(), NOW)).toBeNull();
  });
});

describe('while down', () => {
  const down = (over: Partial<ReconnectState> = {}) =>
    reconnectBanner(
      state({ reachable: false, downSince: NOW - 5_000, attempts: 1, nextAttemptAt: NOW + 3_000, ...over }),
      NOW,
    )!;

  it('names the countdown to the next attempt', () => {
    // The whole point: something is visibly happening.
    expect(down().detail).toContain('Trying again in 3s');
  });

  it('says it is trying right now while a check is in flight', () => {
    expect(down({ nextAttemptAt: null }).detail).toContain('Trying now…');
  });

  it('never counts down to zero or below', () => {
    // A banner reading "in 0s" or "in -2s" is a clock nobody is winding.
    expect(down({ nextAttemptAt: NOW }).detail).toContain('in 1s');
    expect(down({ nextAttemptAt: NOW - 9_000 }).detail).toContain('in 1s');
  });

  it('keeps saying what is still true about the money', () => {
    /*
     * Not reassurance — a property of the design. The permission lives on chain and the kill switch
     * is signed by the user, so a dead executor cannot touch either.
     */
    const detail = down().detail;
    expect(detail).toMatch(/funds and your permission are on chain/i);
    expect(detail).toMatch(/stopping your agents still works/i);
    expect(detail).toMatch(/signed by you, not by us/i);
  });

  it('says screens may be stale and that new actions will not go through', () => {
    expect(down().detail).toMatch(/out of date/i);
    expect(down().detail).toMatch(/will not go through/i);
  });

  it('offers a retry only between attempts', () => {
    // Tapping "Try now" while a check is already in flight would do nothing visible, which is the
    // exact impression this file exists to remove.
    expect(down().retryable).toBe(true);
    expect(down({ nextAttemptAt: null }).retryable).toBe(false);
  });

  it('is toned as a failure', () => {
    expect(down().tone).toBe('down');
  });
});

describe('how long it has been down', () => {
  it('says nothing about duration on the first failed check', () => {
    // A single missed check is a blip; stamping a duration on it makes a hiccup look like an incident.
    const first = reconnectBanner(
      state({ reachable: false, downSince: NOW - 2_000, attempts: 1, nextAttemptAt: NOW + 2_000 }),
      NOW,
    )!;
    expect(first.detail).not.toMatch(/offline/);
  });

  it('says it from the second, when it starts to mean something', () => {
    const later = reconnectBanner(
      state({ reachable: false, downSince: NOW - 300_000, attempts: 4, nextAttemptAt: NOW + 5_000 }),
      NOW,
    )!;
    expect(later.detail).toContain('offline 5 minutes');
  });

  it('is coarse, because the useful distinction is a blip against an incident', () => {
    expect(outageLabel(NOW - 10_000, NOW)).toBe('just now');
    expect(outageLabel(NOW - 60_000, NOW)).toBe('1 minute');
    expect(outageLabel(NOW - 600_000, NOW)).toBe('10 minutes');
    expect(outageLabel(NOW - 7_200_000, NOW)).toBe('2 hours');
  });

  it('does not report a negative duration from a skewed clock', () => {
    expect(outageLabel(NOW + 5_000, NOW)).toBe('just now');
  });
});

describe('when it comes back', () => {
  it('says so, and says why that matters', () => {
    /*
     * Every screen behind the banner was rendered against a failed read, so the app is connected
     * and still showing the outage's emptiness. Leaving that silently is how someone walks away
     * believing their positions are gone.
     */
    const back = reconnectBanner(state({ recoveredAt: NOW - 1_000 }), NOW)!;
    expect(back.title).toBe('Back online');
    expect(back.detail).toMatch(/out of date/i);
    expect(back.detail).toMatch(/reload/i);
    expect(back.tone).toBe('back');
  });

  it('stops saying it once the notice has had its time', () => {
    expect(reconnectBanner(state({ recoveredAt: NOW - RECOVERED_NOTICE_MS - 1 }), NOW)).toBeNull();
  });

  it('stays up long enough to reach the control on it', () => {
    // It carries an action; it must not vanish while a thumb is on the way.
    expect(RECOVERED_NOTICE_MS).toBeGreaterThanOrEqual(5_000);
  });

  it('gives way to a fresh outage', () => {
    // Dropping again during the recovery notice is the more important fact.
    const dropped = reconnectBanner(
      state({ reachable: false, downSince: NOW, attempts: 1, nextAttemptAt: NOW + 2_000, recoveredAt: NOW - 500 }),
      NOW,
    )!;
    expect(dropped.title).toBe('Can’t reach xorr');
  });
});

describe('how often it retries', () => {
  it('tries again quickly the first time', () => {
    // Most outages are a moment of bad signal.
    expect(retryDelayMs(1)).toBe(2_000);
  });

  it('backs off, so a struggling executor is not hammered by every open app', () => {
    const delays = [1, 2, 3, 4, 5].map(retryDelayMs);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(new Set(delays).size).toBe(delays.length);
  });

  it('caps quickly, because the person is waiting', () => {
    // A minute is already long enough to feel abandoned, and a health check is cheap.
    expect(retryDelayMs(50)).toBe(30_000);
    expect(retryDelayMs(500)).toBeLessThanOrEqual(30_000);
  });

  it('never returns nothing for a nonsense attempt count', () => {
    expect(retryDelayMs(0)).toBe(2_000);
    expect(retryDelayMs(-3)).toBe(2_000);
  });
});
