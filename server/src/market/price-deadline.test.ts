/**
 * A price a screen waits for is held to the screen's patience, and says so when it is late (`http/patience.ts`).
 *
 * `priceOf` raced its deadline against the CoinGecko fetch and rejected with a bare `price deadline for X`, so a balance
 * could not tell a late price from a missing feed and counted it as $0 — and an equity, priced by a 1inch quote, was not
 * held to the deadline at all. These drive the real `priceOf` with the feed and the venue replaced by ones that answer
 * late or never.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getJson: vi.fn(), staleValue: vi.fn(), quote: vi.fn() }));

vi.mock('../http/get.js', () => ({
  getJson: h.getJson,
  staleValue: h.staleValue,
  UpstreamUnavailable: class extends Error {},
}));
// Mocked outright, as `stock-price.test.ts` does: the real module throws at import without an API key.
vi.mock('../venues/oneinch.js', () => ({
  quote: h.quote,
  TOKENS: {},
  canonicalSymbol: (x: string) => x,
  DEFAULT_SLIPPAGE_PCT: 0.3,
}));
vi.mock('../db/index.js', () => ({ query: vi.fn(async () => []) }));

const { priceOf } = await import('./prices.js');
const { clearStockPriceCache } = await import('../venues/stocks.js');
const { StillFetching } = await import('../http/deadline.js');

const never = () => new Promise<never>(() => {});

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  clearStockPriceCache();
});

describe('a price with a deadline', () => {
  it('that the feed does not answer in time, with no earlier price, is still being fetched — not a missing feed', async () => {
    h.getJson.mockImplementation(never);
    h.staleValue.mockReturnValue(undefined);

    const started = Date.now();
    const err = await priceOf('WETH', 50).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StillFetching);
    expect((err as Error).message).toBe('The price of WETH is still being fetched; try again in a moment.');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('that the feed does not answer in time is the last price within ten minutes, when there is one', async () => {
    h.getJson.mockImplementation(never);
    h.staleValue.mockImplementation((_url: string, maxAgeMs: number) =>
      maxAgeMs > 30_000 ? { weth: { usd: 2_512.5 } } : undefined,
    );
    expect(await priceOf('WETH', 50)).toBe(2_512.5);
  });

  it('for a tokenized equity is held to the same deadline, where it waited out the 1inch lane', async () => {
    h.quote.mockImplementation(never);

    const started = Date.now();
    await expect(priceOf('NVDAc', 50)).rejects.toBeInstanceOf(StillFetching);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('without a deadline still waits, as a scheduled buy should', async () => {
    let answer!: (prices: unknown) => void;
    h.getJson.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    h.staleValue.mockReturnValue(undefined);

    const pending = priceOf('WETH');
    await new Promise((resolve) => setTimeout(resolve, 100));
    answer({ weth: { usd: 2_400 } });
    expect(await pending).toBe(2_400);
  });
});
