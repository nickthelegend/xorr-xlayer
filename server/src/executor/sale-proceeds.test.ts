/**
 * A strategy's sale, recorded from what it paid (PLAN.md 2.8, 2.9).
 *
 * A close booked `intent.usd` — the value its run started from — as its proceeds, and its run carried no
 * quote a sale could be measured against. These drive the real `runStrategy` with its planner, the
 * settlement choice, the chain and the database replaced by recorders.
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
      if (/FROM wallets/.test(text)) return { address: '0x95A0b368588713011a15f4b1041423f31B08e615' };
      return undefined;
    },
  };
});
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../notifications/push.js', () => ({ send: vi.fn(async () => ({ sent: 0, skipped: 0, errors: [] })) }));
vi.mock('../rules/engine.js', () => ({
  evaluate: vi.fn(async () => ({ allowed: true, remainingUsd: 2_000 })),
  recordSpend: vi.fn(),
}));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn(async () => 2_500) }));
vi.mock('../evm/gas.js', () => ({ gasStatus: vi.fn(async () => ({ enough: true })) }));
vi.mock('../evm/client.js', () => ({
  publicClient: {},
  walletClient: {},
  delegateAccount: { address: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' },
}));
vi.mock('../evm/delegation.js', () => ({
  readPolicy: vi.fn(async () => ({
    delegate: '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5',
    dailyCapUsd: 2_000,
    expiresAt: Date.now() + 86_400_000,
    revoked: false,
    remainingTodayUsd: 2_000,
    spentTodayUsd: 0,
  })),
  spendAsDelegate: vi.fn(async () => `0x${'cd'.repeat(32)}`),
  closeAsDelegate: vi.fn(async () => `0x${'ab'.repeat(32)}`),
  waitForTx: vi.fn(async () => true),
  // `run.ts` works out what `spend()` pulls before settlement, so a fork can measure it (PLAN.md X77).
  usdToUnits: vi.fn((usd: number) => BigInt(Math.round(usd * 1_000_000))),
  DELEGATION_ADDRESS: '0x6c5528Fd8E74a047A85bAb413856A9239E73540e',
}));
vi.mock('../graph/decide.js', () => ({ decide: vi.fn(async () => null) }));
vi.mock('../positions/index.js', () => ({ applyFill: vi.fn(async () => undefined) }));
vi.mock('./fill-measure.js', () => ({
  estimateOutUnits: vi.fn(async () => undefined),
  rawBalanceOf: vi.fn(async () => 40_000_000_000_000_000n),
  measuredDelta: vi.fn(),
  usdcRawOf: vi.fn(async () => 5_000_000_000n),
  proceedsSince: vi.fn(),
}));
vi.mock('./settle.js', () => ({ chooseSettlement: vi.fn() }));
vi.mock('../portfolio/snapshots.js', () => ({ snapshotWallet: vi.fn(async () => true) }));
vi.mock('./kinds/index.js', () => ({
  PLANNERS: { momentum: vi.fn(), dca: vi.fn() },
  observationFor: vi.fn(async () => null),
}));

const { recordSpend } = await import('../rules/engine.js');
const { applyFill } = await import('../positions/index.js');
const { measuredDelta, proceedsSince, usdcRawOf } = await import('./fill-measure.js');
const { chooseSettlement } = await import('./settle.js');
const { PLANNERS } = await import('./kinds/index.js');
const { runStrategy } = await import('./run.js');
type StrategyRow = import('./run.js').StrategyRow;

const at = new Date('2026-09-13T09:00:00Z');
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function strategy(overrides: Partial<StrategyRow> = {}): StrategyRow {
  return {
    id: 'strategy-1',
    wallet_id: 'wallet-1',
    kind: 'momentum',
    state: 'live',
    label: 'WETH breakout',
    symbol: 'WETH',
    params: { openEntryPrice: 2_500, stopPrice: 2_300 } as never,
    cadence: 'daily',
    next_run_at: new Date(at.getTime() - 60_000),
    daily_allocation_usd: '100',
    retry_attempts: 0,
    ...overrides,
  } as StrategyRow;
}

const filledUpdate = () => h.statements.find((s) => /SET status='filled'/.test(s.text))!;

beforeEach(() => {
  h.statements.length = 0;
  vi.mocked(applyFill).mockClear();
  vi.mocked(recordSpend).mockClear();
  vi.mocked(usdcRawOf).mockClear();
  vi.mocked(PLANNERS.momentum!).mockReset();
  vi.mocked(PLANNERS.dca!).mockReset();
});

describe('a stop that sells', () => {
  beforeEach(() => {
    vi.mocked(PLANNERS.momentum!).mockResolvedValue({
      inSymbol: 'WETH',
      outSymbol: 'USDC',
      amountIn: 0.04,
      usd: 100,
      because: 'WETH fell through the stop.',
      stateAfter: { openEntryPrice: 0, stopPrice: 0 },
    });
    vi.mocked(chooseSettlement).mockResolvedValue({
      payToken: { symbol: 'WETH', address: WETH, decimals: 18 },
      swap: { to: '0x111111125421cA6dc452d289314280a0f8842A65', data: '0xdead', value: '0', minOut: 1n },
      venue: '1inch',
      floor: { tokenOut: USDC, minOut: 1n },
    } as never);
    vi.mocked(measuredDelta).mockResolvedValue(-0.04);
  });

  it('books the USDC that arrived and keeps the arrival value beside it', async () => {
    vi.mocked(proceedsSince).mockResolvedValue(98.7);
    const out = await runStrategy(strategy(), at);

    expect(out.status).toBe('filled');
    // run, signature, units, price, usd, quoted_units, venue, side, quoted_usd, asset_class
    expect(filledUpdate().params.slice(2)).toEqual([0.04, 2_500, 98.7, 0.04, '1inch', 'sell', 100, 'crypto']);
    expect(vi.mocked(applyFill).mock.calls[0]![1]).toMatchObject({ symbol: 'WETH', units: -0.04, usd: -98.7 });
    // Closing is not spending.
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it('when the balance cannot be read back, books the estimate and keeps no quote to score it by', async () => {
    vi.mocked(proceedsSince).mockResolvedValue(undefined);
    await runStrategy(strategy(), at);

    const params = filledUpdate().params;
    expect(params[4]).toBe(100);
    expect(params[8]).toBeNull();
    expect(vi.mocked(applyFill).mock.calls[0]![1]).toMatchObject({ usd: -100 });
  });
});

describe('a buy', () => {
  it('is recorded as a buy, with no sale quote and no USDC read', async () => {
    vi.mocked(PLANNERS.dca!).mockResolvedValue({
      inSymbol: 'USDC',
      outSymbol: 'WETH',
      amountIn: 100,
      usd: 100,
      because: 'The weekly buy.',
    });
    vi.mocked(chooseSettlement).mockResolvedValue({
      payToken: { symbol: 'USDC', address: USDC, decimals: 6 },
      swap: { to: '0x111111125421cA6dc452d289314280a0f8842A65', data: '0xbeef', value: '0', minOut: 1n },
      venue: '1inch',
      floor: { tokenOut: WETH, minOut: 1n },
    } as never);
    vi.mocked(measuredDelta).mockResolvedValue(0.0398);

    await runStrategy(strategy({ kind: 'dca', label: 'Weekly WETH', params: { usd: 100 } as never }), at);

    const params = filledUpdate().params;
    expect(params.slice(2, 5)).toEqual([0.0398, 2_500, 100]);
    expect(params.slice(7)).toEqual(['buy', null, 'crypto']);
    expect(usdcRawOf).not.toHaveBeenCalled();
    expect(recordSpend).toHaveBeenCalledTimes(1);
  });
});
