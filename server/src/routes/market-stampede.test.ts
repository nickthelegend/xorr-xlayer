/**
 * One upstream fetch per cold URL, however many clients ask at once.
 *
 * `getWithStale` deduped its BACKGROUND refreshes and not its cold fetches, so every request for a
 * URL nobody had cached started another `getJson` — each with its own retry ladder, all against an
 * upstream that rate-limits by IP. The app polls, so a cold symbol produced a standing herd of
 * concurrent fetches that kept the rate limit tripped and never populated the cache.
 *
 * That is a permanently broken chart, not a slow one. The deployed logs showed
 * `GET /market/ohlc 503 8002ms` repeating for ETH and BTC — the two symbols the market list and
 * the default chart both request — while CoinGecko answered the same URLs in 200 from anywhere
 * else, and one request took 31.5 seconds.
 *
 * So the property under test is a count, not a latency: N simultaneous cold readers must produce
 * exactly ONE upstream call.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// The module graph reaches the venue and chain modules, which refuse to load unconfigured. This
// test is about a cache, so give them the shape they check for and nothing more.
process.env.ONEINCH_API_KEY ??= 'test-key';
process.env.XORR_CHAIN ??= 'base-sepolia';
process.env.DELEGATE_PRIVATE_KEY ??=
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const calls: string[] = [];
let resolveUpstream: ((v: unknown) => void) | undefined;

vi.mock('../http/get.js', () => ({
  getJson: vi.fn((url: string) => {
    calls.push(url);
    return new Promise((res) => {
      resolveUpstream = res;
    });
  }),
  // Always cold: this is the path that stampeded.
  staleValue: () => undefined,
  UpstreamUnavailable: class extends Error {},
}));

// Nothing here touches the database, but the module graph pulls it in.
vi.mock('../db/index.js', () => ({ one: async () => undefined, query: async () => [] }));
vi.mock('../auth/privy.js', () => ({ requireUser: () => ({ userId: 'test' }) }));

const { market } = await import('./market.js');

beforeEach(() => {
  calls.length = 0;
  resolveUpstream = undefined;
});

describe('a cold symbol does not stampede the upstream', () => {
  it('twelve simultaneous readers produce one fetch', async () => {
    const reqs = Array.from({ length: 12 }, () =>
      market.request('/market/ohlc?symbol=ETH&days=1'),
    );
    // Let every handler reach the fetch before anything resolves.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length, `made ${calls.length} upstream calls for one cold URL`).toBe(1);

    resolveUpstream?.([[1, 2, 3, 4, 5]]);
    const res = await Promise.all(reqs);
    // And all twelve get the answer, rather than eleven of them timing out.
    expect(res.every((r) => r.status === 200)).toBe(true);
  }, 20_000);

  it('different symbols still fetch separately', async () => {
    void market.request('/market/ohlc?symbol=ETH&days=1');
    void market.request('/market/ohlc?symbol=BTC&days=1');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(2);
    resolveUpstream?.([[1, 2, 3, 4, 5]]);
  }, 20_000);
});
