/**
 * LIVE — the stop-all the executor enforces (PLAN.md 2.14).
 *
 * Stops the test account's agents through the API, shows the rules refusing a limit check and a run while
 * the stop holds, resumes, and shows the refusal gone. Nothing is spent: a stopped run is refused before it
 * is planned. Safe on any chain.
 *
 * Run: EXPO_PUBLIC_API_URL=<executor> LIVE=1 npx vitest run stop-all.live
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';
const TOKEN_SCRIPT = fileURLToPath(new URL('../e2e-token.ts', import.meta.url));
const OWNER_EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';

let token = '';
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

let strategyId = '';

describe('stopping every agent from the executor', () => {
  beforeAll(async () => {
    token = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OWNER_EMAIL], { encoding: 'utf8' }).trim();
    await call('POST', '/agents/resume');
    const created = await call('POST', '/strategies', {
      kind: 'dca',
      state: 'paused',
      label: `stop-all probe ${randomUUID().slice(0, 8)}`,
      symbol: 'WETH',
      cadence: 'weekly',
      dailyAllocationUsd: 5,
      params: { usd: 5 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    strategyId = String(created.body?.id);
  }, 120_000);

  afterAll(async () => {
    if (!token) return;
    await call('POST', '/agents/resume');
    if (strategyId) await call('DELETE', `/strategies/${strategyId}`);
  }, 60_000);

  it('is read by the rules at once, and a resume lifts it', async () => {
    const stopped = await call('POST', '/agents/stop');
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ stopped: true });
    expect(Number(stopped.body?.since)).toBeGreaterThan(Date.now() - 60_000);
    expect((await call('GET', '/agents/stopped')).body).toMatchObject({ stopped: true });

    const check = await call('POST', '/limits/check', { usd: 5 });
    expect(check.body).toMatchObject({ allowed: false, reason: 'agents_stopped' });

    const run = await call('POST', `/strategies/${strategyId}/run`);
    expect(run.body, JSON.stringify(run.body)).toMatchObject({ status: 'blocked', reason: 'agents_stopped' });

    // A second stop is not a second event.
    expect((await call('POST', '/agents/stop')).body).toMatchObject({ stopped: true, since: stopped.body?.since });

    const resumed = await call('POST', '/agents/resume');
    expect(resumed.body).toEqual({ stopped: false, since: null });
    const after = await call('POST', '/limits/check', { usd: 5 });
    expect(after.body?.reason).not.toBe('agents_stopped');
  }, 180_000);
});
