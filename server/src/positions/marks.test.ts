/**
 * The book, valued (PLAN.md 2.3).
 *
 * `listPositions` priced a row at a time with no deadline, and `getPosition` priced the whole book to
 * keep one entry. These drive the real functions with the database and the price feed replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  one: undefined as Record<string, unknown> | undefined,
  sql: [] as { fn: string; text: string; params: unknown[] }[],
}));

vi.mock('../db/index.js', () => ({
  query: vi.fn(async (text: string, params: unknown[] = []) => {
    h.sql.push({ fn: 'query', text, params });
    return h.rows;
  }),
  one: vi.fn(async (text: string, params: unknown[] = []) => {
    h.sql.push({ fn: 'one', text, params });
    return h.one;
  }),
}));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn() }));
vi.mock('../evm/balances.js', () => ({ chainUnitsOf: vi.fn() }));

const { priceOf } = await import('../market/prices.js');
const { chainUnitsOf } = await import('../evm/balances.js');
const { listPositions, getPosition } = await import('./index.js');

const WALLET = { id: 'wallet-1', address: '0x95A0b368588713011a15f4b1041423f31B08e615' };

const position = (over: Record<string, unknown>) => ({
  id: 'p1',
  wallet_id: 'wallet-1',
  symbol: 'WETH',
  side: 'long',
  leverage: '1',
  units: '0.1',
  cost_usd: '200',
  realised_usd: '0',
  units_sold: '0',
  ...over,
});

beforeEach(() => {
  h.rows = [];
  h.one = undefined;
  h.sql.length = 0;
  vi.mocked(priceOf).mockReset();
  // Unchecked against the chain unless a test says otherwise: these are about pricing (see drift.test.ts).
  vi.mocked(chainUnitsOf).mockReset();
  vi.mocked(chainUnitsOf).mockImplementation(async (_owner, symbols) => new Map<string, number | null>(symbols.map((s) => [s, null])));
});

describe('the book', () => {
  it('prices each symbol once, all at once, with a deadline', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(priceOf).mockImplementation(async (symbol: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return symbol === 'WETH' ? 2_500 : 60_000;
    });
    h.rows = [
      position({ id: 'p1' }),
      position({ id: 'p2', symbol: 'cbBTC', units: '0.002', cost_usd: '100' }),
      position({ id: 'p3', side: 'short' }),
    ];

    const book = await listPositions(WALLET);
    expect(vi.mocked(priceOf)).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);
    for (const call of vi.mocked(priceOf).mock.calls) expect(typeof call[1]).toBe('number');
    expect(book.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(book[0]).toMatchObject({ mark: 2_500, notional: 250, unrealised: 50, feed: 'live', entry: 2_000 });
    expect(book[1]).toMatchObject({ mark: 60_000, notional: 120, unrealised: 20, feed: 'live' });
  });

  it('a symbol it cannot price reads unavailable, and the rest are still valued', async () => {
    vi.mocked(priceOf).mockImplementation(async (symbol: string) => {
      if (symbol === 'NVDAc') throw new Error('No route for NVDAc right now');
      return 2_500;
    });
    h.rows = [position({ id: 'p1' }), position({ id: 'p9', symbol: 'NVDAc', units: '2', cost_usd: '360' })];

    const [weth, nvda] = await listPositions(WALLET);
    expect(weth).toMatchObject({ feed: 'live', unrealised: 50 });
    expect(nvda).toMatchObject({ feed: 'unavailable', mark: 0, notional: 0, unrealised: 0, unrealisedPct: 0 });
  });
});

describe('one position', () => {
  it('reads that row alone and prices only its symbol', async () => {
    vi.mocked(priceOf).mockResolvedValue(60_000);
    h.one = position({ id: 'p2', symbol: 'cbBTC', units: '0.002', cost_usd: '100' });

    const p = await getPosition(WALLET, 'p2');
    expect(p).toMatchObject({ id: 'p2', symbol: 'cbBTC', mark: 60_000, unrealised: 20 });
    expect(h.sql).toHaveLength(1);
    expect(h.sql[0]).toMatchObject({ fn: 'one', params: ['wallet-1', 'p2'] });
    expect(vi.mocked(priceOf).mock.calls.map((c) => c[0])).toEqual(['cbBTC']);
  });

  it('an id not in this book is null, and nothing is priced', async () => {
    expect(await getPosition(WALLET, 'someone-elses')).toBeNull();
    expect(priceOf).not.toHaveBeenCalled();
  });
});
