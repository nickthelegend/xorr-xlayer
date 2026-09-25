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
      if (/FROM wallets/.test(text)) return { address: '0x95A0b368588713011a15f4b1041423f31B08e615', name: 'Momentum Scout' };
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
  // A budget on chain larger than anything these tests place, unless a test says otherwise.
  readAgentBudget: vi.fn(async () => 1_000_000),
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
vi.mock('./kinds/index.js', () => ({
  PLANNERS: { momentum: vi.fn(), 'exit-rules': vi.fn(), dca: vi.fn() },
  observationFor: vi.fn(async () => null),
}));

const { chooseSettlement } = await import('./settle.js');
const { PLANNERS } = await import('./kinds/index.js');
const { runStrategy } = await import('./run.js');
const { readAgentBudget } = await import('../evm/delegation.js');
const { agentKey } = await import('../evm/agentKey.js');
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

// The limits' own read — the run also looks the agent's name up, for the trail, which is not a limit.
const agentLookups = () => h.statements.filter((s) => /risk_limits FROM agents/.test(s.text));

beforeEach(() => {
  h.statements.length = 0;
  h.limits = {};
  h.spent = '0';
  vi.mocked(chooseSettlement).mockClear();
  vi.mocked(readAgentBudget).mockReset().mockResolvedValue(1_000_000);
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

  /*
   * The agent's own budget, on chain (2026-09-25): read for the agent's own key, and a trade past it refused in a
   * sentence before anything is proposed or sent — the contract would refuse it anyway (`AgentBudgetExceeded`).
   */
  it('refuse an entry past what the agent has left of its budget on chain', async () => {
    vi.mocked(readAgentBudget).mockResolvedValue(40);
    const out = await runStrategy(strategy(), at);
    expect(out).toMatchObject({
      status: 'blocked',
      reason: 'agent_budget',
      detail: 'Momentum Scout has $40.00 of its budget left on chain, and this asks for $100.00.',
    });
    expect(vi.mocked(readAgentBudget).mock.calls[0]![1]).toBe(agentKey('agent-1'));
    expect(chooseSettlement).not.toHaveBeenCalled();
  });

  /*
   * An agent with nothing in its budget waits rather than spending the period (2026-09-25): a made agent's strategies are
   * live before its owner gives it a budget, and a refusal would have used up the week — "Run now" then did nothing.
   */
  it('wait, without claiming the period, while the agent has no budget at all', async () => {
    vi.mocked(readAgentBudget).mockResolvedValue(0);
    const out = await runStrategy(strategy(), at);
    expect(out).toMatchObject({
      status: 'skipped',
      reason: 'awaiting_budget',
      detail: 'Momentum Scout has no budget on chain yet, so "WETH breakout" waits. Give it one on its page, and it runs.',
    });
    expect(h.statements.some((st) => /INSERT INTO strategy_runs/.test(st.text))).toBe(false);
    expect(chooseSettlement).not.toHaveBeenCalled();
  });

  it('claim and run as soon as the budget is there', async () => {
    vi.mocked(readAgentBudget).mockResolvedValue(0);
    await runStrategy(strategy(), at);
    vi.mocked(readAgentBudget).mockResolvedValue(500);
    await runStrategy(strategy(), at);
    expect(h.statements.some((st) => /INSERT INTO strategy_runs/.test(st.text))).toBe(true);
    expect(chooseSettlement).toHaveBeenCalledTimes(1);
  });

  it('refuse when the budget cannot be read: an unchecked budget is not a budget', async () => {
    vi.mocked(readAgentBudget).mockRejectedValue(new Error('rpc down'));
    const out = await runStrategy(strategy(), at);
    expect(out).toMatchObject({ status: 'blocked', reason: 'agent_budget_unread' });
    expect(chooseSettlement).not.toHaveBeenCalled();
  });

  it("settle an agent's trade as the agent's", async () => {
    await runStrategy(strategy(), at);
    expect(vi.mocked(chooseSettlement).mock.calls[0]![0]).toMatchObject({ agent: agentKey('agent-1') });
  });

  it('refuse an entry even half a cent past the budget, compared in the units the contract counts', async () => {
    vi.mocked(readAgentBudget).mockResolvedValue(99.996);
    const out = await runStrategy(strategy(), at);
    expect(out).toMatchObject({ status: 'blocked', reason: 'agent_budget' });
    expect(chooseSettlement).not.toHaveBeenCalled();
  });

  it('let an entry of exactly the budget through', async () => {
    vi.mocked(readAgentBudget).mockResolvedValue(100);
    await runStrategy(strategy(), at);
    expect(chooseSettlement).toHaveBeenCalledTimes(1);
  });

  /*
   * A sale is credited to an agent only when it sells that agent's own lot (2026-09-25) — its exit, armed with the units
   * its buy filled. Anything else an agent's strategy sells settles as the owner's close, so no budget grows by the
   * proceeds of shares it did not pay for.
   */
  it("settle an agent's exit of its own lot as the agent's, so the sale credits its budget", async () => {
    vi.mocked(PLANNERS['exit-rules']!).mockResolvedValue(close);
    await runStrategy(strategy({ kind: 'exit-rules', params: { lotUnits: 0.04 } as never }), at);
    expect(vi.mocked(chooseSettlement).mock.calls[0]![0]).toMatchObject({ agent: agentKey('agent-1') });
  });

  it("settle any other sale by an agent's strategy as the owner's, crediting nobody", async () => {
    vi.mocked(PLANNERS.momentum!).mockResolvedValue(close);
    await runStrategy(strategy(), at);
    expect(vi.mocked(chooseSettlement).mock.calls[0]![0]).toMatchObject({ agent: undefined });

    vi.mocked(chooseSettlement).mockClear();
    vi.mocked(PLANNERS['exit-rules']!).mockResolvedValue(close);
    await runStrategy(strategy({ id: 'strategy-2', kind: 'exit-rules', params: {} as never }), at);
    expect(vi.mocked(chooseSettlement).mock.calls[0]![0]).toMatchObject({ agent: undefined });
  });

  /*
   * A made agent's weekly buy is that agent's in the trail (2026-09-25). `dca` belongs to no persona, so its rows read
   * "xorr" — the system — and the phone's banner for an agent's own first trade named nobody.
   */
  it("write an agent's strategy under the agent's own name in the trail", async () => {
    const { append } = await import('../audit/log.js');
    vi.mocked(PLANNERS.dca!).mockResolvedValue(entry);
    vi.mocked(append).mockClear();
    await runStrategy(strategy({ id: 'strategy-dca', kind: 'dca' }), at);
    expect(vi.mocked(append).mock.calls.at(-1)![0]).toMatchObject({ agent: 'Momentum Scout' });

    vi.mocked(append).mockClear();
    await runStrategy(strategy({ id: 'strategy-mine', kind: 'dca', agent_id: null }), at);
    expect(vi.mocked(append).mock.calls.at(-1)![0]).toMatchObject({ agent: 'xorr' });
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
