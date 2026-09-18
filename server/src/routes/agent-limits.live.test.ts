/**
 * LIVE — a hired agent held to its own limits (PLAN.md 2.15).
 *
 * Hires Momentum Scout on the test account (restoring whatever was there), limits it to $3 a trade, and runs a
 * $5 recurring buy it owns: the run is refused with the agent's reason before anything is planned onto the
 * chain. A limit spelled any other way is refused rather than stored. Runs on the fork, where no index stands
 * between the rules and the agent check.
 *
 * Run: EXPO_PUBLIC_API_URL=<fork executor> LIVE=1 npx vitest run agent-limits.live
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';
const TOKEN_SCRIPT = fileURLToPath(new URL('../e2e-token.ts', import.meta.url));
const OWNER_EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';

const health = (await (await fetch(`${BASE}/health`)).json().catch(() => ({}))) as { chain?: string };
const FORK = health.chain === 'base-fork';

let token = '';
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

type Agent = { id: string; personaId: string; hired: boolean; riskLimits: Record<string, unknown> };
let agent: Agent | undefined;
let wasHired = false;
let priorLimits: Record<string, unknown> = {};
let strategyId = '';

describe.skipIf(!FORK)(`an agent's own limits (runs on the fork; this is ${health.chain})`, () => {
  beforeAll(async () => {
    token = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OWNER_EMAIL], { encoding: 'utf8' }).trim();
    const roster = (await call('GET', '/agents')).body as unknown as Agent[];
    const before = roster.find((a) => a.personaId === 'momentum-scout');
    wasHired = before?.hired === true;
    priorLimits = before?.riskLimits ?? {};
    const hired = await call('POST', '/agents', { personaId: 'momentum-scout' });
    expect(hired.status, JSON.stringify(hired.body)).toBe(200);
    agent = hired.body as unknown as Agent;
  }, 120_000);

  afterAll(async () => {
    if (!token || !agent) return;
    if (strategyId) await call('DELETE', `/strategies/${strategyId}`);
    await call('PATCH', `/agents/${agent.id}`, { riskLimits: priorLimits });
    if (!wasHired) await call('DELETE', `/agents/${agent.id}`);
  }, 60_000);

  it('refuses a limit it does not enforce, rather than storing one that does nothing', async () => {
    const res = await call('PATCH', `/agents/${agent!.id}`, { riskLimits: { maxPerTrade: 3 } });
    expect(res.status).toBe(400);
  });

  it('refuses a trade larger than the agent may place, with the agent named', async () => {
    const limited = await call('PATCH', `/agents/${agent!.id}`, { riskLimits: { maxUsdPerTrade: 3 } });
    expect(limited.status, JSON.stringify(limited.body)).toBe(200);
    expect(limited.body?.riskLimits).toEqual({ maxUsdPerTrade: 3 });

    const created = await call('POST', '/strategies', {
      kind: 'dca',
      state: 'paused',
      label: `agent limit probe ${randomUUID().slice(0, 8)}`,
      symbol: 'WETH',
      cadence: 'weekly',
      dailyAllocationUsd: 5,
      params: { usd: 5 },
      agentId: agent!.id,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    strategyId = String(created.body?.id);

    const run = await call('POST', `/strategies/${strategyId}/run`);
    expect(run.body, JSON.stringify(run.body)).toMatchObject({
      status: 'blocked',
      reason: 'agent_trade_limit',
      detail: 'Momentum Scout is limited to $3.00 a trade, and this one was $5.00.',
    });
  }, 180_000);
});
