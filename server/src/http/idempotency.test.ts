/**
 * An Idempotency-Key that cannot act twice (migration 025), driven over HTTP through `guardRequests` — the order
 * `index.ts` installs — with the database stood in for.
 *
 * What is pinned here is what the statements say and what the middleware does with their answers: a claim is an INSERT
 * a second request loses, a takeover is an UPDATE that re-reads every condition the SELECT answered, and every write an
 * attempt makes afterwards names its own claim. The table below answers each statement the way its WHERE clause reads;
 * whether Postgres does the same is for a test against a real one (PLAN.md 6.1).
 */
import { createHash } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Read by the limiter at import: five metered requests a minute per caller, so one test can reach the limit on purpose.
process.env.RATE_LIMIT_UPSTREAM = '5';
process.env.RATE_LIMIT_GENERAL = '100';
process.env.RATE_LIMIT_WINDOW_MS = '60000';

type Row = {
  method: string;
  path: string;
  requestHash: string | null;
  claimId: string | null;
  status: number | null;
  body: string | null;
  broadcastAt: number | null;
  createdAt: number;
};

const h = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  statements: [] as { text: string; params: unknown[] }[],
  /** How far the database's clock runs ahead of this one: moved forward to make a claim old. */
  aheadMs: 0,
  /** A statement the database refuses, once. */
  refuse: undefined as RegExp | undefined,
}));

vi.mock('../db/index.js', () => {
  const now = () => Date.now() + h.aheadMs;
  const run = async (text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    h.statements.push({ text, params });
    if (h.refuse?.test(text)) {
      h.refuse = undefined;
      throw new Error('Connection terminated unexpectedly');
    }
    const [userId, key] = params as [string, string];
    const id = `${userId}|${key}`;
    const row = h.rows.get(id);
    const olderThan = (seconds: unknown) => row !== undefined && row.createdAt < now() - Number(seconds) * 1000;

    if (/^\s*SELECT/.test(text)) {
      if (!row) return [];
      return [
        {
          method: row.method,
          path: row.path,
          status: row.status,
          body: row.body,
          request_hash: row.requestHash,
          broadcast: row.broadcastAt !== null,
          abandoned: olderThan(params[2]),
        },
      ];
    }
    if (/^\s*INSERT INTO idempotency/.test(text)) {
      if (row) return [];
      const [, , method, path, requestHash, claimId] = params as [string, string, string, string, string, string];
      h.rows.set(id, { method, path, requestHash, claimId, status: null, body: null, broadcastAt: null, createdAt: now() });
      return [{ key }];
    }
    if (/SET claim_id/.test(text)) {
      const [, , claimId, requestHash, method, path, seconds] = params as [string, string, string, string, string, string, number];
      if (!row || row.method !== method || row.path !== path || row.status !== null || row.broadcastAt !== null) return [];
      if ((row.requestHash !== null && row.requestHash !== requestHash) || !olderThan(seconds)) return [];
      Object.assign(row, { claimId, requestHash, createdAt: now() });
      return [{ key }];
    }
    if (/SET broadcast_at/.test(text)) {
      if (!row || row.claimId !== params[2]) return [];
      row.broadcastAt = now();
      return [{ key }];
    }
    if (/SET status/.test(text)) {
      if (row && row.claimId === params[2]) Object.assign(row, { status: params[3], body: params[4] });
      return [];
    }
    if (/^\s*DELETE FROM idempotency/.test(text)) {
      if (row && row.claimId === params[2] && row.broadcastAt === null) h.rows.delete(id);
      return [];
    }
    throw new Error(`unexpected statement: ${text}`);
  };
  return { one: async (text: string, params?: unknown[]) => (await run(text, params))[0], query: run };
});

const { guardRequests } = await import('./guards.js');
const { resetRateLimits } = await import('./rate-limit.js');
const { markBroadcast } = await import('./request-id.js');
const { ABANDONED_AFTER_SECONDS } = await import('./idempotency.js');

