/**
 * The circuit breaker.
 *
 * The retry loop is right for a busy upstream and wrong for a dead one: five attempts with
 * exponential backoff means every request to a host that is down costs about twenty-five seconds
 * before failing. With a scheduler tick and a page of market rows all asking at once, one dead
 * dependency stops looking like degradation and starts looking like a hang.
 */
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { getJson, breakerState, resetBreakers, UpstreamUnavailable } from './get.js';

const DOWN = 'https://breaker-test.invalid/thing';

describe('the circuit breaker', () => {
  beforeEach(() => {
    /*
     * The real spacing and backoff make a failing call take about twenty-five seconds, which is
     * correct in production and useless in a test. The BEHAVIOUR under test — how many failures
     * open the breaker, and that an open breaker skips the network — does not depend on the
     * durations, so they are turned down rather than mocked away.
     */
    vi.stubEnv('HTTP_MIN_SPACING_MS', '0');
    vi.stubEnv('HTTP_MAX_ATTEMPTS', '1');
    vi.stubEnv('HTTP_BACKOFF_BASE_MS', '0');
    resetBreakers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('opens after a run of failures and then refuses immediately', async () => {
    // Four separate calls, each exhausting its own retries. Distinct URLs so the response cache
    // and the in-flight dedup cannot absorb them.
    for (let i = 0; i < 4; i++) {
      await expect(getJson(`${DOWN}?i=${i}`, 0, 5)).rejects.toThrow();
    }

    const state = breakerState().find((s) => s.host === 'breaker-test.invalid');
    expect(state?.failures).toBeGreaterThanOrEqual(4);
    expect(state?.openUntil).toBeGreaterThan(Date.now());

    // The fifth call must not reach fetch at all — that is the entire point.
    const before = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await expect(getJson(`${DOWN}?i=final`, 0, 5)).rejects.toBeInstanceOf(UpstreamUnavailable);
    const after = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(after).toBe(before);
  });

  it('names the host and when it will try again', async () => {
    for (let i = 0; i < 4; i++) await getJson(`${DOWN}?m=${i}`, 0, 5).catch(() => undefined);
    // An error a person can act on: which dependency, and how long. "fetch failed" is neither.
    await expect(getJson(`${DOWN}?m=msg`, 0, 5)).rejects.toThrow(/breaker-test\.invalid.*not retrying/s);
  });
});
