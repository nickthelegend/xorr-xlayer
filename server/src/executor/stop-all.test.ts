/**
 * The stop-all the executor enforces (PLAN.md 2.14).
 *
 * "Stop all agents" was a revoke, or a flag in one browser that the executor never saw. Every run now reads
 * the wallet's stop with its address and hands it to the rules, before anything is planned or sent. These
 * drive the real `runStrategy` with the rules replaced by a recorder that refuses the way the real engine does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ stopped: false as boolean | undefined }));

vi.mock('../db/index.js', () => {
  const client = {
    query: async (text: string) => ({ rows: /INSERT INTO strategy_runs/.test(text) ? [{ id: 'run-1' }] : [] }),
  };
  return {
    tx: async (fn: (c: typeof client) => Promise<unknown>) => fn(client),
    query: async () => [],
    one: async (text: string) =>
      /FROM wallets/.test(text)
        ? { address: '0x95A0b368588713011a15f4b1041423f31B08e615', agents_stopped: h.stopped }
        : undefined,
  };
});
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => undefined) }));
vi.mock('../notifications/push.js', () => ({ send: vi.fn(async () => ({ sent: 0, skipped: 0, errors: [] })) }));
vi.mock('../rules/engine.js', () => ({
  evaluate: vi.fn(async (ctx: { killed?: boolean }) =>
    ctx.killed
      ? { allowed: false, reason: 'agents_stopped', detail: 'You stopped the agents. Nothing will be placed until you resume.' }
      : { allowed: true, spentTodayUsd: 0, remainingUsd: 2_000 },
  ),
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
vi.mock('./kinds/index.js', () => ({ PLANNERS: { dca: vi.fn() }, observationFor: vi.fn(async () => null) }));

const { evaluate } = await import('../rules/engine.js');
const { chooseSettlement } = await import('./settle.js');
const { PLANNERS } = await import('./kinds/index.js');
const { runStrategy } = await import('./run.js');
type StrategyRow = import('./run.js').StrategyRow;

const at = new Date('2026-09-13T09:00:00Z');
const strategy = {
  id: 'strategy-1',
  wallet_id: 'wallet-1',
  kind: 'dca',
  state: 'live',
  label: 'Weekly WETH',
  symbol: 'WETH',
  params: { usd: 25 },
  cadence: 'weekly',
  next_run_at: new Date(at.getTime() - 60_000),
  daily_allocation_usd: '25',
  retry_attempts: 0,
} as StrategyRow;

beforeEach(() => {
  vi.mocked(evaluate).mockClear();
  vi.mocked(chooseSettlement).mockClear();
  vi.mocked(PLANNERS.dca!).mockReset();
  vi.mocked(PLANNERS.dca!).mockResolvedValue({ inSymbol: 'USDC', outSymbol: 'WETH', amountIn: 25, usd: 25, because: 'The weekly buy.' });
});

describe('a wallet whose agents are stopped', () => {
  it('has its run refused by the rules, with nothing planned and nothing sent', async () => {
    h.stopped = true;
    const out = await runStrategy(strategy, at);
    expect(out).toMatchObject({ status: 'blocked', reason: 'agents_stopped' });
    expect(vi.mocked(evaluate).mock.calls[0]![0]).toMatchObject({ killed: true });
    expect(PLANNERS.dca).not.toHaveBeenCalled();
    expect(chooseSettlement).not.toHaveBeenCalled();
  });
});

describe('a wallet that has not stopped', () => {
  it('runs as before — including one whose database has not yet added the column', async () => {
    for (const stopped of [false, undefined]) {
      vi.mocked(evaluate).mockClear();
      h.stopped = stopped;
      await runStrategy(strategy, at);
      expect(vi.mocked(evaluate).mock.calls[0]![0]).toMatchObject({ killed: false });
    }
    expect(chooseSettlement).toHaveBeenCalled();
  });
});
