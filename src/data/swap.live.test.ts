/**
 * LIVE — the Swap screen's own request, against a real executor (PLAN.md 3.9).
 *
 * The body is built by `swapRequest`, the function the screen builds it with, and sent to `POST /swap` the way
 * `system.swap` sends it. On the X Layer fork, where fills settle, it swaps for real: $15 of USDC into XBTC — a one-shot
 * buy, through best execution — then half of that XBTC into WOKB through `closePosition()`, exactly the units typed;
 * both are then sold back. Where nothing settles, the executor refuses before reading anything.
 *
 * Run: EXPO_PUBLIC_API_URL=<executor> LIVE=1 npx vitest run src/data/swap.live.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { API_BASE } from './apiBase';
import { swapRequest } from '../state/derived';

const health = (await (await fetch(`${API_BASE}/health`)).json().catch(() => ({}))) as { chain?: string };
const SETTLES = health.chain === 'xlayer' || health.chain === 'xlayer-fork';

let token = '';
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeAll(() => {
  token = execFileSync('npx', ['tsx', 'server/src/e2e-token.ts', process.env.E2E_PRIVY_EMAIL ?? 'test-8958@privy.io'], {
    encoding: 'utf8',
  }).trim();
}, 60_000);

describe.skipIf(SETTLES)(`where nothing settles (this is ${health.chain})`, () => {
  it('refuses the swap before reading anything', async () => {
    const r = await call('POST', '/swap', swapRequest({ pay: 'USDC', receive: 'XBTC', amount: '15', slippagePct: 0.5 }));
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body).toMatchObject({ status: 'blocked', reason: 'not_settleable_here' });
  }, 60_000);
});

describe.skipIf(!SETTLES)(`a real swap, from the screen's request (this is ${health.chain})`, () => {
  let xbtc = 0;

  afterAll(async () => {
    if (!token) return;
    // Whatever was bought is sold back, so the account ends where it started, less the cost of the trades.
    await call('POST', '/positions/close', { symbol: 'WOKB', fraction: 1 });
    await call('POST', '/positions/close', { symbol: 'XBTC', fraction: 1 });
  }, 300_000);

  it('quotes at the tolerance the screen shows', async () => {
    const q = await call('GET', '/swap/quote?in=USDC&out=XBTC&amount=15&slippage=0.5');
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body?.slippagePct).toBe(0.5);
    expect(Number(q.body?.minimumOut)).toBeCloseTo(Number(q.body?.outAmount) * 0.995, 10);
    expect((await call('GET', '/swap/quote?in=USDC&out=XBTC&amount=15&slippage=9')).status).toBe(400);
  }, 60_000);

  it('USDC into XBTC: a one-shot buy, settled where it delivers the most', async () => {
    const r = await call('POST', '/swap', swapRequest({ pay: 'USDC', receive: 'XBTC', amount: '15', slippagePct: 0.5 }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'filled', from: 'USDC', to: 'XBTC', sold: 15 });
    expect(Number(r.body?.received)).toBeGreaterThan(0);
    expect(['uniswap-v3', 'okx-dex']).toContain(r.body?.venue);
    expect(String(r.body?.txHash)).toMatch(/^0x[0-9a-fA-F]{64}$/);
    xbtc = Number(r.body?.received);
  }, 300_000);

  it('XBTC into WOKB: exactly the units typed, through closePosition(), recorded as a swap', async () => {
    expect(xbtc, 'the buy above must have filled').toBeGreaterThan(0);
    const amount = (xbtc / 2).toFixed(8);
    const r = await call('POST', '/swap', swapRequest({ pay: 'XBTC', receive: 'WOKB', amount, slippagePct: 1 }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'filled', from: 'XBTC', to: 'WOKB', sold: Number(amount), measured: true });
    expect(Number(r.body?.received)).toBeGreaterThan(0);

    const runs = (await call('GET', '/runs?limit=10')).body as unknown as { signature: string; kind: string; side: string; venue: string }[];
    const run = runs.find((x) => x.signature === r.body?.txHash);
    expect(run).toMatchObject({ kind: 'swap', side: 'sell', venue: r.body?.venue });
  }, 300_000);

  it('refuses more than is held, and the same token twice, without sending anything', async () => {
    const tooMuch = await call('POST', '/swap', swapRequest({ pay: 'XBTC', receive: 'USDC', amount: '1000', slippagePct: 0.5 }));
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body).toMatchObject({ reason: 'insufficient' });
    const same = await call('POST', '/swap', { from: 'XBTC', to: 'xbtc', amount: '1' });
    expect(same.body).toMatchObject({ reason: 'same_token' });
  }, 60_000);
});
