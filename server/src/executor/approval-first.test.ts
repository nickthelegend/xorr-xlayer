/**
 * Tiers 6 and 7 ask before they buy (PLAN.md 1.10).
 *
 * `requiresApprovalByDefault` returns true from tier 6, and the momentum planner's docblock says it
 * "proposes rather than executes" — while nothing on the server enforced either, so a live momentum
 * strategy bought its breakout with nobody asked. These drive the real `runStrategy` with its
 * planner, the database, the chain and the trail replaced by recorders.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  statements: [] as { text: string; params: unknown[] }[],
  openProposal: false,
}));

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
      if (/FROM proposals/.test(text)) return h.openProposal ? { id: 'proposal-open' } : undefined;
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
  spendAsDelegate: vi.fn(),
  closeAsDelegate: vi.fn(),
  waitForTx: vi.fn(),
  // `run.ts` works out what `spend()` pulls before settlement, so a fork can measure it (PLAN.md X77).
  usdToUnits: vi.fn((usd: number) => BigInt(Math.round(usd * 1_000_000))),
  DELEGATION_ADDRESS: '0x6c5528Fd8E74a047A85bAb413856A9239E73540e',
}));
vi.mock('../graph/decide.js', () => ({ decide: vi.fn(async () => null) }));
vi.mock('./fill-measure.js', () => ({
  estimateOutUnits: vi.fn(async () => undefined),
  rawBalanceOf: vi.fn(),
  measuredDelta: vi.fn(),
}));
vi.mock('./settle.js', () => ({
  chooseSettlement: vi.fn(async () => {
    throw new Error('settlement reached');
  }),
}));
vi.mock('./kinds/index.js', () => ({
  PLANNERS: { momentum: vi.fn(), 'event-driven': vi.fn(), dca: vi.fn() },
  observationFor: vi.fn(async () => null),
}));

const { append } = await import('../audit/log.js');
const { send } = await import('../notifications/push.js');
const { spendAsDelegate } = await import('../evm/delegation.js');
const { chooseSettlement } = await import('./settle.js');
const { PLANNERS } = await import('./kinds/index.js');
const { runStrategy } = await import('./run.js');
type StrategyRow = import('./run.js').StrategyRow;

const at = new Date('2026-09-13T09:00:00Z');

const entry = {
  inSymbol: 'USDC',
  outSymbol: 'WETH',
  amountIn: 100,
  usd: 100,
  because: 'WETH closed above its 20-day high with the short average over the long one.',
  stateAfter: { openEntryPrice: 2_500, stopPrice: 2_300, openedAt: at.getTime() },
};
const close = {
  inSymbol: 'WETH',
  outSymbol: 'USDC',
  amountIn: 0.04,
  usd: 100,
  because: 'WETH fell through the 2,300 stop set when this entry opened.',
  stateAfter: { openEntryPrice: 0, stopPrice: 0 },
};

function strategy(overrides: Partial<StrategyRow> = {}): StrategyRow {
  return {
    id: 'strategy-6',
    wallet_id: 'wallet-1',
    kind: 'momentum',
    state: 'live',
    label: 'WETH breakout',
    symbol: 'WETH',
    params: { usdPerEntry: 100, lookbackDays: 20, stopPct: 8 } as never,
    cadence: 'daily',
    next_run_at: new Date(at.getTime() - 60_000),
    daily_allocation_usd: '100',
    retry_attempts: 0,
    ...overrides,
  } as StrategyRow;
}

const inserted = () => h.statements.filter((s) => /INSERT INTO proposals/.test(s.text));

beforeEach(() => {
  h.statements.length = 0;
  h.openProposal = false;
  vi.mocked(append).mockClear();
  vi.mocked(send).mockClear();
  vi.mocked(spendAsDelegate).mockClear();
  vi.mocked(chooseSettlement).mockClear();
  for (const planner of Object.values(PLANNERS)) vi.mocked(planner).mockReset();
});

describe('a momentum entry', () => {
  it('becomes a proposal, and nothing is sent to the chain', async () => {
    vi.mocked(PLANNERS.momentum!).mockResolvedValue(entry);

    const out = await runStrategy(strategy(), at);
    expect(out).toEqual({ status: 'skipped', reason: 'awaiting_approval' });
    expect(chooseSettlement).not.toHaveBeenCalled();
    expect(spendAsDelegate).not.toHaveBeenCalled();

    expect(inserted()).toHaveLength(1);
    const payload = JSON.parse(inserted()[0]!.params[3] as string) as Record<string, string>;
    expect(payload).toMatchObject({ strategyId: 'strategy-6', symbol: 'WETH', usd: '100', stopPrice: '2300' });
    expect(JSON.parse(payload.stateAfter!)).toMatchObject({ openEntryPrice: 2_500, stopPrice: 2_300 });

    expect(h.statements.some((s) => /error='awaiting_approval'/.test(s.text))).toBe(true);
    expect(h.statements.some((s) => /SET next_run_at = \$2, retry_attempts = 0/.test(s.text))).toBe(true);
    expect(vi.mocked(append).mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual([
      'Asked before buying WETH',
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('asks once while a proposal from the same strategy is still open', async () => {
    vi.mocked(PLANNERS.momentum!).mockResolvedValue(entry);
    h.openProposal = true;

    expect(await runStrategy(strategy(), at)).toEqual({ status: 'skipped', reason: 'awaiting_approval' });
    expect(inserted()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('goes straight to settlement when the user turned auto-execute on', async () => {
    vi.mocked(PLANNERS.momentum!).mockResolvedValue(entry);

    await runStrategy(strategy({ params: { usdPerEntry: 100, autoExecute: true } as never }), at);
    expect(inserted()).toHaveLength(0);
    expect(chooseSettlement).toHaveBeenCalledTimes(1);
  });
});

describe('what never waits for a yes', () => {
  it('a stop firing on a momentum position is not turned into a question', async () => {
    vi.mocked(PLANNERS.momentum!).mockResolvedValue(close);

    await runStrategy(strategy({ params: { openEntryPrice: 2_500, stopPrice: 2_300 } as never }), at);
    expect(inserted()).toHaveLength(0);
    expect(chooseSettlement).toHaveBeenCalledTimes(1);
  });

  it('a recurring buy — tier 1 — is placed on its schedule as before', async () => {
    vi.mocked(PLANNERS.dca!).mockResolvedValue(entry);

    await runStrategy(strategy({ kind: 'dca', label: 'Daily WETH' }), at);
    expect(inserted()).toHaveLength(0);
    expect(chooseSettlement).toHaveBeenCalledTimes(1);
  });
});
