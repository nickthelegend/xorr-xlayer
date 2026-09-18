/**
 * LIVE — one account cannot take another account's wallet (PLAN.md 1.1).
 *
 * `/wallet/connect` took any address from the request body and moved its row to the caller, and
 * `/wallet/create` fell back to the body when Privy had no embedded wallet to offer. That row is the
 * only link between a person and the wallet the bot trades, so the takeover reached orders, closes and
 * the panic flatten on someone else's permission.
 *
 * This signs in as two real Privy test accounts and has the second ask for the first one's wallet —
 * through the real HTTP surface, Privy's real verification and the real database.
 *
 * Run with the executor up: npm run test:live
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';
const TOKEN_SCRIPT = fileURLToPath(new URL('../e2e-token.ts', import.meta.url));
const OWNER_EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';
const OTHER_EMAIL = process.env.E2E_PRIVY_EMAIL_2 ?? 'test-0356@privy.io';

type Reply = { status: number; body: unknown };
type Caller = (path: string, body?: unknown) => Promise<Reply>;

const tokens = { owner: '', other: '' };

function caller(who: keyof typeof tokens): Caller {
  return async (path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const owner = caller('owner');
const other = caller('other');

const field = (body: unknown, key: string): string =>
  String((body as Record<string, unknown> | null)?.[key] ?? '').toLowerCase();

/** "Wallet connected" and gas-drip rows on the caller's trail — what a first registration writes. */
async function registrationRows(ask: Caller): Promise<number> {
  const { body } = await ask('/activity?limit=200');
  const rows = (Array.isArray(body) ? body : ((body as { entries?: unknown[] } | null)?.entries ?? [])) as {
    action?: string;
  }[];
  return rows.filter((r) => r.action === 'Wallet connected' || /test ETH for gas|^No gas sent$/.test(r.action ?? ''))
    .length;
}

let ownerAddress = '';

beforeAll(async () => {
  tokens.owner = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OWNER_EMAIL], { encoding: 'utf8' }).trim();
  tokens.other = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OTHER_EMAIL], { encoding: 'utf8' }).trim();
  expect(tokens.owner.length).toBeGreaterThan(100);
  expect(tokens.other.length).toBeGreaterThan(100);

  // The owner's own wallet, registered if it is not already — the thing the other account will ask for.
  const created = await owner('/wallet/create', {});
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  ownerAddress = field(created.body, 'address');
  expect(ownerAddress).toMatch(/^0x[0-9a-f]{40}$/);
}, 120_000);

describe("a wallet belongs to the account Privy says it belongs to", () => {
  it("refuses to connect another account's wallet", async () => {
    const res = await other('/wallet/connect', { address: ownerAddress });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(field(res.body, 'error')).toBe('wallet_not_linked');
  });

  it('refuses it whatever case the address is spelled in', async () => {
    const res = await other('/wallet/connect', { address: `0x${ownerAddress.slice(2).toUpperCase()}` });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it("ignores an address in /wallet/create's body — the other account never receives the owner's wallet", async () => {
    const res = await other('/wallet/create', { address: ownerAddress });
    // Its own embedded wallet (200), or `no_wallet` (400) when Privy has not made one — never the owner's.
    expect([200, 400], JSON.stringify(res.body)).toContain(res.status);
    expect(field(res.body, 'address')).not.toBe(ownerAddress);
  });

  it("leaves the owner's wallet with the owner", async () => {
    expect(field((await owner('/wallet')).body, 'address')).toBe(ownerAddress);
    expect(field((await other('/wallet')).body, 'address')).not.toBe(ownerAddress);
  });

  it('lets the owner reconnect their own wallet without a second registration or a second drip', async () => {
    const before = await registrationRows(owner);
    const res = await owner('/wallet/connect', { address: ownerAddress });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(field(res.body, 'address')).toBe(ownerAddress);
    expect(await registrationRows(owner)).toBe(before);
  });
});
