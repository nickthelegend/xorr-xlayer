/**
 * What the app says while something is refusing to be asked again yet.
 */
import { describe, expect, it } from 'vitest';
import { NO_THROTTLE, openBreakers, throttleBanner } from './throttle';

const NOW = Date.parse('2026-09-17T11:00:00.000Z');

describe('nothing is throttled', () => {
  it('says nothing', () => {
    expect(throttleBanner(NO_THROTTLE, NOW)).toBeUndefined();
  });

  it('says nothing once a limit has expired', () => {
    expect(throttleBanner({ limitedUntil: NOW - 1, breakers: [] }, NOW)).toBeUndefined();
  });

  it('says nothing about a breaker that has closed', () => {
    expect(
      throttleBanner({ limitedUntil: 0, breakers: [{ host: 'api.1inch.dev', failures: 4, openUntil: NOW - 1000 }] }, NOW),
    ).toBeUndefined();
  });
});

describe('our own limiter', () => {
  it('says nothing has failed and nothing was sent twice', () => {
    const b = throttleBanner({ limitedUntil: NOW + 42_000, breakers: [] }, NOW);
    expect(b?.scope).toBe('app');
    expect(b?.detail).toContain('about 42s');
    // The two things someone watching a portfolio stop updating actually needs to hear.
    expect(b?.detail).toContain('Nothing has failed');
    expect(b?.detail).toContain('sent twice');
  });

  it('wins over an upstream, because nothing is reaching the upstream either', () => {
    const b = throttleBanner(
      { limitedUntil: NOW + 10_000, breakers: [{ host: 'api.1inch.dev', failures: 5, openUntil: NOW + 60_000 }] },
      NOW,
    );
    expect(b?.scope).toBe('app');
  });
});

describe('the executor’s circuit breakers', () => {
  const open = (host: string) => ({ host, failures: 5, openUntil: NOW + 30_000 });

  it('names the host, because "a dependency" is not something anyone can check', () => {
    const b = throttleBanner({ limitedUntil: 0, breakers: [open('api.1inch.dev')] }, NOW);
    expect(b?.scope).toBe('upstream');
    expect(b?.title).toBe('One price source is not answering');
    expect(b?.detail).toContain('api.1inch.dev');
  });

  it('promises a missing price is shown missing, never filled in from somewhere else', () => {
    const b = throttleBanner({ limitedUntil: 0, breakers: [open('api.1inch.dev')] }, NOW);
    expect(b?.detail).toContain('never filled in from somewhere else');
  });

  it('lists several', () => {
    const b = throttleBanner(
      { limitedUntil: 0, breakers: [open('api.1inch.dev'), open('api.coingecko.com'), open('gateway.thegraph.com')] },
      NOW,
    );
    expect(b?.title).toBe('3 price sources are not answering');
    expect(b?.detail).toContain('api.1inch.dev, api.coingecko.com and gateway.thegraph.com');
  });

  it('takes the executor’s own verdict over the clock where it gave one', () => {
    // `/health` computes `open` against the server's clock, which is the one the breaker runs on.
    expect(openBreakers([{ host: 'h', failures: 1, openUntil: NOW - 1, open: true }], NOW)).toHaveLength(1);
    expect(openBreakers([{ host: 'h', failures: 1, openUntil: NOW + 10_000, open: false }], NOW)).toHaveLength(0);
  });
});

describe('the store, against real answers only', () => {
  it('keeps the longer of two windows, so a second refusal cannot shorten the wait', async () => {
    const { useThrottle } = await import('./throttleStore');
    useThrottle.setState({ limitedUntil: 0, breakers: [] });
    useThrottle.getState().limited(60, NOW);
    useThrottle.getState().limited(5, NOW);
    expect(useThrottle.getState().limitedUntil).toBe(NOW + 60_000);
  });

  it('records nothing when the answer named no retry-after', async () => {
    // Estimating one would be a countdown to a moment nothing happens at.
    const { noteRateLimited, useThrottle } = await import('./throttleStore');
    useThrottle.setState({ limitedUntil: 0, breakers: [] });
    noteRateLimited(undefined);
    expect(useThrottle.getState().limitedUntil).toBe(0);
  });

  it('replaces the breaker list rather than merging it: /health sends a whole picture each time', async () => {
    const { useThrottle } = await import('./throttleStore');
    useThrottle.getState().reportBreakers([{ host: 'a', failures: 5, openUntil: NOW + 1, open: true }]);
    useThrottle.getState().reportBreakers([]);
    expect(useThrottle.getState().breakers).toEqual([]);
  });
});
