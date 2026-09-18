/**
 * Reading another network's executor: a health report is the answer even at 503, a refusal keeps its status, and a read
 * that runs out of time says so. Each read settles on its own, so one failure never hides the others.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TimedOut } from './apiError';
import { readNetwork } from './networks';

const report = {
  ok: false,
  status: 'down',
  chain: 'base-sepolia',
  delegation: '0x6c5528Fd8E74a047A85bAb413856A9239E73540e',
  uptimeSec: 5,
  dependencies: [{ name: 'postgres', status: 'down', critical: true, detail: 'no answer in 5000ms' }],
};

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readNetwork', () => {
  it('takes a 503 health report as the report, and keeps the other reads apart from it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/health')) return answer(503, report);
        if (url.endsWith('/market/tradable')) return answer(200, []);
        return answer(502, { error: 'price_unavailable', detail: 'The rate could not be read just now.' });
      }),
    );

    const read = await readNetwork('https://api.xorr.finance/');
    expect(read.health).toMatchObject({ status: 'down', chain: 'base-sepolia' });
    expect(read.tradable).toEqual([]);
    expect(read.yieldSupply).toBeInstanceOf(ApiError);
    expect((read.yieldSupply as ApiError).status).toBe(502);
  });

  it('asks each path at the executor it is given, once', async () => {
    const fetchMock = vi.fn(async (_url: string) => answer(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await readNetwork('https://executor-fork-production.up.railway.app/');
    expect(fetchMock.mock.calls.map((c) => String(c[0])).sort()).toEqual([
      'https://executor-fork-production.up.railway.app/health',
      'https://executor-fork-production.up.railway.app/market/tradable',
      'https://executor-fork-production.up.railway.app/yield/supply',
    ]);
  });

  it('turns a read that outruns its bound into TimedOut, not a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          }),
      ),
    );
    const read = await readNetwork('https://api.xorr.finance', 20);
    expect(read.health).toBeInstanceOf(TimedOut);
    expect(read.tradable).toBeInstanceOf(TimedOut);
  });
});
