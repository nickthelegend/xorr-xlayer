/**
 * LIVE — a sale someone asks for is recorded from what arrived (PLAN.md 2.8, 2.9).
 *
 * Buys a little WETH on the fork, closes half of what the wallet holds through `/positions/close` and
 * flattens the rest through `/panic/flatten`, then reads the record back: each sale answers with the USDC
 * that arrived, `/runs` holds a filled `close` run for each at that amount, and fill quality counts sales.
 * Needs a chain 1inch settles on; spends $8 of fork USDC and sells the wallet's WETH back.
 *
 * Run: EXPO_PUBLIC_API_URL=<fork executor> LIVE=1 npx vitest run sale-record.live
 */
import { beforeAll, describe, expect, it } from 'vitest';
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

type Run = { kind: string; label: string; status: string; usd: number | null; units: number | null; signature: string | null };
const runFor = async (signature: string) =>
  ((await call('GET', '/runs?limit=50')).body as unknown as Run[]).find((r) => r.signature === signature);

type Held = { symbol: string; chainUnits: number | null; mark: number; feed: 'live' | 'unavailable' };
const positionIn = async (symbol: string) =>
  ((await call('GET', '/positions')).body as unknown as Held[]).find((p) => p.symbol === symbol);

describe.skipIf(!SETTLES)(`sales, recorded from what arrived (needs a chain 1inch settles on; this is ${health.chain})`, () => {
  beforeAll(() => {
    token = execFileSync('npx', ['tsx', TOKEN_SCRIPT, OWNER_EMAIL], { encoding: 'utf8' }).trim();
  }, 60_000);

  it('a close answers with the USDC that arrived and leaves a filled run for that amount', async () => {
    const bought = await call('POST', '/orders', { symbol: 'WETH', usd: 8 });
    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    expect(bought.body?.status).toBe('filled');

    /*
     * Half of what the wallet holds, not half of this buy.
     *
     * The account is shared with every other live test, so WETH bought before this one is sold with it: on
     * 2026-09-15 the close sold 0.0987 WETH for $247.22 against a check that expected under $6. The answer is
     * held to the chain's own balance and to the price instead, which is what "the USDC that arrived" means.
     */
    const before = await positionIn('WETH');
    const heldUnits = Number(before?.chainUnits ?? 0);
    expect(heldUnits, JSON.stringify(before)).toBeGreaterThan(0);
    expect(before?.feed, 'a price to hold the proceeds to').toBe('live');

    const closed = await call('POST', '/positions/close', { symbol: 'WETH', fraction: 0.5 });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', symbol: 'WETH', measured: true });
    const usd = Number(closed.body?.usd);
    const units = Number(closed.body?.units);
    // Half the chain's balance, taken in integer maths.
    expect(units).toBeCloseTo(heldUnits / 2, 6);
    // What arrived, per coin: the price, less two swaps' costs and whatever the price did in between.
    expect(Math.abs(usd / units / before!.mark - 1)).toBeLessThan(0.03);

    const run = await runFor(String(closed.body?.txHash));
    expect(run, 'a run for the close').toBeDefined();
    expect(run).toMatchObject({ kind: 'close', status: 'filled', label: 'Sold 50% of WETH' });
    // Stored to the cent and the nine decimals the columns keep.
    expect(run!.usd).toBeCloseTo(usd, 1);
    expect(run!.units).toBeCloseTo(units, 8);
  }, 300_000);

  it('a flatten does the same for every leg it sells', async () => {
    const flat = await call('POST', '/panic/flatten');
    expect(flat.status, JSON.stringify(flat.body)).toBe(200);
    const legs = (flat.body?.legs ?? []) as { symbol: string; status: string; usd: number; detail: string; signature?: string }[];
    const weth = legs.find((l) => l.symbol === 'WETH');
    expect(weth, JSON.stringify(legs)).toMatchObject({ status: 'sold' });
    expect(weth!.usd).toBeGreaterThan(1);
    expect(weth!.detail).not.toMatch(/about \$/);

    const run = await runFor(weth!.signature!);
    expect(run).toMatchObject({ kind: 'close', status: 'filled', label: 'Flatten: sold all WETH' });
    expect(run!.usd).toBeCloseTo(weth!.usd, 1);
  }, 300_000);

  it('fill quality scores the sales, and the venue count comes from the runs', async () => {
    const metrics = (await (await fetch(`${BASE}/metrics`)).json()) as {
      fillsByVenue: Record<string, number>;
      fillQuality: { venues: { venue: string; sells?: number }[] } | null;
    };
    expect(metrics.fillsByVenue['1inch'] ?? 0).toBeGreaterThanOrEqual(3);
    expect((metrics.fillQuality?.venues ?? []).reduce((n, v) => n + (v.sells ?? 0), 0)).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
