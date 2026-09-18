/**
 * A close someone asked for, recorded from what actually arrived (PLAN.md 2.8).
 *
 * `closeHolding` booked the sale at the estimate it started from and wrote no `strategy_runs` row. These
 * drive the real function with the chain, the venue and the database replaced by recorders.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ statements: [] as { text: string; params: unknown[] }[] }));

vi.mock('../auth/middleware.js', () => ({ requireUser: vi.fn() }));
vi.mock('./wallet-context.js', () => ({ currentWallet: vi.fn() }));
vi.mock('../db/index.js', () => {
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      h.statements.push({ text, params });
      return { rows: [] };
    },
  };
  return { tx: async (fn: (c: typeof client) => Promise<unknown>) => fn(client) };
});
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../evm/balances.js', () => ({ holdings: vi.fn() }));
vi.mock('../evm/delegation.js', () => ({
  readPolicy: vi.fn(async () => ({ delegate: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5', dailyCapUsd: 2810, expiresAt: Date.now() + 86_400_000, revoked: false, remainingTodayUsd: 2810, spentTodayUsd: 0 })),
  closeAsDelegate: vi.fn(async () => `0x${'ab'.repeat(32)}`),
  waitForTx: vi.fn(async () => true),
  DELEGATION_ADDRESS: '0xc535e991ceca1bdad485425dae5840a39ba8e44e',
}));
vi.mock('../venues/oneinch.js', () => ({
  buildSwap: vi.fn(async () => ({ to: '0x111111125421cA6dc452d289314280a0f8842A65', data: '0xdead', value: '0', minOut: 1n })),
  SLIPPAGE: { panic: 3, stop: 1 },
  TOKENS: { WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 } },
  canonicalSymbol: (s: string) => s,
}));
vi.mock('../positions/index.js', () => ({ applyFill: vi.fn(async () => undefined) }));
vi.mock('../notifications/push.js', () => ({ send: vi.fn(async () => ({ sent: 0 })) }));
vi.mock('../executor/failure.js', () => ({ humanFailure: (e: string) => e }));
vi.mock('../executor/fill-measure.js', () => ({ usdcRawOf: vi.fn(), proceedsSince: vi.fn() }));
vi.mock('../portfolio/snapshots.js', () => ({ snapshotWallet: vi.fn(async () => true) }));

const { holdings } = await import('../evm/balances.js');
const { append } = await import('../audit/log.js');
const { applyFill } = await import('../positions/index.js');
const { proceedsSince, usdcRawOf } = await import('../executor/fill-measure.js');
const { closeHolding } = await import('./panic.js');

const wallet = { id: 'wallet-1', address: '0x95A0b368588713011a15f4b1041423f31B08e615' };
const inserted = (table: string) => h.statements.find((s) => s.text.includes(`INSERT INTO ${table}`));

beforeEach(() => {
  h.statements.length = 0;
  vi.mocked(append).mockClear();
  vi.mocked(applyFill).mockClear();
  vi.mocked(holdings).mockResolvedValue([{ symbol: 'WETH', units: 0.5, usd: 1250, raw: 500_000_000_000_000_000n }]);
  vi.mocked(usdcRawOf).mockResolvedValue(1_000_000_000n);
});

describe('a close', () => {
  it('books the USDC that arrived, and records the sale as a filled run', async () => {
    vi.mocked(proceedsSince).mockResolvedValue(1240.5);
    const out = await closeHolding({ wallet, symbol: 'WETH', fraction: 1, actor: 'You' });

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ status: 'closed', symbol: 'WETH', units: 0.5, usd: 1240.5, measured: true });
    expect(vi.mocked(applyFill).mock.calls[0]![1]).toEqual({
      walletId: 'wallet-1',
      symbol: 'WETH',
      units: -0.5,
      usd: -1240.5,
      // A close of one position, not a flatten: the two must not share a label.
      attribution: { source: 'manual', id: null, label: 'Close' },
    });

    const strategy = inserted('strategies')!;
    expect(strategy.text).toMatch(/\$3, 'ended'/);
    expect(strategy.params[2]).toBe('close');
    expect([strategy.params[1], strategy.params[3], strategy.params[4]]).toEqual(['wallet-1', 'Sold all WETH', 'WETH']);
    const run = inserted('strategy_runs')!;
    expect(run.text).toMatch(/'filled', \$4, \$5, \$6, \$7, \$8, 'sell'/);
    expect(run.params[7]).toBe('1inch');
    expect(run.params[1]).toBe(strategy.params[0]);
    // usd, units, price, signature, venue, quoted_usd, asset_class
    expect(run.params.slice(3)).toEqual([1240.5, 0.5, 2481, `0x${'ab'.repeat(32)}`, '1inch', 1250, 'crypto']);

    const trail = vi.mocked(append).mock.calls[0]![0] as { detail: string; payload: Record<string, unknown> };
    expect(trail.detail).toBe('0.500000 WETH for $1,240.50 USDC.');
    expect(trail.payload).toMatchObject({ usd: 1240.5, quotedUsd: 1250, measured: true, runId: run.params[0] });
  });

  it('when the balance cannot be read back, keeps the estimate, says so, and leaves the sale unmeasured', async () => {
    vi.mocked(proceedsSince).mockResolvedValue(undefined);
    const out = await closeHolding({ wallet, symbol: 'WETH', fraction: 1, actor: 'You' });

    expect(out.body).toMatchObject({ usd: 1250, measured: false });
    expect(inserted('strategy_runs')!.params[8]).toBeNull();
    const trail = vi.mocked(append).mock.calls[0]![0] as { detail: string };
    expect(trail.detail).toBe('0.500000 WETH for about $1,250.00 USDC (the balance could not be read back).');
  });

  it('a partial close sells exactly the fraction of the chain balance, not a float of it', async () => {
    vi.mocked(proceedsSince).mockResolvedValue(311);
    const out = await closeHolding({ wallet, symbol: 'WETH', fraction: 0.25, actor: 'You' });

    expect(out.body).toMatchObject({ units: 0.125, usd: 311 });
    expect(inserted('strategies')!.params[3]).toBe('Sold 25% of WETH');
    // The arrival value of a quarter of the holding.
    expect(inserted('strategy_runs')!.params[8]).toBe(312.5);
  });
});
