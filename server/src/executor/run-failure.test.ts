/**
 * What a run does when it cannot finish (PLAN.md 1.6).
 *
 * Three things were wrong and each is pinned here against the real `runStrategy`, with the database,
 * the chain and the trail replaced by recorders:
 *   - a throw between the claim and the send (the permission read) escaped with the run `pending`;
 *   - a transient failure was retried every tick and wrote a "Retrying" row every time;
 *   - a blocked or failed run never moved `next_run_at`, so the strategy stayed due forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  statements: [] as { text: string; params: unknown[] }[],
  owner: '0x95A0b368588713011a15f4b1041423f31B08e615',
  /** When true, the period is already claimed: the INSERT returns no row. */
  claimTaken: false,
  /** The status of the run that already holds the period. */
  existingStatus: 'blocked',
}));

const record = (text: string, params: unknown[] = []) => {
  h.statements.push({ text, params });
};

vi.mock('../db/index.js', () => {
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      record(text, params);
      return { rows: /INSERT INTO strategy_runs/.test(text) && !h.claimTaken ? [{ id: 'run-1' }] : [] };
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
      if (/FROM strategy_runs/.test(text)) return { status: h.existingStatus };
      return /FROM wallets/.test(text) ? { address: h.owner } : undefined;
    },
  };
});
vi.mock('../audit/log.js', () => ({ append: vi.fn(async () => ({ seq: '4821' })) }));
vi.mock('../notifications/push.js', () => ({ send: vi.fn(async () => undefined) }));
vi.mock('../rules/engine.js', () => ({ evaluate: vi.fn(), recordSpend: vi.fn() }));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn(async () => 2_500) }));
vi.mock('../evm/gas.js', () => ({ gasStatus: vi.fn(async () => ({ enough: true })) }));
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

const { append } = await import('../audit/log.js');
const { send } = await import('../notifications/push.js');
const { readPolicy } = await import('../evm/delegation.js');
const { runStrategy, retryDelayMs } = await import('./run.js');
type StrategyRow = import('./run.js').StrategyRow;

const DAY = 24 * 60 * 60_000;
const at = new Date('2026-09-13T09:00:00Z');

function strategy(overrides: Partial<StrategyRow> = {}): StrategyRow {
  return {
    id: 'strategy-1',
    wallet_id: 'wallet-1',
    kind: 'dca',
    state: 'live',
    label: 'Daily WETH',
    symbol: 'WETH',
    params: { usd: 10 },
    cadence: 'daily',
    next_run_at: new Date(at.getTime() - 60_000),
    daily_allocation_usd: '10',
    retry_attempts: 0,
    ...overrides,
  } as StrategyRow;
}

const statementsLike = (pattern: RegExp) => h.statements.filter((s) => pattern.test(s.text));
const actions = () => vi.mocked(append).mock.calls.map((c) => (c[0] as { action: string }).action);

beforeEach(() => {
  h.statements.length = 0;
  h.claimTaken = false;
  vi.mocked(append).mockClear();
  vi.mocked(append).mockResolvedValue({ seq: '4821' } as never);
  vi.mocked(send).mockClear();
  vi.mocked(readPolicy).mockReset();
});

describe('a transient failure before the chain', () => {
  it('releases the period, backs off from a due schedule, and tells the trail once', async () => {
    vi.mocked(readPolicy).mockRejectedValue(new Error('The request took too long to respond. timed out'));

    const first = await runStrategy(strategy(), at);
    expect(first.status).toBe('failed');
    expect(statementsLike(/DELETE FROM strategy_runs/)[0]?.params).toEqual(['run-1']);
    const backoff = statementsLike(/SET retry_attempts = retry_attempts \+ 1/)[0]!;
    expect(backoff.params).toEqual(['strategy-1', at, new Date(at.getTime() + 60_000)]);
    expect(actions()).toEqual(['Retrying Daily WETH']);

    // The second attempt in the streak waits twice as long and writes nothing new to the trail.
    h.statements.length = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runStrategy(strategy({ retry_attempts: 1 }), at);
    warn.mockRestore();
    expect(statementsLike(/SET retry_attempts = retry_attempts \+ 1/)[0]!.params[2]).toEqual(
      new Date(at.getTime() + 120_000),
    );
    expect(actions()).toEqual(['Retrying Daily WETH']);
  });

  it('waits one minute, doubling, and never more than thirty', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelayMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000,
    ]);
  });
});

