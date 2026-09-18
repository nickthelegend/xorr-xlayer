/**
 * LIVE — the onboarding rebalance can be created, watched and run (PLAN.md 2.16, 2.17).
 *
 * The one strategy onboarding creates — "Rebalance to targets" on `PORTFOLIO` — was refused by the executor.
 * On any chain: the impossible versions are refused and a real one is created with its targets stored under
 * the registry's names. On the fork, where fills settle: a watched one reports the leg its own planner would
 * trade, a live one buys it — $10 of WETH toward a 0.05% target — which is then sold back, and a live one
 * holding more than its target sells part of the position.
 *
 * Run: EXPO_PUBLIC_API_URL=<executor> LIVE=1 npx vitest run portfolio-rebalance.live
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8788';
const TOKEN_SCRIPT = fileURLToPath(new URL('../e2e-token.ts', import.meta.url));
const OWNER_EMAIL = process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io';

const health = (await (await fetch(`${BASE}/health`)).json().catch(() => ({}))) as { chain?: string };
const SETTLES = health.chain === 'base-fork' || health.chain === 'base';

let token = '';
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const created: string[] = [];
const rebalance = (state: string, targets: unknown, extra: Record<string, unknown> = {}) =>
  call('POST', '/strategies', {
    kind: 'rebalance',
    state,
    label: 'Rebalance to targets',
    symbol: 'PORTFOLIO',
    cadence: 'weekly',
    dailyAllocationUsd: 10,
    params: { targets },
    ...extra,
  });

beforeAll(() => {
  token = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OWNER_EMAIL], { encoding: 'utf8' }).trim();
}, 60_000);

afterAll(async () => {
  for (const id of created) await call('DELETE', `/strategies/${id}`);
}, 60_000);

describe(`a portfolio rebalance, created (this is ${health.chain})`, () => {
  it('refuses the versions that could never run', async () => {
    expect((await rebalance('paused', undefined)).status).toBe(400);
    expect((await rebalance('paused', {})).status).toBe(400);
    // Cash is whatever is not targeted; it is not something to buy with itself.
    expect((await rebalance('paused', { USDC: 10 })).status).toBe(400);
    expect((await rebalance('paused', { WETH: 70, CBBTC: 40 })).status).toBe(400);
    expect((await rebalance('paused', { DOGE: 5 })).status).toBe(400);
    const dca = await call('POST', '/strategies', {
      kind: 'dca',
      state: 'paused',
      label: 'not a portfolio',
      symbol: 'PORTFOLIO',
      cadence: 'weekly',
      dailyAllocationUsd: 5,
      params: { usd: 5 },
    });
    expect(dca.status).toBe(400);
    // Equities do not function on a fork or on Sepolia, so a target in one is refused the way a buy is.
    const equity = await rebalance('paused', { NVDAc: 5 });
    expect(equity.status).toBe(400);
    expect(equity.body?.error).toBe('not_settleable_here');
  }, 120_000);

  it('creates the onboarding rebalance, with its targets under the registry names', async () => {
    // Sent in the wrong case on purpose: stored under the registry's own names.
    const res = await rebalance('paused', { weth: 27.5, cbbtc: 27.5 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    created.push(String(res.body?.id));
    const stored = ((await call('GET', '/strategies')).body as unknown as { id: string; symbol: string; params: Record<string, unknown> }[]).find(
      (s) => s.id === res.body?.id,
    );
    expect(stored?.symbol).toBe('PORTFOLIO');
    expect(stored?.params.targets).toEqual({ WETH: 27.5, CBBTC: 27.5 });
  }, 60_000);
});

describe.skipIf(!SETTLES)(`a portfolio rebalance, run (needs a chain 1inch settles on; this is ${health.chain})`, () => {
  /*
   * What the planner trades depends on what the wallet already holds, and the account is shared with every other live
   * test. So each run below sets its holding up rather than assuming it: on 2026-09-15 the wallet held $486 of WETH, the
   * planner rightly sold toward a 0.05% target, and a case that expected a buy failed for it.
   */
  const wethHeld = async () => {
    const list = (await call('GET', '/positions')).body as unknown as { symbol: string; chainUnits: number | null }[];
    return Number(list.find((p) => p.symbol === 'WETH')?.chainUnits ?? 0);
  };
  const sellAllWeth = async () => {
    if ((await wethHeld()) <= 0) return;
    const sold = await call('POST', '/positions/close', { symbol: 'WETH', fraction: 1 });
    // What the executor will not sell as dust is below every target this file sets.
    if (sold.status !== 200) expect(sold.body?.reason, JSON.stringify(sold.body)).toBe('dust');
  };

  it('watched, reports the leg its planner would trade — priced by that leg, never as PORTFOLIO', async () => {
    const res = await rebalance('watch', { WETH: 0.05 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    created.push(String(res.body?.id));
    const run = await call('POST', `/strategies/${res.body?.id}/run`);
    expect(run.body, JSON.stringify(run.body)).toMatchObject({ status: 'watch' });
    expect(Number(run.body?.units)).toBeGreaterThan(0);
    expect(Number(run.body?.price)).toBeGreaterThan(100);
  }, 120_000);

  it('live, buys toward its target — and the WETH is sold back', async () => {
    await sellAllWeth();
    const res = await rebalance('live', { WETH: 0.05 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    created.push(String(res.body?.id));
    const run = await call('POST', `/strategies/${res.body?.id}/run`);
    expect(run.body, JSON.stringify(run.body)).toMatchObject({ status: 'filled' });
    expect(String(run.body?.signature)).toMatch(/^0x[0-9a-fA-F]{64}$/);
    // The planner sizes to the smaller of the drift (~$13 of a ~$26,000 portfolio) and the $10 allocation.
    const runs = (await call('GET', '/runs?limit=5')).body as unknown as { signature: string; usd: number; kind: string }[];
    const filled = runs.find((r) => r.signature === run.body?.signature);
    expect(filled?.kind).toBe('rebalance');
    expect(filled?.usd).toBeLessThanOrEqual(10);
    expect(await wethHeld()).toBeGreaterThan(0);

    const sold = await call('POST', '/positions/close', { symbol: 'WETH', fraction: 1 });
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
  }, 300_000);

  it('live, sells toward its target: part of the position, for exactly what the delegation sends', async () => {
    /*
     * A sell leg is sized in coins worked out from dollars, a float, and the router and the delegation each scaled it
     * to wei. They rounded differently, so in 42% of $10 sales the router asked for one wei more than it was approved
     * for and reverted with SafeTransferFromFailed. $20 of WETH against a 0.01% target: the planner sells $10 of it.
     */
    await sellAllWeth();
    const bought = await call('POST', '/orders', { symbol: 'WETH', usd: 20 });
    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    expect(bought.body?.status).toBe('filled');
    const before = await wethHeld();

    const res = await rebalance('live', { WETH: 0.01 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    created.push(String(res.body?.id));
    const run = await call('POST', `/strategies/${res.body?.id}/run`);
    expect(run.body, JSON.stringify(run.body)).toMatchObject({ status: 'filled' });
    expect(String(run.body?.signature)).toMatch(/^0x[0-9a-fA-F]{64}$/);
    const runs = (await call('GET', '/runs?limit=5')).body as unknown as { signature: string; usd: number; kind: string }[];
    const filled = runs.find((r) => r.signature === run.body?.signature);
    expect(filled?.kind).toBe('rebalance');
    /*
     * Sized to $10 of coins at the live price, and recorded as the USDC that arrived, which the fork pays at its pinned
     * pool's price: $10.01 on the first run at 05bbad1. So it is held near $10, not under it.
     */
    expect(filled?.usd).toBeGreaterThan(5);
    expect(filled?.usd).toBeLessThan(15);
    // Part of the position: less than before, and not all of it.
    const after = await wethHeld();
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);

    const sold = await call('POST', '/positions/close', { symbol: 'WETH', fraction: 1 });
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
  }, 300_000);
});
