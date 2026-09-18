/**
 * The catalog, with the price endpoint stood in for.
 *
 * What is pinned here is the thing the whole feature turns on: a mint nothing will price produces a
 * ROW with `price: null` and `feed: 'unavailable'`, never a number and never a hole in the list. The
 * shape of the upstream payload is real — taken from a live `lite-api.jup.ag/price/v3` response, with
 * its `stockData` block and its 24h change — because a fixture that invented the shape would prove
 * only that this file agrees with itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getJson: vi.fn(), staleValue: vi.fn() }));

vi.mock('../http/get.js', () => ({ getJson: h.getJson, staleValue: h.staleValue }));

const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';

/** Two entries exactly as the endpoint returns them. */
const LIVE = {
  [NVDAX]: {
    usdPrice: 215.9225991175978,
    blockId: 447735731,
    decimals: 8,
    priceChange24h: 1.0786600564316768,
    liquidity: 1885148.375969128,
    stockData: { id: 'xstocks', price: 215.68, updatedAt: '2026-09-17T07:16:34.333Z' },
  },
  [TSLAX]: {
    usdPrice: 363.1929098278067,
    blockId: 447736227,
    decimals: 8,
    priceChange24h: 1.49637016682163,
    liquidity: 1251139.863591303,
    stockData: { id: 'xstocks', price: 359.9352, updatedAt: '2026-09-17T07:16:51.061Z' },
  },
};

beforeEach(() => {
  h.getJson.mockReset();
  h.staleValue.mockReset().mockReturnValue(undefined);
});

afterEach(() => vi.resetModules());

describe('a priced mint', () => {
  it('carries the pool price and the issuer mark as separate numbers', async () => {
    h.getJson.mockResolvedValue(LIVE);
    const { xStockCatalog } = await import('./xstocks-catalog.js');

    const rows = await xStockCatalog();
    const nvda = rows.find((r) => r.symbol === 'NVDAx')!;

    // The two are near each other and are not the same number — which is the spread a buyer pays,
    // and the reason the row does not collapse them into one "price".
    expect(nvda.price).toBeCloseTo(215.9226, 4);
    expect(nvda.underlyingPrice).toBeCloseTo(215.68, 4);
    expect(nvda.price).not.toBe(nvda.underlyingPrice);
    expect(nvda.change24hPct).toBeCloseTo(1.0787, 4);
    expect(nvda.liquidityUsd).toBeCloseTo(1885148.376, 3);
    expect(nvda.underlyingAt).toBe('2026-09-17T07:16:34.333Z');
    expect(nvda.feed).toBe('live');
  });

  it('asks for every mint in one request', async () => {
    h.getJson.mockResolvedValue(LIVE);
    const { xStockCatalog } = await import('./xstocks-catalog.js');
    const { XSTOCKS } = await import('./xstocks.js');

    await xStockCatalog();

    // Eleven probes behind a shared rate limit is how a browsable list becomes a spinner.
    expect(h.getJson).toHaveBeenCalledTimes(1);
    const url = String(h.getJson.mock.calls[0]![0]);
    for (const t of Object.values(XSTOCKS)) expect(url).toContain(t.address);
  });
});

describe('a mint nothing will price', () => {
  it('is a row saying so, not a missing row and not a number', async () => {
    h.getJson.mockResolvedValue(LIVE);
    const { xStockCatalog } = await import('./xstocks-catalog.js');
    const { XSTOCKS } = await import('./xstocks.js');

    const rows = await xStockCatalog();

    // Every catalogued mint is present whether or not the feed knew it.
    expect(rows).toHaveLength(Object.keys(XSTOCKS).length);
    const aapl = rows.find((r) => r.symbol === 'AAPLx')!;
    expect(aapl.price).toBeNull();
    expect(aapl.underlyingPrice).toBeNull();
    expect(aapl.feed).toBe('unavailable');
    // The parts that are facts about the listing, not observations, survive the outage.
    expect(aapl.name).toBe('Apple Inc. xStock');
    expect(aapl.sector).toBe('Technology');
  });

  it('refuses a zero or a non-number the feed may report', async () => {
    h.getJson.mockResolvedValue({
      [NVDAX]: { usdPrice: 0, stockData: { price: 215.68 } },
      [TSLAX]: { usdPrice: 'oops', priceChange24h: null },
    });
    const { xStockCatalog } = await import('./xstocks-catalog.js');

    const rows = await xStockCatalog();

    // A zero price is not a price. Carried through, it would render as "$0.00" — a number a reader
    // has no way to tell from a real one.
    expect(rows.find((r) => r.symbol === 'NVDAx')!.price).toBeNull();
    expect(rows.find((r) => r.symbol === 'NVDAx')!.feed).toBe('unavailable');
    expect(rows.find((r) => r.symbol === 'TSLAx')!.price).toBeNull();
    expect(rows.find((r) => r.symbol === 'TSLAx')!.change24hPct).toBeNull();
  });

  it('keeps a zero 24h change, which is a real reading', async () => {
    h.getJson.mockResolvedValue({ [NVDAX]: { usdPrice: 215.92, priceChange24h: 0 } });
    const { xStockCatalog } = await import('./xstocks-catalog.js');

    // "did not move" and "not reported" are different facts and the row keeps them apart.
    expect((await xStockCatalog()).find((r) => r.symbol === 'NVDAx')!.change24hPct).toBe(0);
  });
});

describe('when the endpoint is unreachable', () => {
  it('serves the last good answer while it is recent enough to mean something', async () => {
    h.getJson.mockRejectedValue(new Error('ETIMEDOUT'));
    h.staleValue.mockReturnValue(LIVE);
    const { xStockCatalog } = await import('./xstocks-catalog.js');

    expect((await xStockCatalog()).find((r) => r.symbol === 'NVDAx')!.price).toBeCloseTo(215.9226, 4);
  });

  it('and shows every row as unpriced once it is not', async () => {
    h.getJson.mockRejectedValue(new Error('ETIMEDOUT'));
    h.staleValue.mockReturnValue(undefined);
    const { xStockCatalog } = await import('./xstocks-catalog.js');

    const rows = await xStockCatalog();
    expect(rows.every((r) => r.price === null && r.feed === 'unavailable')).toBe(true);
    // Still a full catalog: the names and sectors are not market data and did not go anywhere.
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

    // SPYx and QQQx span every sector on the list; filing them under one would be a false claim
    // about their holdings, so they get a bucket of their own and it reads wrong anywhere but last.
    expect(xStockSectors().at(-1)).toBe('Index funds');
  });
});
