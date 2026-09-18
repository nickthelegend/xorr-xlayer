/**
 * The book, held to what the wallet actually has (PLAN.md 2.7).
 *
 * The ledger is what the executor recorded and the chain is what the wallet holds. On the rebuilt fork
 * the owner's ledger still carried 0.8026 WETH that no longer existed, and the Portfolio listed it.
 * These drive the real `listPositions` and `getPosition` with the database, the price feed and the
 * balance read replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  one: undefined as Record<string, unknown> | undefined,
}));

vi.mock('../db/index.js', () => ({
  query: vi.fn(async () => h.rows),
  one: vi.fn(async () => h.one),
}));
vi.mock('../market/prices.js', () => ({ priceOf: vi.fn(async () => 2_500) }));
vi.mock('../evm/balances.js', () => ({ chainUnitsOf: vi.fn() }));

const { chainUnitsOf } = await import('../evm/balances.js');
const { listPositions, getPosition } = await import('./index.js');

const WALLET = { id: 'wallet-1', address: '0x95A0b368588713011a15f4b1041423f31B08e615' };
const row = (units: string, cost: string, over: Record<string, unknown> = {}) => ({
  id: 'p1',
  wallet_id: 'wallet-1',
  symbol: 'WETH',
  side: 'long',
  leverage: '1',
  units,
  cost_usd: cost,
  realised_usd: '0',
  units_sold: '0',
  ...over,
});
const holds = (symbol: string, units: number | null) =>
  vi.mocked(chainUnitsOf).mockResolvedValue(new Map<string, number | null>([[symbol, units]]));

beforeEach(() => {
  h.rows = [];
  h.one = undefined;
  vi.mocked(chainUnitsOf).mockReset();
});

describe('a ledger that records more than the wallet holds', () => {
  it('lists what the chain holds, and says by how much the ledger is over', async () => {
    h.rows = [row('0.802587', '2000')];
    holds('WETH', 0);
    const [p] = await listPositions(WALLET);
    expect(p).toMatchObject({ units: 0, ledgerUnits: 0.802587, chainUnits: 0, driftUnits: 0.802587, notional: 0, unrealised: 0 });
    // The entry is what was paid, not what the missing units would make it.
    expect(p!.entry).toBeCloseTo(2000 / 0.802587, 6);
  });

  it('a partial shortfall values only what is held, at the price paid', async () => {
    h.rows = [row('1', '2000')];
    holds('WETH', 0.4);
    const [p] = await listPositions(WALLET);
    // 0.4 held of 1 recorded: cost scales to $800, worth 0.4 × $2,500 = $1,000.
    expect(p).toMatchObject({ units: 0.4, driftUnits: 0.6, entry: 2000, margin: 800, notional: 1000, unrealised: 200 });
    expect(p!.unrealisedPct).toBeCloseTo(25, 6);
  });
});

describe('what is not capped', () => {
  it('a wallet holding more than the ledger — funded outside the app — lists the ledger, with the difference', async () => {
    h.rows = [row('0.5', '1000')];
    holds('WETH', 0.7);
    const [p] = await listPositions(WALLET);
    expect(p).toMatchObject({ units: 0.5, chainUnits: 0.7, driftUnits: -0.2 });
  });

  it('a token this chain cannot be asked about is listed as recorded, unchecked', async () => {
    h.rows = [row('2', '360', { symbol: 'NVDAc' })];
    holds('NVDAc', null);
    const [p] = await listPositions(WALLET);
    expect(p).toMatchObject({ symbol: 'NVDAc', units: 2, chainUnits: null, driftUnits: null });
  });

  it('a short is not something a balance can confirm', async () => {
    h.rows = [row('0.5', '1000', { side: 'short' })];
    holds('WETH', 0);
    const [p] = await listPositions(WALLET);
    expect(p).toMatchObject({ units: 0.5, chainUnits: null, driftUnits: null });
  });
});

describe('a balance read that fails', () => {
  it('is a 502, never an empty or unchecked book', async () => {
    h.rows = [row('0.5', '1000')];
    vi.mocked(chainUnitsOf).mockRejectedValue(new Error('rpc timeout'));
    await expect(listPositions(WALLET)).rejects.toMatchObject({ status: 502 });
  });
});

describe('one position', () => {
  it('is held to the chain the same way', async () => {
    h.one = row('0.802587', '2000');
    holds('WETH', 0);
    expect(await getPosition(WALLET, 'p1')).toMatchObject({ units: 0, ledgerUnits: 0.802587, driftUnits: 0.802587 });
  });
});
