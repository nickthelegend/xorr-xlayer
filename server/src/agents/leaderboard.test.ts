/**
 * The leaderboard's credit and its speed (PLAN.md 2.2).
 *
 * Runs were credited by searching the wallet's audit log for each run's id inside JSON, and priced
 * one symbol after another. These drive the real `leaderboard` with the database and the price feed
 * replaced by recorders.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], sql: [] as string[] }));

vi.mock('../db/index.js', () => ({
  query: vi.fn(async (text: string) => {
    h.sql.push(text);
    return h.rows;
  }),
}));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn() }));

const { priceOf } = await import('../market/prices.js');
const { leaderboard } = await import('./leaderboard.js');

const run = (over: Record<string, unknown>) => ({
  kind: 'dca',
  persona_id: null,
  placed_by: null,
  symbol: 'WETH',
  usd: '100',
  units: '0.05',
  price: '2000',
  ...over,
});

const entry = (board: Awaited<ReturnType<typeof leaderboard>>, id: string) => board.find((b) => b.id === id)!;

beforeEach(() => {
  h.rows = [];
  h.sql.length = 0;
  vi.mocked(priceOf).mockReset();
});

describe('credit', () => {
  it('goes to the agent that owns the strategy, else to the persona that runs its kind', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_500);
    h.rows = [
      run({ kind: 'dca', persona_id: 'earnings-desk' }),
      run({ kind: 'momentum' }),
      run({ kind: 'exit-rules', units: '0.01' }),
    ];
    const board = await leaderboard('wallet-1');
    // 0.05 × 2,500 − 100 = +25 each; 0.01 × 2,500 − 100 = −75.
    expect(entry(board, 'earnings-desk')).toMatchObject({ trades: 1, pnl30d: 25, win: 100 });
    expect(entry(board, 'momentum-scout')).toMatchObject({ trades: 1, pnl30d: 25 });
    expect(entry(board, 'drawdown-guard')).toMatchObject({ trades: 1, pnl30d: -75, win: 0, metric: '0% win rate' });
  });

  /*
   * An agent's own order is a one-shot `buy`, which no persona runs by kind, and before `agent_id` was written the
   * only record of who placed it was `placedBy` in the strategy's params — the same name the activity row shows as
   * "Placed by …". Reading the agent row first and that name second is how a board built from real fills credits the
   * eighteen that were already there, instead of showing every agent "No trades yet" (2026-09-20).
   */
  it('goes to the agent the trail named when the strategy carries no agent row', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_500);
    h.rows = [run({ kind: 'buy', placed_by: 'Momentum Scout' }), run({ kind: 'buy', placed_by: 'Earnings Desk', units: '0.01' })];
    const board = await leaderboard('wallet-1');
    expect(entry(board, 'momentum-scout')).toMatchObject({ trades: 1, pnl30d: 25, win: 100 });
    expect(entry(board, 'earnings-desk')).toMatchObject({ trades: 1, pnl30d: -75, win: 0 });
  });

  it('prefers the agent row over the recorded name when both are there', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_500);
    h.rows = [run({ kind: 'buy', persona_id: 'yield-keeper', placed_by: 'Momentum Scout' })];
    const board = await leaderboard('wallet-1');
    expect(entry(board, 'yield-keeper').trades).toBe(1);
    expect(entry(board, 'momentum-scout').trades).toBe(0);
  });

  it('credits nobody for a name that is no persona', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_500);
    h.rows = [run({ kind: 'buy', placed_by: 'xorr' }), run({ kind: 'buy', placed_by: 'Somebody Else' })];
    const board = await leaderboard('wallet-1');
    expect(board.every((b) => b.trades === 0)).toBe(true);
  });

  it('a run no persona ran is on nobody’s record — not Yield Keeper’s', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_500);
    h.rows = [run({ kind: 'dca' }), run({ kind: 'rebalance' })];
    const board = await leaderboard('wallet-1');
    expect(board.every((b) => b.trades === 0)).toBe(true);
    expect(entry(board, 'yield-keeper').metric).toBe('No trades yet');
  });

  it('is found with a join, not by searching the audit log', async () => {
    await leaderboard('wallet-1');
    expect(h.sql[0]).not.toMatch(/audit_log/);
    expect(h.sql[0]).toMatch(/LEFT JOIN agents/);
  });
});

describe('pricing', () => {
  it('asks once per symbol, all at once, and leaves out what it cannot price', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(priceOf).mockImplementation(async (symbol: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      if (symbol === 'NOFEED') throw new Error('No price feed for NOFEED');
      return symbol === 'WETH' ? 2_500 : 60_000;
    });
    h.rows = [
      run({ kind: 'momentum', symbol: 'WETH' }),
      run({ kind: 'momentum', symbol: 'WETH' }),
      run({ kind: 'momentum', symbol: 'cbBTC', units: '0.002' }),
      run({ kind: 'momentum', symbol: 'NOFEED' }),
    ];
    const board = await leaderboard('wallet-1');
    expect(vi.mocked(priceOf).mock.calls.map((c) => c[0]).sort()).toEqual(['NOFEED', 'WETH', 'cbBTC']);
    expect(peak).toBe(3);
    // 25 + 25 + (0.002 × 60,000 − 100 = 20); the unpriced run is not counted at all.
    expect(entry(board, 'momentum-scout')).toMatchObject({ trades: 3, pnl30d: 70 });
  });
});
