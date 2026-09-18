/**
 * LIVE — approving a strategy's proposal fills it and hands the position to that strategy (PLAN.md 1.10).
 *
 * Tiers 6 and 7 no longer buy unattended: a live momentum or event-driven entry becomes a proposal.
 * Approving has to do two real things — place the order, and give the position to the strategy that
 * asked, with its entry at the price actually paid, so that strategy's own stop watches it. This
 * creates a paused momentum strategy, puts a proposal from it through the real API, approves it, and
 * reads the strategy's state back.
 *
 * Needs a chain 1inch settles on, so it runs against the fork. It spends $5 of fork USDC, sells the
 * WETH back and ends the strategy afterwards.
 *
 * Run: EXPO_PUBLIC_API_URL=<fork executor> LIVE=1 npx vitest run strategy-proposal.live
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';
const TOKEN_SCRIPT = fileURLToPath(new URL('../e2e-token.ts', import.meta.url));
const OWNER_EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';

const health = (await (await fetch(`${BASE}/health`)).json().catch(() => ({}))) as { chain?: string };
const SETTLES = health.chain === 'xlayer-fork' || health.chain === 'xlayer';

let token = '';
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const label = `proposal probe ${randomUUID().slice(0, 8)}`;
let strategyId = '';
let proposalId = '';

describe.skipIf(!SETTLES)(`a strategy's proposal, approved (needs a chain 1inch settles on; this is ${health.chain})`, () => {
  beforeAll(async () => {
    token = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OWNER_EMAIL], { encoding: 'utf8' }).trim();

    const created = await call('POST', '/strategies', {
      kind: 'momentum',
      state: 'paused',
      label,
      symbol: 'WETH',
      cadence: 'daily',
      dailyAllocationUsd: 5,
      params: { usdPerEntry: 5, lookbackDays: 20, stopPct: 8 },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    strategyId = String(created.body?.id);

    const proposal = await call('POST', '/proposals', {
      agent: 'Momentum Scout',
      ttlSeconds: 600,
      payload: {
        symbol: 'WETH',
        usd: '5',
        stopPrice: '1000',
        targetPrice: '',
        strategyId,
        // The planner's placeholder entry. Approving must replace it with the price actually paid.
        stateAfter: JSON.stringify({ openEntryPrice: 1, stopPrice: 1000, openedAt: Date.now() }),
        status: `${label} wants to trade`,
        action: 'Buy $5 of WETH',
        notional: '$5',
        entry: 'Market',
        stop: '$1,000',
        target: '—',
        rationale: 'A live probe of the tier 6 approval path.',
        onApprove: `Buys $5 of WETH; ${label} then manages the exit.`,
        onSkip: `Skipped. ${label} will look again on its next run.`,
      },
    });
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
    proposalId = String(proposal.body?.id);
  }, 120_000);

  afterAll(async () => {
    if (!token) return;
    await call('POST', '/positions/close', { symbol: 'WETH', fraction: 1 });
    if (strategyId) await call('DELETE', `/strategies/${strategyId}`);
  }, 180_000);

  it('fills, and the strategy that asked now holds the position at the price paid', async () => {
    const res = await call('POST', `/proposals/${proposalId}/decide`, { decision: 'approve' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body?.status, String(res.body?.message)).toBe('filled');
    expect(String(res.body?.signature)).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(String(res.body?.message)).toContain(`${label} now manages it, with its stop at $1,000`);

    const list = (await call('GET', '/strategies')).body as unknown as { id: string; params: Record<string, unknown> }[];
    const params = list.find((s) => s.id === strategyId)?.params ?? {};
    // A real WETH price, not the planner's placeholder of 1.
    expect(Number(params.openEntryPrice)).toBeGreaterThan(100);
    expect(Number(params.stopPrice)).toBe(1000);
  }, 180_000);
});
