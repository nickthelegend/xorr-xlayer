/**
 * LIVE — the business workflow on a fork of Base, end to end (PLAN.md 4.14).
 *
 * As an operator: the treasury (created once, then reused), test funds when it holds too little, Privy refusing to sign a
 * transfer out, a grant the treasury signs through Privy and the executor records from its event, a buy the bot fills
 * inside that grant, the revoke, and a buy after it refused. Each step is read back from the executor's account of Privy
 * and of the chain. Spends $5 of fork USDC per run.
 *
 * Run: EXPO_PUBLIC_API_URL=<fork executor> LIVE=1 npx vitest run business-treasury.live
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';
const TOKEN_SCRIPT = fileURLToPath(new URL('../e2e-token.ts', import.meta.url));
const OWNER_EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';

const health = (await (await fetch(`${BASE}/health`)).json().catch(() => ({}))) as { chain?: string };
const FORK = health.chain === 'xlayer-fork';

let token = '';
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

type View = {
  address: string;
  privy: { walletId: string; ownerId: string | null; policyId: string | null; policyOwnerId: string | null; rules: number };
  balances: { usdc: number; eth: number };
  permission: { state: string; dailyCapUsd?: number; remainingUsd?: number };
  activity: { action: string; tx: string | null }[];
};

describe.skipIf(!FORK)(`a business treasury, end to end (needs a fork of Base; this is ${health.chain})`, () => {
  let view: View;

  beforeAll(() => {
    token = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OWNER_EMAIL], { encoding: 'utf8' }).trim().split('\n').pop()!;
  }, 60_000);

  it("is a Privy wallet under the quorum-owned policy, and is not the operator's own wallet", async () => {
    let read = await call('GET', '/business/treasury');
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    if (!read.body?.treasury) {
      const made = await call('POST', '/business/treasury', { name: 'Acme Treasury' });
      expect(made.status, JSON.stringify(made.body)).toBe(200);
      read = await call('GET', '/business/treasury');
    }
    view = read.body!.treasury as View;
    expect(view.privy.policyId, JSON.stringify(view.privy)).toBeTruthy();
    expect(view.privy.policyOwnerId).toBeTruthy();
    expect(view.privy.ownerId).toBe(view.privy.policyOwnerId);
    expect(view.privy.rules).toBeGreaterThanOrEqual(2);

    const mine = await call('GET', '/wallet');
    expect(String((mine.body as { address?: string } | null)?.address ?? '').toLowerCase()).not.toBe(view.address.toLowerCase());
  }, 60_000);

  it('holds test funds, and gas to sign with', async () => {
    if (view.balances.usdc < 10 || view.balances.eth === 0) {
      const funded = await call('POST', '/business/treasury/fund');
      expect(funded.status, JSON.stringify(funded.body)).toBe(200);
      view = funded.body!.treasury as View;
    }
    expect(view.balances.usdc).toBeGreaterThanOrEqual(10);
    expect(view.balances.eth).toBeGreaterThan(0);
  }, 120_000);

  it('Privy refuses to sign a transfer out, nothing moves, and the refusal is in the trail', async () => {
    const before = view.balances.usdc;
    const proof = await call('POST', '/business/treasury/prove');
    expect(proof.status, JSON.stringify(proof.body)).toBe(200);
    expect(proof.body).toMatchObject({ proven: true });
    expect(String(proof.body!.privy)).toMatch(/policy violation/i);
    view = proof.body!.treasury as View;
    expect(view.balances.usdc).toBe(before);
    expect(view.activity[0]?.action).toBe('Transfer out refused');
  }, 60_000);

  it('the treasury grants the bot through Privy, and the grant is recorded from its own event', async () => {
    if (view.permission.state === 'live') {
      const stopped = await call('POST', '/business/treasury/revoke');
      expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    }
    const granted = await call('POST', '/business/treasury/grant', { dailyCapUsd: 50, days: 1 });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    view = granted.body!.treasury as View;
    expect(view.permission).toMatchObject({ state: 'live', dailyCapUsd: 50 });
    const tx = String(granted.body!.tx);
    expect(tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(view.activity.some((a) => a.action === 'Trading permission granted' && a.tx === tx)).toBe(true);
  }, 240_000);

  it('the bot buys inside the grant', async () => {
    const bought = await call('POST', '/business/treasury/buy', { symbol: 'WETH', usd: 5 });
    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    expect(String(bought.body!.note)).toMatch(/^Bought \d/);
    view = bought.body!.treasury as View;
    expect(view.permission.state).toBe('live');
    expect(view.permission.remainingUsd).toBeLessThanOrEqual(45.01);
  }, 240_000);

  it('revoked, the treasury cannot be traded', async () => {
    const stopped = await call('POST', '/business/treasury/revoke');
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    view = stopped.body!.treasury as View;
    expect(view.permission.state).toBe('stopped');

    const refused = await call('POST', '/business/treasury/buy', { symbol: 'WETH', usd: 5 });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body).toMatchObject({ error: 'no_delegation' });
  }, 240_000);
});
