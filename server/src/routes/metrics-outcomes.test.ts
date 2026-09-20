/**
 * What `/metrics` calls a failure.
 *
 * `reconcile:orphans` marks a fill `failed` with `not_on_chain:` when a fork is rebuilt underneath it — the trade did
 * happen, on a chain that stopped existing. Counted with the genuine failures, twenty-one of those made the screen say
 * "67.6% of attempts broke rather than filled" about an executor whose attempts were nearly all fine.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.XORR_CHAIN = 'xlayer-fork';
  process.env.PRIVY_APP_ID = 'test';
  process.env.PRIVY_APP_SECRET = 'test';
});

const asked: string[] = [];
const rows = vi.fn(async (sql: string): Promise<unknown[]> => {
  if (/GROUP BY status/.test(sql)) return [{ status: 'filled', n: '11' }, { status: 'failed', n: '23' }];
  // The cause breakdown, which must not be asked about the rebuilt-chain runs at all.
  if (/GROUP BY error/.test(sql)) {
    asked.push(sql);
    return [{ error: 'ReturnAmountIsNotEnough', n: '2' }];
  }
  if (/not_on_chain/.test(sql)) return [{ n: '21' }];
  return [];
});

vi.mock('../db/index.js', () => ({ query: (sql: string) => rows(sql), one: async () => null }));
vi.mock('../db/chain-scope.js', () => ({ THIS_CHAIN: `'xlayer-fork'` }));

const { ops } = await import('./ops.js');

describe('/metrics', () => {
  it('counts a rebuilt chain apart from the attempts that broke', async () => {
    const res = await ops.request('/metrics');
    const body = (await res.json()) as { runs: Record<string, number>; runFailureRate: number };
    expect(body.runs.filled).toBe(11);
    expect(body.runs.failed).toBe(2);
    expect(body.runs['not on chain']).toBe(21);
    // Two genuine failures against eleven fills, not twenty-three.
    expect(body.runFailureRate).toBeCloseTo(2 / 13, 6);
  });

  it('leaves the rebuilt-chain runs out of "why runs failed" as well', async () => {
    await ops.request('/metrics');
    expect(asked.join(' ')).toMatch(/NOT LIKE 'not_on_chain:%'/);
    const res = await ops.request('/metrics');
    const body = (await res.json()) as { failuresByCause: Record<string, number> };
    expect(body.failuresByCause).toEqual({ price_moved: 2 });
  });
});
