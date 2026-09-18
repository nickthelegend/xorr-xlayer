/**
 * The executor holds one 1inch key, one CoinGecko tier and one delegate key, and nothing bounded
 * how fast a single caller could spend them. The scheduler competes for the same quota, so the
 * first thing an unbounded loop would break is the trading — silently, while the app looked fine.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';

process.env.RATE_LIMIT_GENERAL = '5';
process.env.RATE_LIMIT_UPSTREAM = '2';
process.env.RATE_LIMIT_WINDOW_MS = '60000';

const { rateLimit, resetRateLimits } = await import('./rate-limit.js');

/** An app that fakes the identity the auth middleware would have set. */
function appFor(principal?: { kind: string; id: string }, userId?: string) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    // Hono types `c.set` against a declared Variables map; this test stands in for the auth
    // middleware, which is where those keys are really declared.
    const ctx = c as unknown as { set: (k: string, v: unknown) => void };
    if (principal) ctx.set('principal', principal);
    if (userId) ctx.set('user', { userId });
    await next();
  });
  app.use('*', rateLimit);
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

const hit = (app: Hono, path: string) => app.request(path);

beforeEach(() => resetRateLimits());

describe('the expensive routes have their own, tighter budget', () => {
  it('lets a quote through twice and refuses the third', async () => {
    const app = appFor({ kind: 'agent', id: 'a1' });
    expect((await hit(app, '/swap/quote?in=USDC&out=WETH')).status).toBe(200);
    expect((await hit(app, '/swap/quote?in=USDC&out=WETH')).status).toBe(200);
    const third = await hit(app, '/swap/quote?in=USDC&out=WETH');
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();
    expect(((await third.json()) as { error: string }).error).toBe('rate_limited');
  });

  it('a cheap route keeps its own, larger budget', async () => {
    const app = appFor({ kind: 'agent', id: 'a2' });
    // Exhaust the upstream bucket first — it must not touch the general one.
    await hit(app, '/swap/quote');
    await hit(app, '/swap/quote');
    expect((await hit(app, '/swap/quote')).status).toBe(429);
    expect((await hit(app, '/wallet')).status).toBe(200);
  });

  it('market reads get the GENERAL budget, not the tight upstream one', async () => {
    /*
     * They are served from the shared cache and the single-flight fetcher, so a hundred readers
     * cost one upstream call. They are still bounded — an unbounded public route is its own problem
     * — just not by the budget that exists to protect a metered key.
     */
    const app = appFor({ kind: 'agent', id: 'a3' });
    for (let i = 0; i < 5; i += 1) {
      expect((await hit(app, '/market/quotes?symbols=BTC')).status).toBe(200);
    }
    // The 6th exceeds GENERAL (5 in this test), proving it was never on the upstream budget of 2.
    expect((await hit(app, '/market/quotes?symbols=BTC')).status).toBe(429);
  });
});

describe('the bucket is per caller', () => {
  it('one agent exhausting its budget does not affect another', async () => {
    const a = appFor({ kind: 'agent', id: 'first' });
    const b = appFor({ kind: 'agent', id: 'second' });
    await hit(a, '/swap/quote');
    await hit(a, '/swap/quote');
    expect((await hit(a, '/swap/quote')).status).toBe(429);
    expect((await hit(b, '/swap/quote')).status).toBe(200);
  });

  it('a person and a worker are counted separately', async () => {
    const worker = appFor({ kind: 'agent', id: 'w' });
    const person = appFor(undefined, 'did:privy:abc');
    await hit(worker, '/swap/quote');
    await hit(worker, '/swap/quote');
    expect((await hit(worker, '/swap/quote')).status).toBe(429);
    expect((await hit(person, '/swap/quote')).status).toBe(200);
  });
});

describe('health is never limited', () => {
  it('stays open when everything else is exhausted', async () => {
    /*
     * Railway polls `/health` to decide whether the container is alive. Limiting it means that
     * under load — exactly when the limiter is working — the platform concludes the service is down
     * and restarts it, turning a busy minute into an outage that kills in-flight runs.
     */
    const app = appFor({ kind: 'agent', id: 'busy' });
    for (let i = 0; i < 10; i += 1) await hit(app, '/wallet');
    expect((await hit(app, '/wallet')).status).toBe(429);
    expect((await hit(app, '/health')).status).toBe(200);
    expect((await hit(app, '/metrics')).status).toBe(200);
  });
});