describe('a permanent failure before the chain', () => {
  it('closes the run as failed, moves the schedule to the next period, and records it', async () => {
    vi.mocked(readPolicy).mockRejectedValue(new Error('execution reverted: NotDelegate()'));

    const out = await runStrategy(strategy(), at);
    expect(out.status).toBe('failed');
    expect(statementsLike(/DELETE FROM strategy_runs/)).toHaveLength(0);
    expect(statementsLike(/SET status='failed'/)[0]?.params[0]).toBe('run-1');
    expect(statementsLike(/SET next_run_at = \$2, retry_attempts = 0/)[0]?.params).toEqual([
      'strategy-1',
      new Date(at.getTime() + DAY),
    ]);
    expect(actions()).toEqual(['Could not run Daily WETH']);
  });
});

describe('a blocked run', () => {
  it('moves the schedule on instead of leaving the strategy due', async () => {
    vi.mocked(readPolicy).mockResolvedValue(null);
    const before = Date.now();

    const out = await runStrategy(strategy(), at);
    expect(out).toMatchObject({ status: 'blocked', reason: 'no_delegation' });
    const moved = statementsLike(/SET next_run_at = \$2, retry_attempts = 0/)[0]!;
    const next = (moved.params[1] as Date).getTime();
    expect(next).toBeGreaterThanOrEqual(before + DAY);
    expect(next).toBeLessThanOrEqual(Date.now() + DAY);
    expect(actions()).toEqual(['Skipped WETH']);
  });

  it('tells the phone which row to open, and which instrument it was about', async () => {
    vi.mocked(readPolicy).mockResolvedValue(null);

    await runStrategy(strategy(), at);

    /*
     * The push that most needs to land somewhere precise. It says a trade did not happen, and
     * "which one" is the first thing anyone reading it wants — `/activity` alone opens the top of
     * a log that may have a hundred rows in it, with the one it meant somewhere below.
     */
    expect(vi.mocked(send).mock.calls[0]?.[1]).toMatchObject({
      kind: 'strategy-blocked',
      route: '/activity',
      data: { seq: '4821', symbol: 'WETH' },
    });
  });

  it('still sends, and still settles the run, when the trail reported no row', async () => {
    // The id is for a notification. It is not part of the run, and reading it must never be able
    // to fail one that has already been decided.
    vi.mocked(readPolicy).mockResolvedValue(null);
    vi.mocked(append).mockResolvedValue(undefined as never);

    const out = await runStrategy(strategy(), at);

    expect(out).toMatchObject({ status: 'blocked', reason: 'no_delegation' });
    const sent = vi.mocked(send).mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(sent.data).toEqual({ symbol: 'WETH' });
    // Absent, not null and not an empty string: the app falls back to the list rather than
    // trying to open a row that does not exist.
    expect('seq' in (sent.data ?? {})).toBe(false);
  });
});

describe('a period that already has a run', () => {
  it('moves a schedule that is still due on, instead of re-selecting it every tick', async () => {
    h.claimTaken = true;
    h.existingStatus = 'blocked';

    const out = await runStrategy(strategy(), at);
    expect(out).toEqual({ status: 'skipped', reason: 'already_ran_this_period' });
    const moved = statementsLike(/UPDATE strategies SET next_run_at = \$2 WHERE id = \$1 AND next_run_at <= \$3/)[0];
    expect(moved?.params).toEqual(['strategy-1', new Date(at.getTime() + DAY), at]);
  });

  it('leaves the schedule alone while that run is still in flight', async () => {
    h.claimTaken = true;
    h.existingStatus = 'pending';

    await runStrategy(strategy(), at);
    expect(statementsLike(/UPDATE strategies SET next_run_at/)).toHaveLength(0);
  });

  it('leaves a schedule that is not yet due alone', async () => {
    h.claimTaken = true;
    h.existingStatus = 'filled';

    await runStrategy(strategy({ next_run_at: new Date(at.getTime() + 3_600_000) }), at);
    expect(statementsLike(/UPDATE strategies SET next_run_at/)).toHaveLength(0);
  });
});