const BODY = { symbol: 'WETH', fraction: 1 };
const hashOf = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');
const LONG_AGO = () => Date.now() - (ABANDONED_AFTER_SECONDS + 60) * 1000;

/** An app behind the guards `index.ts` installs, with a person already signed in and `route` on two money paths. */
function serve(userId: string, route: (c: Context) => Promise<Response>) {
  const app = new Hono();
  // Stands in for the auth middleware, which is where `user` is really set.
  const signedIn: MiddlewareHandler = async (c, next) => {
    (c as unknown as { set: (k: string, v: unknown) => void }).set('user', { userId });
    await next();
  };
  guardRequests(app, signedIn);
  app.post('/positions/close', route);
  app.post('/orders', route);
  return app;
}

function send(app: Hono, key: string | undefined, body: unknown = BODY, path = '/positions/close') {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key === undefined ? {} : { 'idempotency-key': key }) },
    body: JSON.stringify(body),
  });
}

/** A row as an earlier attempt left it. */
function seed(userId: string, key: string, over: Partial<Row>) {
  h.rows.set(`${userId}|${key}`, {
    method: 'POST',
    path: '/positions/close',
    requestHash: hashOf(BODY),
    claimId: 'an-earlier-attempt',
    status: null,
    body: null,
    broadcastAt: null,
    createdAt: Date.now(),
    ...over,
  });
}

function gate() {
  let open!: () => void;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open };
}

const ran = (pattern: RegExp) => h.statements.filter((s) => pattern.test(s.text));

beforeEach(() => {
  h.rows.clear();
  h.statements.length = 0;
  h.aheadMs = 0;
  h.refuse = undefined;
  resetRateLimits();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a request the rate limiter refuses', () => {
  it('claims no key and stores nothing, so the same key runs once the limit has passed', async () => {
    const asked: unknown[] = [];
    const app = serve('did:privy:limited', async (c) => {
      asked.push(await c.req.json());
      return c.json({ status: 'filled' });
    });
    // `/orders` spends the metered budget — five a minute in this file — and these use all of it.
    for (let usd = 1; usd <= 5; usd += 1) expect((await send(app, undefined, { usd }, '/orders')).status).toBe(200);

    const refused = await send(app, 'order-key', { usd: 6 }, '/orders');
    expect(refused.status).toBe(429);
    // Nothing was read, claimed or stored under the key: the limiter answered before the key was looked at.
    expect(h.statements.filter((s) => s.params.includes('order-key'))).toEqual([]);
    expect(h.rows.size).toBe(0);

    resetRateLimits(); // the minute passes
    const retried = await send(app, 'order-key', { usd: 6 }, '/orders');
    expect(retried.status).toBe(200);
    expect(retried.headers.get('idempotent-replay')).toBeNull();
    expect(asked).toEqual([{ usd: 1 }, { usd: 2 }, { usd: 3 }, { usd: 4 }, { usd: 5 }, { usd: 6 }]);
  });
});

