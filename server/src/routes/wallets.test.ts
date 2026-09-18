/**
 * GET /wallets — every address on an account, and which one is actually in use.
 *
 * A user having more than one is not hypothetical: web Privy lists any injected browser extension
 * alongside the embedded wallet, so an account that once connected through an extension has both on
 * file. Everything here is scoped by wallet — the policy, the balance, the strategies, the trail —
 * so the other address had a whole second set of all of it that nothing in the app could reach.
 *
 * The property that matters is the last one in this file: the list's idea of the current wallet is
 * the SAME ordering `currentWallet` picks with. If those two could disagree, the switcher would show
 * a ticked row while the money moved on a different address, which is worse than having no switcher.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({ query: vi.fn(), one: vi.fn(), requireUser: vi.fn() }));

vi.mock('../db/index.js', () => ({ query: h.query, one: h.one, tx: vi.fn() }));
vi.mock('../auth/middleware.js', () => ({
  requireUser: h.requireUser,
  WrongPrincipalError: class extends Error {},
}));

const { walletsFor, currentWallet, WALLET_ORDER } = await import('./wallet-context.js');

const USER = { userId: 'did:privy:abc' };

/** Two rows on one account, as Postgres would return them in `WALLET_ORDER`. */
const EMBEDDED = {
  id: 'w-embedded',
  user_id: USER.userId,
  address: '0x95A0b368588713011a15f4b1041423f31B08e615',
  kind: 'embedded',
  cluster: 'xlayer-testnet',
  active_at: new Date('2026-09-17T09:00:00Z'),
  created_at: new Date('2026-09-05T10:00:00Z'),
  last_seen_at: null,
};
const CONNECTED = {
  id: 'w-connected',
  user_id: USER.userId,
  address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5',
  kind: 'connected',
  cluster: 'xlayer-testnet',
  active_at: null,
  created_at: new Date('2026-09-08T10:00:00Z'),
  last_seen_at: null,
};

/** The route, with `walletsFor` answering from the rows given. */
async function listWith(rows: unknown[]): Promise<{ status: number; body: any }> {
  h.query.mockResolvedValue(rows);
  const app = new Hono();
  app.get('/wallets', async (c) => {
    const found = await walletsFor(c as never);
    return c.json(
      found.map((w, i) => ({
        id: w.id,
        address: w.address,
        kind: w.kind,
        cluster: w.cluster,
        active: i === 0,
        lastActiveAt: w.active_at ? new Date(w.active_at).getTime() : undefined,
        createdAt: new Date(w.created_at).getTime(),
      })),
    );
  });
  const res = await app.request('/wallets');
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  h.query.mockReset();
  h.one.mockReset();
  h.requireUser.mockReset().mockReturnValue(USER);
});

describe('the list', () => {
  it('returns every address on the account', async () => {
    const { status, body } = await listWith([EMBEDDED, CONNECTED]);

    expect(status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body.map((w: any) => w.address)).toEqual([EMBEDDED.address, CONNECTED.address]);
  });

  it('marks exactly one as the one in use', async () => {
    const { body } = await listWith([EMBEDDED, CONNECTED]);
    expect(body.filter((w: any) => w.active)).toHaveLength(1);
    expect(body[0].active).toBe(true);
  });

  it('says which kind each is, since they are not interchangeable', async () => {
    // `embedded` was made by Privy for this account; `connected` is a wallet the user brought.
    const { body } = await listWith([EMBEDDED, CONNECTED]);
    expect(body.map((w: any) => w.kind)).toEqual(['embedded', 'connected']);
  });

  it('leaves the last-active time absent rather than inventing one', async () => {
    // A row written before migration 011 has none. A `createdAt` standing in for it would read as
    // "you were on this address in September", which nobody recorded.
    const { body } = await listWith([EMBEDDED, CONNECTED]);
    expect(body[0].lastActiveAt).toBe(EMBEDDED.active_at.getTime());
    expect(body[1].lastActiveAt).toBeUndefined();
  });

  it('is scoped to the caller’s own account', async () => {
    await listWith([EMBEDDED]);
    expect(h.query.mock.calls[0]![1]).toEqual([USER.userId]);
    expect(String(h.query.mock.calls[0]![0])).toContain('user_id = $1');
  });

  it('answers an account with one wallet with one row, still marked active', async () => {
    const { body } = await listWith([EMBEDDED]);
    expect(body).toEqual([expect.objectContaining({ active: true })]);
  });

  it('answers an account with none with an empty list, not an error', async () => {
    // Signed in and not yet onboarded is a state, not a fault.
    expect((await listWith([])).body).toEqual([]);
  });
});

describe('the list and the executor cannot disagree', () => {
  it('orders by the same rule currentWallet picks with', async () => {
    h.query.mockResolvedValue([EMBEDDED, CONNECTED]);
    h.one.mockResolvedValue(EMBEDDED);
    const c = {} as never;

    await walletsFor(c);
    await currentWallet(c);

    const listSql = String(h.query.mock.calls[0]![0]);
    const pickSql = String(h.one.mock.calls[0]![0]);
    /*
     * Both built from `WALLET_ORDER`, not from two copies of the same clause. Two copies is how the
     * switcher ends up ticking one address while the trail is written against another.
     */
    expect(listSql).toContain(WALLET_ORDER);
    expect(pickSql).toContain(WALLET_ORDER);
  });

  it('puts the wallet currentWallet would pick first in the list', async () => {
    h.query.mockResolvedValue([EMBEDDED, CONNECTED]);
    h.one.mockResolvedValue(EMBEDDED);
    const c = {} as never;

    const [first] = await walletsFor(c);
    const picked = await currentWallet(c);

    expect(first!.id).toBe(picked!.id);
  });

  it('orders by the app’s own assertion before row age', async () => {
    /*
     * "Newest row wins" was the previous rule and it guessed wrong on the E2E account: the app
     * signs in as an embedded wallet created on the 5th while the newest row is a connected one
     * from the 8th, so /limits reported a $0 cap for an account holding a live on-chain grant.
     */
    expect(WALLET_ORDER.indexOf('active_at')).toBeLessThan(WALLET_ORDER.indexOf('created_at'));
    expect(WALLET_ORDER).toContain('NULLS LAST');
  });

  it('breaks a tie on the primary key, so the ordering is total', async () => {
    // Two rows with the same timestamps must still come back in one fixed order, or "first" is
    // whatever Postgres felt like this time.
    expect(WALLET_ORDER).toMatch(/id DESC$/);
  });
});
