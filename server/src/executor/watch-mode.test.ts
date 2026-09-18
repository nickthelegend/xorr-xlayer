/**
 * Watch mode runs the strategy's own planner (PLAN.md 2.16).
 *
 * Every watch run reported "Would have bought {usd ÷ price} {symbol}" whatever the strategy was. These drive the
 * real `runStrategy` on a `watch` strategy with the planners, the wallet read and the trail replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ statements: [] as { text: string; params: unknown[] }[] }));

vi.mock('../db/index.js', () => {
  const record = (text: string, params: unknown[] = []) => h.statements.push({ text, params });
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      record(text, params);
      return { rows: /INSERT INTO strategy_runs/.test(text) ? [{ id: 'run-1' }] : [] };
    },
  };
  return {
    tx: async (fn: (c: typeof client) => Promise<unknown>) => fn(client),
    query: async (text: string, params: unknown[] = []) => {
      record(text, params);
      return [];
    },
    one: async (text: string, params: unknown[] = []) => {
      record(text, params);
      return /FROM wallets/.test(text) ? { address: '0x95A0b368588713011a15f4b1041423f31B08e615' } : undefined;
    },
  };
});
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../notifications/push.js', () => ({ send: vi.fn(async () => ({ sent: 0, skipped: 0, errors: [] })) }));
vi.mock('../rules/engine.js', () => ({ evaluate: vi.fn(), recordSpend: vi.fn() }));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn(async () => 2_500) }));
vi.mock('../evm/gas.js', () => ({ gasStatus: vi.fn() }));
vi.mock('../evm/client.js', () => ({
  publicClient: {},
  walletClient: {},
  delegateAccount: { address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' },
}));
vi.mock('../evm/delegation.js', () => ({
  readPolicy: vi.fn(),
  spendAsDelegate: vi.fn(),
  closeAsDelegate: vi.fn(),
  waitForTx: vi.fn(),
  DELEGATION_ADDRESS: '0x6c5528Fd8E74a047A85bAb413856A9239E73540e',
}));
vi.mock('../graph/decide.js', () => ({ decide: vi.fn() }));
vi.mock('./fill-measure.js', () => ({ estimateOutUnits: vi.fn(), rawBalanceOf: vi.fn(), measuredDelta: vi.fn() }));
vi.mock('./settle.js', () => ({ chooseSettlement: vi.fn() }));
vi.mock('../portfolio/snapshots.js', () => ({ snapshotWallet: vi.fn(async () => true) }));
vi.mock('./kinds/index.js', () => ({
  PLANNERS: { momentum: vi.fn(), 'exit-rules': vi.fn(), rebalance: vi.fn() },
  observationFor: vi.fn(async () => null),
}));

const { append } = await import('../audit/log.js');
const { evaluate } = await import('../rules/engine.js');
const { priceOf } = await import('../market/prices.js');
const { readPolicy, spendAsDelegate, closeAsDelegate } = await import('../evm/delegation.js');
const { chooseSettlement } = await import('./settle.js');
const { PLANNERS, observationFor } = await import('./kinds/index.js');
const { runStrategy } = await import('./run.js');
type StrategyRow = import('./run.js').StrategyRow;

const at = new Date('2026-09-13T09:00:00Z');

function watched(overrides: Partial<StrategyRow> = {}): StrategyRow {
  return {
    id: 'strategy-1',
    wallet_id: 'wallet-1',
    kind: 'momentum',
    state: 'watch',
    label: 'WETH breakout',
    symbol: 'WETH',
    params: { usd: 100, lookbackDays: 20 } as never,
    cadence: 'daily',
    next_run_at: new Date(at.getTime() - 60_000),
    daily_allocation_usd: '100',
    retry_attempts: 0,
    ...overrides,
  } as StrategyRow;
}

const trail = () => vi.mocked(append).mock.calls.map((c) => c[0] as { action: string; detail: string; payload: Record<string, unknown> });
const runUpdate = () => h.statements.find((s) => /error='watch_mode'/.test(s.text))!;
const nothingSent = () => {
  expect(evaluate).not.toHaveBeenCalled();
  expect(readPolicy).not.toHaveBeenCalled();
  expect(chooseSettlement).not.toHaveBeenCalled();
  expect(spendAsDelegate).not.toHaveBeenCalled();
  expect(closeAsDelegate).not.toHaveBeenCalled();
};

beforeEach(() => {
  h.statements.length = 0;
  vi.mocked(append).mockClear();
  vi.mocked(priceOf).mockClear();
  vi.mocked(observationFor).mockReset();
  vi.mocked(observationFor).mockResolvedValue(null);
  for (const p of Object.values(PLANNERS)) vi.mocked(p).mockReset();
});

describe('a watched strategy', () => {
  it('reports the entry its own planner would make, and places nothing', async () => {
    vi.mocked(PLANNERS.momentum!).mockResolvedValue({
      inSymbol: 'USDC',
      outSymbol: 'WETH',
      amountIn: 100,
      usd: 100,
      because: 'WETH closed above its 20-day high.',
    });
    expect(await runStrategy(watched(), at)).toEqual({ status: 'watch', runId: 'run-1', units: 0.04, price: 2_500 });
    expect(runUpdate().params).toEqual(['run-1', 100, 0.04, 2_500]);
    expect(trail()[0]).toMatchObject({ action: 'Would have bought 0.0400 WETH' });
    expect(trail()[0]!.detail).toContain('WETH closed above its 20-day high. No capital moved.');
    nothingSent();
  });

  it('a watched stop reports the sale it would make — not a buy', async () => {
    vi.mocked(PLANNERS['exit-rules']!).mockResolvedValue({
      inSymbol: 'WETH',
      outSymbol: 'USDC',
      amountIn: 0.04,
      usd: 100,
      because: 'WETH fell through the stop.',
    });
    await runStrategy(watched({ kind: 'exit-rules', label: 'Auto close WETH' }), at);
    expect(trail()[0]).toMatchObject({ action: 'Would have sold 0.0400 WETH' });
    nothingSent();
  });

  it('with nothing to do, says so instead of inventing a buy', async () => {
    vi.mocked(PLANNERS.momentum!).mockResolvedValue(null);
    expect(await runStrategy(watched(), at)).toEqual({ status: 'skipped', reason: 'nothing_to_do' });
    expect(runUpdate().params).toEqual(['run-1', null, null, null]);
    expect(trail()[0]).toMatchObject({ action: 'Would have done nothing' });
    nothingSent();
  });

  it('hands the planner what it observed, and keeps none of it', async () => {
    vi.mocked(observationFor).mockResolvedValue({ peakPrice: 3_000 });
    vi.mocked(PLANNERS.momentum!).mockResolvedValue(null);
    await runStrategy(watched(), at);
    expect(vi.mocked(PLANNERS.momentum!).mock.calls[0]![0]).toMatchObject({ params: { peakPrice: 3_000 } });
    expect(h.statements.some((s) => /UPDATE strategies SET params/.test(s.text))).toBe(false);
  });

  it('a portfolio rebalance is priced by the leg it would trade, never as "PORTFOLIO"', async () => {
    vi.mocked(PLANNERS.rebalance!).mockResolvedValue({
      inSymbol: 'USDC',
      outSymbol: 'CBBTC',
      amountIn: 50,
      usd: 50,
      because: 'CBBTC is 4.0% under its target weight.',
    });
    await runStrategy(watched({ kind: 'rebalance', symbol: 'PORTFOLIO', label: 'Rebalance to targets' }), at);
    expect(vi.mocked(priceOf).mock.calls.map((c) => c[0])).toEqual(['CBBTC']);
    expect(trail()[0]).toMatchObject({ action: 'Would have bought 0.0200 CBBTC' });
  });
});
