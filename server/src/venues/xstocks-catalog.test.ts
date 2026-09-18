/**
 * The catalog, with the pool price stood in for.
 *
 * What is pinned here is the thing the whole feature turns on: a token nothing will price produces a
 * ROW with `price: null` and `feed: 'unavailable'`, never a number and never a hole in the list. And
 * the fields X Layer has no source for — the exchange mark, the 24h change, the pool depth — are
 * null on every row, not a borrowed or invented figure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.XORR_CHAIN = 'xlayer-testnet';
  return { xStockPriceUsd: vi.fn() };
});

vi.mock('./xstocks.js', async (orig) => ({
  ...(await orig<typeof import('./xstocks.js')>()),
  xStockPriceUsd: h.xStockPriceUsd,
}));
vi.mock('../db/index.js', () => ({ query: vi.fn(async () => []) }));

const LIVE: Record<string, number> = { NVDAx: 181.62, TSLAx: 362.9 };

beforeEach(() => {
  h.xStockPriceUsd.mockReset().mockImplementation(async (s: string) => LIVE[s] ?? null);
});

afterEach(() => vi.resetModules());

describe('a priced token', () => {
  it('carries the pool price, and no mark X Layer does not publish', async () => {
    const { xStockCatalog } = await import('./xstocks-catalog.js');
    const nvda = (await xStockCatalog()).find((r) => r.symbol === 'NVDAx')!;

    expect(nvda.price).toBe(181.62);
    expect(nvda.feed).toBe('live');
    expect(nvda.ticker).toBe('NVDA');
    expect(nvda.address).toBe('0xa8ddb5cd96b5222afe198316e9a57caa642850d5');
    // Null, not the pool price copied across: the two would be different claims.
    expect(nvda.underlyingPrice).toBeNull();
    expect(nvda.underlyingAt).toBeNull();
    expect(nvda.change24hPct).toBeNull();
    expect(nvda.liquidityUsd).toBeNull();
  });

  it('prices every token in the catalog, one quote each', async () => {
    const { xStockCatalog } = await import('./xstocks-catalog.js');
    const { XSTOCKS } = await import('./xstocks.js');

    await xStockCatalog();
    const asked = h.xStockPriceUsd.mock.calls.map((c) => c[0]).sort();
    expect(asked).toEqual(Object.keys(XSTOCKS).sort());
  });
});

describe('a token nothing will price', () => {
  it('is a row saying so, not a missing row and not a number', async () => {
    const { xStockCatalog } = await import('./xstocks-catalog.js');
    const { XSTOCKS } = await import('./xstocks.js');

    const rows = await xStockCatalog();
    expect(rows).toHaveLength(Object.keys(XSTOCKS).length);
    const aapl = rows.find((r) => r.symbol === 'AAPLx')!;
    expect(aapl.price).toBeNull();
    expect(aapl.feed).toBe('unavailable');
    // The parts that are facts about the listing, not observations, survive.
    expect(aapl.name).toBe('Apple Inc.');
    expect(aapl.sector).toBe('Technology');
  });

  it('refuses a zero or a non-number', async () => {
    h.xStockPriceUsd.mockImplementation(async (s: string) => (s === 'NVDAx' ? 0 : s === 'TSLAx' ? Number.NaN : null));
    const { xStockCatalog } = await import('./xstocks-catalog.js');

    const rows = await xStockCatalog();
    expect(rows.find((r) => r.symbol === 'NVDAx')!.price).toBeNull();
    expect(rows.find((r) => r.symbol === 'NVDAx')!.feed).toBe('unavailable');
    expect(rows.find((r) => r.symbol === 'TSLAx')!.price).toBeNull();
  });

  it('turns a failed read into that row’s null, not the catalog’s error', async () => {
    h.xStockPriceUsd.mockImplementation(async (s: string) => {
      if (s === 'NVDAx') throw new Error('ETIMEDOUT');
      return LIVE[s] ?? null;
    });
    const { xStockCatalog } = await import('./xstocks-catalog.js');

    const rows = await xStockCatalog();
    expect(rows.find((r) => r.symbol === 'NVDAx')!.feed).toBe('unavailable');
    expect(rows.find((r) => r.symbol === 'TSLAx')!.price).toBe(362.9);
  });

  it('shows every row as unpriced when nothing answers', async () => {
    h.xStockPriceUsd.mockResolvedValue(null);
    const { xStockCatalog } = await import('./xstocks-catalog.js');

    const rows = await xStockCatalog();
    expect(rows.every((r) => r.price === null && r.feed === 'unavailable')).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('the sector filter', () => {
  it('offers every sector the catalog actually uses', async () => {
    const { xStockSectors } = await import('./xstocks-catalog.js');
    const { XSTOCKS } = await import('./xstocks.js');

    const offered = xStockSectors();
    for (const t of Object.values(XSTOCKS)) expect(offered).toContain(t.sector);
    expect(new Set(offered).size).toBe(offered.length);
  });

  it('puts the not-a-sector bucket last', async () => {
    const { xStockSectors } = await import('./xstocks-catalog.js');
    expect(xStockSectors().at(-1)).toBe('Index funds');
  });
});
