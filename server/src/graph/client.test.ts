/**
 * A subgraph that never answers (PLAN.md 2.13).
 *
 * The query had no deadline, so a gateway that accepted the connection and then went quiet held the run
 * that asked open indefinitely. These drive the real client with `fetch` replaced.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { health, resetSubgraphForTests, setSubgraphTimeoutForTests, SubgraphUnavailable } = await import('./client.js');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setSubgraphTimeoutForTests(5_000);
  resetSubgraphForTests();
});

const META = { data: { _meta: { block: { number: 46829712 }, hasIndexingErrors: false } } };

/** A `fetch` answering each call with the next status in `statuses` (the last one repeats), counting the calls. */
function answering(statuses: { status: number; retryAfter?: string }[]) {
  const calls = { n: 0 };
  vi.stubGlobal('fetch', async () => {
    const next = statuses[Math.min(calls.n, statuses.length - 1)]!;
    calls.n += 1;
    return next.status === 200
      ? new Response(JSON.stringify(META))
      : new Response('Too Many Requests', {
          status: next.status,
          headers: next.retryAfter ? { 'retry-after': next.retryAfter } : {},
        });
  });
  return calls;
}

describe('a 429 from The Graph', () => {
  it('holds every query until its retry-after, asking nothing in the meantime', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    const calls = answering([{ status: 429, retryAfter: '60' }, { status: 200 }]);

    await expect(health()).rejects.toThrow('The Graph is unreachable: 429');
    await expect(health()).rejects.toThrow('The Graph is unreachable: 429, not asked again for another 60s');
    vi.setSystemTime(new Date('2026-09-15T00:00:45Z'));
    await expect(health()).rejects.toThrow('not asked again for another 15s');
    expect(calls.n).toBe(1);

    vi.setSystemTime(new Date('2026-09-15T00:01:01Z'));
    expect(await health()).toEqual({ block: 46829712, healthy: true });
    expect(calls.n).toBe(2);
  });

  it('holds for a minute when it names no retry-after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    const calls = answering([{ status: 429 }, { status: 200 }]);
    await expect(health()).rejects.toThrow('429');
    vi.setSystemTime(new Date('2026-09-15T00:00:59Z'));
    await expect(health()).rejects.toThrow('not asked again for another 1s');
    vi.setSystemTime(new Date('2026-09-15T00:01:00Z'));
    expect(await health()).toEqual({ block: 46829712, healthy: true });
    expect(calls.n).toBe(2);
  });
});

describe("the index's health", () => {
  it('is read once per 30 seconds however often it is asked, and once for callers asking together', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    const calls = answering([{ status: 200 }]);

    await Promise.all([health(), health(), health()]);
    expect(calls.n).toBe(1);
    vi.setSystemTime(new Date('2026-09-15T00:00:29Z'));
    await health();
    expect(calls.n).toBe(1);
    vi.setSystemTime(new Date('2026-09-15T00:00:31Z'));
    await health();
    expect(calls.n).toBe(2);
  });

  it('is asked again after a read that failed', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(META));
    });
    await expect(health()).rejects.toThrow(SubgraphUnavailable);
    expect(await health()).toEqual({ block: 46829712, healthy: true });
    expect(n).toBe(2);
  });
});

describe('a subgraph query', () => {
  it('gives up at its deadline with the same error as any unreachable index', async () => {
    setSubgraphTimeoutForTests(50);
    // Accepts the request and never answers — except to the abort signal, as a real fetch does.
    vi.stubGlobal('fetch', (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
    );
    const started = Date.now();
    const err = await health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubgraphUnavailable);
    expect(String((err as Error).message)).toContain('no answer in 50ms');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('is deadlined at 5 seconds unless told otherwise', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: { signal: AbortSignal }) => {
      signal = init.signal;
      return new Response(JSON.stringify({ data: { _meta: { block: { number: 46748446 }, hasIndexingErrors: false } } }));
    });
    expect(await health()).toEqual({ block: 46748446, healthy: true });
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
  });

  it('a network failure is still an unreachable index, not a crash', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(health()).rejects.toThrow(SubgraphUnavailable);
  });
});

describe('which contract the index is about', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is unknown — not a stale default — when the deployment does not say', async () => {
    vi.resetModules();
    vi.stubEnv('SUBGRAPH_DELEGATION_ADDRESS', '');
    vi.stubEnv('DELEGATION_ADDRESS', '0x6c5528Fd8E74a047A85bAb413856A9239E73540e');
    const fresh = await import('./client.js');
    expect(fresh.indexesThisDeployment()).toBe(false);
    expect(fresh.indexDescription().indexedDelegation).toBe('');
  });

  it('matches this deployment when it names the same contract, in any case', async () => {
    vi.resetModules();
    vi.stubEnv('SUBGRAPH_DELEGATION_ADDRESS', '0x6c5528fd8e74a047a85bab413856a9239e73540e');
    vi.stubEnv('DELEGATION_ADDRESS', '0x6c5528Fd8E74a047A85bAb413856A9239E73540e');
    expect((await import('./client.js')).indexesThisDeployment()).toBe(true);
  });
});

