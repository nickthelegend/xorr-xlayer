/**
 * The business routes act for a signed-in person, on that person's own treasury, and say so when they cannot (PLAN.md 4.14).
 *
 * The treasury's decisions are `business/treasury.test.ts`; these are the doors in front of them. An agent key cannot
 * stand in for an operator; every route looks up the caller's treasury by the caller's own id, and answers 404 without
 * one; a grant's cap and length are checked before anything is asked; the refused transfer is addressed to the operator's
 * own wallet; and Privy not answering is a 502 in a sentence.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/privy.js', () => ({
  UnauthorizedError: class extends Error {
    readonly status = 401;
  },
  verifyToken: vi.fn(),
}));
vi.mock('../db/index.js', () => ({ one: vi.fn(), query: vi.fn(), tx: vi.fn(), pool: {} }));
vi.mock('./wallet-context.js', () => ({ currentWallet: vi.fn(), requireWallet: vi.fn(), NoWalletError: class extends Error {} }));
vi.mock('../business/treasury.js', () => ({
  PrivyUnreadable: class PrivyUnreadable extends Error {},
  buyForTreasury: vi.fn(),
  createTreasury: vi.fn(),
  findTreasury: vi.fn(),
  fundTreasury: vi.fn(),
  grantBot: vi.fn(),
  proveRefusal: vi.fn(),
  revokeBot: vi.fn(),
  treasuryView: vi.fn(),
}));

const T = await import('../business/treasury.js');
const { currentWallet } = await import('./wallet-context.js');
const { businessRoutes } = await import('./business.js');
const { errorResponse } = await import('../http/errors.js');

let caller: { user?: { userId: string }; principal?: { name: string; scopes: string[] } } = {};
const app = new Hono();
app.use('*', async (c, next) => {
  if (caller.user) c.set('user', caller.user as never);
  if (caller.principal) c.set('principal', caller.principal as never);
  await next();
});
app.onError(errorResponse);
app.route('/', businessRoutes);

const post = (path: string, body: unknown = {}) =>
  app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

const row = { id: 'treasury-1', operator_user_id: 'did:privy:alice', wallet_id: 'wallet-t', privy_wallet_id: 'privy-w', name: 'Acme', address: '0x5aeda56215b167893e80b4fe645ba6d5bab767de' };
const done = { status: 200 as const, body: { note: 'done' } };

beforeEach(() => {
  vi.clearAllMocks();
  caller = { user: { userId: 'did:privy:alice' } };
  vi.mocked(T.findTreasury).mockResolvedValue(row as never);
  for (const fn of [T.createTreasury, T.fundTreasury, T.grantBot, T.buyForTreasury, T.revokeBot, T.proveRefusal]) {
    vi.mocked(fn).mockResolvedValue(done);
  }
});

describe('who may act', () => {
  it('refuses an agent key, before any treasury is looked up', async () => {
    caller = { principal: { name: 'ops-bot', scopes: ['admin'] } };

    const res = await post('/business/treasury/grant', { dailyCapUsd: 50, days: 7 });

    expect(res.status).toBe(403);
    expect(T.findTreasury).not.toHaveBeenCalled();
    expect(T.grantBot).not.toHaveBeenCalled();
  });

  it("acts on the caller's own treasury, found by the caller's own id", async () => {
    const res = await post('/business/treasury/revoke');

    expect(res.status).toBe(200);
    expect(T.findTreasury).toHaveBeenCalledWith('did:privy:alice');
    expect(T.revokeBot).toHaveBeenCalledWith(row);
  });

  it('answers 404 on every action for a caller with no treasury, and does nothing', async () => {
    vi.mocked(T.findTreasury).mockResolvedValue(undefined);

    for (const path of ['fund', 'grant', 'buy', 'revoke', 'prove']) {
      const res = await post(`/business/treasury/${path}`, { dailyCapUsd: 50, days: 7, symbol: 'WETH', usd: 5 });
      expect(res.status, path).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'no_treasury' });
    }
    for (const fn of [T.fundTreasury, T.grantBot, T.buyForTreasury, T.revokeBot, T.proveRefusal]) {
      expect(fn).not.toHaveBeenCalled();
    }
    const read = await app.request('/business/treasury');
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ treasury: null });
  });
});

describe('what is asked', () => {
  it("holds a grant to a cap and a length before the treasury is asked for anything", async () => {
    for (const body of [{ dailyCapUsd: 0, days: 7 }, { dailyCapUsd: 50, days: 90 }, { dailyCapUsd: 50, days: 1.5 }, {}]) {
      const res = await post('/business/treasury/grant', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(T.grantBot).not.toHaveBeenCalled();

    expect((await post('/business/treasury/grant', { dailyCapUsd: 50, days: 7 })).status).toBe(200);
    expect(T.grantBot).toHaveBeenCalledWith(row, 50, 7);
  });

  it('refuses a nameless treasury', async () => {
    expect((await post('/business/treasury', { name: '   ' })).status).toBe(400);
    expect(T.createTreasury).not.toHaveBeenCalled();
    expect((await post('/business/treasury', { name: ' Acme ' })).status).toBe(200);
    expect(T.createTreasury).toHaveBeenCalledWith('did:privy:alice', 'Acme');
  });

  it("addresses the refused transfer to the operator's own wallet", async () => {
    vi.mocked(currentWallet).mockResolvedValue({ address: '0x95a0b368588713011a15f4b1041423f31b08e615' } as never);

    await post('/business/treasury/prove');

    expect(T.proveRefusal).toHaveBeenCalledWith(row, '0x95A0b368588713011a15f4b1041423f31B08e615');
  });

  it('answers Privy not answering with a 502 that says so', async () => {
    vi.mocked(T.treasuryView).mockRejectedValue(new T.PrivyUnreadable('the treasury’s wallet', new Error('503')));

    const res = await app.request('/business/treasury');

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'privy_unavailable' });
  });
});
