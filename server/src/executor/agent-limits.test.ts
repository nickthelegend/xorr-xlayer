/**
 * A hired agent's own limits (PLAN.md 2.15).
 *
 * `agents.risk_limits` was stored and shown and enforced nowhere. These drive the real `runStrategy`, with the
 * agent row, the day's spend, the planner and settlement replaced by recorders.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  limits: {} as Record<string, unknown>,
  spent: '0',
  statements: [] as { text: string; params: unknown[] }[],
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
      return /s\.agent_id = \$1/.test(text) ? [{ spent: h.spent }] : [];
    },
    one: async (text: string, params: unknown[] = []) => {
      record(text, params);
      if (/FROM wallets/.test(text)) return { address: '0x95A0b368588713011a15f4b1041423f31B08e615' };
      if (/FROM agents/.test(text)) return { name: 'Momentum Scout', risk_limits: h.limits };
      return undefined;
    },
  };
});
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../notifications/push.js', () => ({ send: vi.fn(async () => ({ sent: 0, skipped: 0, errors: [] })) }));
vi.mock('../rules/engine.js', () => ({
  evaluate: vi.fn(async () => ({ allowed: true, spentTodayUsd: 0, remainingUsd: 2_000 })),
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
vi.mock('./fill-measure.js', () => ({ estimateOutUnits: vi.fn(async () => undefined), rawBalanceOf: vi.fn(), measuredDelta: vi.fn() }));
vi.mock('./settle.js', () => ({
  chooseSettlement: vi.fn(async () => {
    throw new Error('settlement reached');
  }),
}));
vi.mock('../portfolio/snapshots.js', () => ({ snapshotWallet: vi.fn(async () => true) }));
vi.mock('./kinds/index.js', () => ({ PLANNERS: { momentum: vi.fn() }, observationFor: vi.fn(async () => null) }));

const { chooseSettlement } = await import('./settle.js');
const { PLANNERS } = await import('./kinds/index.js');
const { runStrategy } = await import('./run.js');
type StrategyRow = import('./run.js').StrategyRow;

const at = new Date('2026-09-13T09:00:00Z');
const entry = { inSymbol: 'USDC', outSymbol: 'WETH', amountIn: 100, usd: 100, because: 'A breakout.' };
const close = { inSymbol: 'WETH', outSymbol: 'USDC', amountIn: 0.04, usd: 100, because: 'The stop fired.' };

function strategy(overrides: Partial<StrategyRow> = {}): StrategyRow {
  return {
    id: 'strategy-1',
    wallet_id: 'wallet-1',
    kind: 'momentum',
    state: 'live',
    label: 'WETH breakout',
    symbol: 'WETH',
    // Auto-execute, so a trade inside the limits goes on to settlement rather than to a proposal.
    params: { autoExecute: true } as never,
    cadence: 'daily',
    next_run_at: new Date(at.getTime() - 60_000),
    daily_allocation_usd: '1000',
    retry_attempts: 0,
    agent_id: 'agent-1',
    ...overrides,
  } as StrategyRow;
}

const agentLookups = () => h.statements.filter((s) => /FROM agents/.test(s.text));

beforeEach(() => {
  h.statements.length = 0;
  h.limits = {};
  h.spent = '0';
  vi.mocked(chooseSettlement).mockClear();
  vi.mocked(PLANNERS.momentum!).mockReset();
  vi.mocked(PLANNERS.momentum!).mockResolvedValue(entry);
});

describe("an agent's limits", () => {
  it('refuse an entry larger than one trade may be, before anything is proposed or sent', async () => {
    h.limits = { maxUsdPerTrade: 50 };
    const out = await runStrategy(strategy({ params: {} as never }), at);
    expect(out).toMatchObject({
      status: 'blocked',
      reason: 'agent_trade_limit',
      detail: 'Momentum Scout is limited to $50.00 a trade, and this one was $100.00.',
    });
    expect(chooseSettlement).not.toHaveBeenCalled();
    expect(h.statements.some((s) => /INSERT INTO proposals/.test(s.text))).toBe(false);
  });

  it("count what the agent's strategies already placed today against its daily limit", async () => {
    h.limits = { maxUsdPerDay: 150 };
    h.spent = '80';
    const out = await runStrategy(strategy(), at);
    expect(out).toMatchObject({ status: 'blocked', reason: 'agent_daily_limit' });
    const spend = h.statements.find((s) => /s\.agent_id = \$1/.test(s.text))!;
    expect(spend.params).toEqual(['agent-1']);
    expect(spend.text).toMatch(/r\.side = 'buy'/);
    expect(spend.text).toMatch(/s\.chain = current_setting\('xorr\.chain_key'\)/);
  });

  it('let a trade inside both carry on to settlement', async () => {
    h.limits = { maxUsdPerTrade: 200, maxUsdPerDay: 500 };
    h.spent = '100';
    await runStrategy(strategy(), at);
    expect(chooseSettlement).toHaveBeenCalledTimes(1);
  });

  it('never hold back a close, which only reduces risk', async () => {
    vi.mocked(PLANNERS.momentum!).mockResolvedValue(close);
    h.limits = { maxUsdPerTrade: 1 };
    await runStrategy(strategy(), at);
    expect(agentLookups()).toHaveLength(0);
    expect(chooseSettlement).toHaveBeenCalledTimes(1);
  });

  it('are not looked up for a strategy no agent runs', async () => {
    await runStrategy(strategy({ agent_id: null }), at);
    expect(agentLookups()).toHaveLength(0);
    expect(chooseSettlement).toHaveBeenCalledTimes(1);
  });
});
