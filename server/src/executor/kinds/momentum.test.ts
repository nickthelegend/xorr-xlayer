/**
 * Tier 6 — the first strategy that has to be right about the future.
 *
 * The ladder's own constraints, tested as constraints: buys strength, on something fillable, with
 * a stop attached to every entry, asking first. A momentum entry with no exit is the single most
 * expensive shape in this ladder, so the stop is not optional and the tests treat it that way.
 */
process.env.ONEINCH_API_KEY ??= 'test-key';
process.env.XORR_CHAIN ??= 'base-sepolia';

import { describe, expect, it, vi } from 'vitest';

const closes = vi.fn();
const spot = vi.fn();
const held = vi.fn(() => Promise.resolve([] as unknown[]));

vi.mock('../../backtest/engine.js', () => ({
  history: () => closes(),
  daily: (p: unknown) => p,
}));
vi.mock('../../market/prices.js', () => ({ priceOf: () => spot() }));
vi.mock('../../evm/balances.js', () => ({ holdings: () => held(), cashUsd: async () => 1000 }));

const { PLANNERS } = await import('./index.js');
const momentum = PLANNERS.momentum!;

/** A flat series at `base`, so the only breakout is the one a test asks for. */
const flat = (base: number, n = 60) =>
  Array.from({ length: n }, (_, i) => [i, base] as [number, number]);

/** A rising series, so the fast average sits above the slow one. */
const rising = (from: number, to: number, n = 60) =>
  Array.from({ length: n }, (_, i) => [i, from + ((to - from) * i) / (n - 1)] as [number, number]);

const ctx = (params: Record<string, unknown>) => ({
  owner: '0x0000000000000000000000000000000000000001' as const,
  budgetUsd: 100,
  symbol: 'WETH',
  params,
});

describe('the entry', () => {
  it('buys a break above the lookback high in an uptrend', async () => {
    closes.mockResolvedValue(rising(2000, 2400));
    spot.mockResolvedValue(2500); // above every close in the window
    const i = await momentum(ctx({ lookbackDays: 20, stopPct: 8, usdPerEntry: 50 }));
    expect(i).not.toBeNull();
    expect(i!.outSymbol).toBe('WETH');
    expect(i!.usd).toBe(50);
    expect(i!.because).toContain('20-day high');
  });

  it('attaches a stop to the entry, priced off the fill', async () => {
    closes.mockResolvedValue(rising(2000, 2400));
    spot.mockResolvedValue(2500);
    const i = await momentum(ctx({ lookbackDays: 20, stopPct: 8, usdPerEntry: 50 }));
    // 8% below 2500. Without this the position is open with no exit.
    expect((i!.stateAfter as { stopPrice: number }).stopPrice).toBeCloseTo(2300, 6);
    expect((i!.stateAfter as { openEntryPrice: number }).openEntryPrice).toBe(2500);
  });

  it('refuses a spike with no trend behind it', async () => {
    // Falling series: price pokes above the window high, but fast is below slow.
    closes.mockResolvedValue(rising(3000, 2100));
    spot.mockResolvedValue(3001);
    expect(await momentum(ctx({ lookbackDays: 20, stopPct: 8, usdPerEntry: 50 }))).toBeNull();
  });

  it('does not break out against a high it set itself', async () => {
    // The window must EXCLUDE the current price, or every price is its own new high.
    closes.mockResolvedValue(flat(2500));
    spot.mockResolvedValue(2500);
    expect(await momentum(ctx({ lookbackDays: 20, stopPct: 8, usdPerEntry: 50 }))).toBeNull();
  });

  it('never adds to a position it already holds', async () => {
    closes.mockResolvedValue(rising(2000, 2400));
    spot.mockResolvedValue(2500);
    held.mockResolvedValue([]);
    // Re-entering its own breakout is how one signal becomes four times the intended size.
    const i = await momentum(ctx({ lookbackDays: 20, stopPct: 8, usdPerEntry: 50, openEntryPrice: 2400, stopPrice: 2200 }));
    expect(i).toBeNull();
  });

  it('says nothing on too little history rather than guessing', async () => {
    closes.mockResolvedValue(rising(2000, 2400, 6));
    spot.mockResolvedValue(2500);
    expect(await momentum(ctx({ lookbackDays: 20, stopPct: 8, usdPerEntry: 50 }))).toBeNull();
  });
});

describe('the exit', () => {
  it('sells the whole position when the stop is breached', async () => {
    held.mockResolvedValue([{ symbol: 'WETH', units: 0.5, usd: 1200, raw: 500000000000000000n }]);
    spot.mockResolvedValue(2100); // below the 2200 stop
    const i = await momentum(ctx({ openEntryPrice: 2400, stopPrice: 2200 }));
    expect(i).not.toBeNull();
    expect(i!.inSymbol).toBe('WETH');
    expect(i!.outSymbol).toBe('USDC');
    expect(i!.amountIn).toBe(0.5);
    expect(i!.because).toContain('stop');
    // Forgetting the position is what lets the next breakout be judged on its own merits.
    expect((i!.stateAfter as { openEntryPrice: number }).openEntryPrice).toBe(0);
  });

  it('holds while the price is above the stop', async () => {
    held.mockResolvedValue([{ symbol: 'WETH', units: 0.5, usd: 1200, raw: 500000000000000000n }]);
    spot.mockResolvedValue(2300);
    expect(await momentum(ctx({ openEntryPrice: 2400, stopPrice: 2200 }))).toBeNull();
  });
});
