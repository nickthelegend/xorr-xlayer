/**
 * LIVE — a strategy moves only for the account that owns it (PLAN.md 1.2).
 *
 * `POST /strategies/:id/{pause,resume,end}` — the routes the Strategy screen calls — updated by id
 * alone, so anyone signed in could pause, resume or end another account's strategy, and nothing was
 * written down. This creates a strategy as one real Privy test account, has a second account try
 * every route that changes a strategy's state, and then walks the owner through the moves — against
 * the real HTTP surface and the real database.
 *
 * Run with the executor up: npm run test:live
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';
const TOKEN_SCRIPT = fileURLToPath(new URL('../e2e-token.ts', import.meta.url));
const OWNER_EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';
const OTHER_EMAIL = process.env.E2E_PRIVY_EMAIL_2 ?? 'test-0356@privy.io';

type Reply = { status: number; body: unknown };
const tokens = { owner: '', other: '' };

function caller(who: keyof typeof tokens) {
  return async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const owner = caller('owner');
const other = caller('other');

/** Unique per run, so this run's rows can be told apart on a trail that holds every earlier one. */
const label = `ownership probe ${randomUUID().slice(0, 8)}`;
let id = '';
/** What the other account is told: `not_found` when it has a wallet, `no_wallet` when it has none. */
let refusedWith = 404;

async function stateOf(): Promise<string | undefined> {
  const { body } = await owner('GET', '/strategies');
  return (body as { id: string; state: string }[]).find((s) => s.id === id)?.state;
}

/** This run's rows on the owner's trail. */
async function trail(): Promise<string[]> {
  const { body } = await owner('GET', '/activity?limit=200');
  const rows = (Array.isArray(body) ? body : ((body as { entries?: unknown[] } | null)?.entries ?? [])) as {
    action?: string;
  }[];
  return rows.map((r) => r.action ?? '').filter((a) => a.includes(label)).sort();
}

beforeAll(async () => {
  tokens.owner = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OWNER_EMAIL], { encoding: 'utf8' }).trim();
  tokens.other = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OTHER_EMAIL], { encoding: 'utf8' }).trim();

  const created = await owner('POST', '/strategies', {
    kind: 'dca',
    state: 'paused',
    label,
    symbol: 'WETH',
    cadence: 'weekly',
    dailyAllocationUsd: 1,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  id = String((created.body as { id: string }).id);

  refusedWith = (await other('GET', '/wallet')).body ? 404 : 409;
}, 120_000);

afterAll(async () => {
  // Retired, not left behind. Ending an ended strategy is a no-op, so this is safe whatever ran.
  if (id) await owner('DELETE', `/strategies/${id}`);
});

describe('only the owner moves a strategy', () => {
  it.each([
    ['POST', 'pause'],
    ['POST', 'resume'],
    ['POST', 'end'],
  ])('refuses %s /strategies/:id/%s from another account', async (method, path) => {
    const res = await other(method, `/strategies/${id}/${path}`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(refusedWith);
  });

  it('refuses PATCH and DELETE from another account', async () => {
    expect((await other('PATCH', `/strategies/${id}`, { state: 'live' })).status).toBe(refusedWith);
    expect((await other('DELETE', `/strategies/${id}`)).status).toBe(refusedWith);
  });

  it("leaves the owner's strategy as it was, with nothing new on the owner's trail", async () => {
    expect(await stateOf()).toBe('paused');
    expect(await trail()).toEqual([`Created ${label}`]);
  });

  it('lets the owner resume and pause it, writing each change once and a repeated tap not at all', async () => {
    const resumed = await owner('POST', `/strategies/${id}/resume`, {});
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(await stateOf()).toBe('live');

    expect((await owner('POST', `/strategies/${id}/pause`, {})).status).toBe(200);
    expect((await owner('POST', `/strategies/${id}/pause`, {})).status).toBe(200);
    expect(await stateOf()).toBe('paused');

    expect(await trail()).toEqual([`Created ${label}`, `Paused ${label}`, `Resumed ${label}`].sort());
  });

  it('keeps an ended strategy ended', async () => {
    expect((await owner('POST', `/strategies/${id}/end`, {})).status).toBe(200);
    const res = await owner('POST', `/strategies/${id}/resume`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(await stateOf()).toBe('ended');
  });
});