describe('the same key again', () => {
  it('with the same body replays the stored answer and runs nothing', async () => {
    let runs = 0;
    const app = serve('did:privy:replay', async (c) => {
      runs += 1;
      // The route still reads the body the key was hashed from.
      const { symbol } = (await c.req.json()) as { symbol: string };
      return c.json({ status: 'closed', symbol, run: runs });
    });
    const first = await send(app, 'close-key');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: 'closed', symbol: 'WETH', run: 1 });

    const again = await send(app, 'close-key');
    expect(again.status).toBe(200);
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect(await again.json()).toEqual({ status: 'closed', symbol: 'WETH', run: 1 });
    expect(runs).toBe(1);
    expect(ran(/^\s*INSERT INTO idempotency/)[0]!.params).toContain(hashOf(BODY));
  });

  it('with a different body is refused with 422, and runs nothing', async () => {
    let runs = 0;
    const app = serve('did:privy:reused', async (c) => {
      runs += 1;
      return c.json({ status: 'closed' });
    });
    expect((await send(app, 'close-key', { symbol: 'WETH', fraction: 1 })).status).toBe(200);

    const other = await send(app, 'close-key', { symbol: 'WETH', fraction: 0.5 });
    expect(other.status).toBe(422);
    expect(await other.json()).toEqual({
      error: 'idempotency_key_reused',
      message: 'That key was already used for POST /positions/close with a different body. A different request needs a new key.',
    });
    expect(runs).toBe(1);
  });

  it('on a row from before the body was kept is matched on method and path, as every row was', async () => {
    seed('did:privy:legacy', 'old-key', { requestHash: null, claimId: null, status: 200, body: '{"status":"closed"}' });
    const app = serve('did:privy:legacy', async (c) => c.json({ status: 'ran again' }));

    const res = await send(app, 'old-key', { symbol: 'CBBTC', fraction: 0.25 });
    expect(res.status).toBe(200);
    expect(res.headers.get('idempotent-replay')).toBe('true');
    expect(await res.json()).toEqual({ status: 'closed' });
  });
});

describe('a server error', () => {
  it('that sent nothing gives the key back, so a retry genuinely retries', async () => {
    let runs = 0;
    const app = serve('did:privy:transient', async (c) => {
      runs += 1;
      return runs === 1
        ? c.json({ status: 'failed', error: 'The network did not answer.' }, 502)
        : c.json({ status: 'closed' });
    });
    expect((await send(app, 'close-key')).status).toBe(502);
    expect(h.rows.size).toBe(0);

    const retried = await send(app, 'close-key');
    expect(retried.status).toBe(200);
    expect(retried.headers.get('idempotent-replay')).toBeNull();
    expect(runs).toBe(2);
  });

  it('after a broadcast is kept, and a retry replays it instead of sending again', async () => {
    const sends: string[] = [];
    const app = serve('did:privy:late-receipt', async (c) => {
      await markBroadcast();
      // What the chain would have been sent — and whether the key's row already said so when it was.
      sends.push(h.rows.get('did:privy:late-receipt|close-key')?.broadcastAt ? 'sent, recorded first' : 'sent unrecorded');
      return c.json({ status: 'failed', symbol: 'WETH', error: 'close 0xabc did not confirm' }, 502);
    });
    expect((await send(app, 'close-key')).status).toBe(502);

    const retried = await send(app, 'close-key');
    expect(retried.status).toBe(502);
    expect(retried.headers.get('idempotent-replay')).toBe('true');
    expect(await retried.json()).toEqual({ status: 'failed', symbol: 'WETH', error: 'close 0xabc did not confirm' });
    expect(sends).toEqual(['sent, recorded first']);
    // Recorded by the attempt that holds the claim, and nothing gave the key back.
    expect(ran(/SET broadcast_at/)[0]!.text).toMatch(/claim_id = \$3/);
    expect(ran(/^\s*DELETE/)).toEqual([]);
  });

  it('a broadcast that cannot be recorded is not sent, and the key is given back', async () => {
    const sends: string[] = [];
    let runs = 0;
    const app = serve('did:privy:unrecorded', async (c) => {
      runs += 1;
      try {
        await markBroadcast();
      } catch (e) {
        return c.json({ status: 'failed', error: (e as Error).message }, 502);
      }
      sends.push('sent');
      return c.json({ status: 'closed' });
    });
    h.refuse = /SET broadcast_at/;
    expect((await send(app, 'close-key')).status).toBe(502);
    expect(sends).toEqual([]);
    expect(h.rows.size).toBe(0);

    // Nothing went out, so the retry runs — and this time the record lands before the send.
    expect((await send(app, 'close-key')).status).toBe(200);
    expect(sends).toEqual(['sent']);
    expect(runs).toBe(2);
  });
});

describe('a claim nobody has answered', () => {
  it('is in flight while it is fresh: a concurrent duplicate is refused with 409, and runs nothing', async () => {
    const { closed, open } = gate();
    let runs = 0;
    const app = serve('did:privy:double-tap', async (c) => {
      runs += 1;
      await closed;
      return c.json({ status: 'closed' });
    });
    const first = send(app, 'close-key');
    await vi.waitFor(() => expect(runs).toBe(1));

    const duplicate = await send(app, 'close-key');
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: 'request_in_flight' });

    open();
    expect((await first).status).toBe(200);
    expect(runs).toBe(1);
  });

  it('abandoned before it sent anything is taken over, and run', async () => {
    seed('did:privy:crashed', 'close-key', { createdAt: LONG_AGO() });
    let runs = 0;
    const app = serve('did:privy:crashed', async (c) => {
      runs += 1;
      return c.json({ status: 'closed' });
    });

    const res = await send(app, 'close-key');
    expect(res.status).toBe(200);
    expect(runs).toBe(1);
    const row = h.rows.get('did:privy:crashed|close-key')!;
    expect(row.claimId).not.toBe('an-earlier-attempt');
    expect(row.status).toBe(200);
    // The takeover re-reads what the SELECT answered, so it cannot take a claim that has since sent or answered.
    const [takeover] = ran(/SET claim_id/);
    expect(takeover!.text).toMatch(/status IS NULL AND broadcast_at IS NULL/);
    expect(takeover!.text).toMatch(/created_at < now\(\) - make_interval/);
  });

  it('abandoned after it sent a transaction is answered 409, as possibly done, and never run again', async () => {
    seed('did:privy:died-after-send', 'close-key', { createdAt: LONG_AGO(), broadcastAt: LONG_AGO() + 30_000 });
    let runs = 0;
    const app = serve('did:privy:died-after-send', async (c) => {
      runs += 1;
      return c.json({ status: 'closed' });
    });

    for (let tap = 0; tap < 2; tap += 1) {
      const res = await send(app, 'close-key');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: 'request_outcome_unknown',
        message: expect.stringMatching(/may have gone through\. Check Activity/),
      });
    }
    expect(runs).toBe(0);
    expect(ran(/SET claim_id/)).toEqual([]);
  });

  it('a slow attempt whose claim was taken over sends nothing, and cannot undo the attempt that took it', async () => {
    const { closed, open } = gate();
    const sends: number[] = [];
    let attempts = 0;
    const app = serve('did:privy:slow', async (c) => {
      const attempt = (attempts += 1);
      if (attempt === 1) await closed;
      try {
        await markBroadcast();
      } catch (e) {
        return c.json({ status: 'failed', error: (e as Error).message }, 502);
      }
      sends.push(attempt);
      return c.json({ status: 'closed', attempt });
    });

    const slow = send(app, 'close-key');
    await vi.waitFor(() => expect(attempts).toBe(1));
    h.aheadMs = (ABANDONED_AFTER_SECONDS + 1) * 1000; // five minutes go by, and it has sent nothing

    const retry = await send(app, 'close-key');
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: 'closed', attempt: 2 });

    open();
    const late = await slow;
    expect(late.status).toBe(502);
    expect(await late.json()).toMatchObject({ error: expect.stringContaining('has taken its place') });
    expect(sends).toEqual([2]);

    // The slow attempt's give-back named its own claim and found nothing: the retry's answer stands.
    const replayed = await send(app, 'close-key');
    expect(replayed.headers.get('idempotent-replay')).toBe('true');
    expect(await replayed.json()).toEqual({ status: 'closed', attempt: 2 });
  });
});

describe('a broadcast outside any request', () => {
  it('records nothing, so a scheduled run sends as it always did', async () => {
    await expect(markBroadcast()).resolves.toBeUndefined();
    expect(h.statements).toEqual([]);
  });
});
