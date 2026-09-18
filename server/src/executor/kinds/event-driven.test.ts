/**
 * Tier 7 — the last rung, and the only one whose promise is a date.
 *
 * The ladder: *"positions around scheduled events, and flattens before the print."* The judgement
 * lives entirely in the entry; the exit is not a view, it is a promise. So these tests are mostly
 * about the exit holding under every way the date can be wrong — moved, projected, unreadable, or
 * already past — because a flatten that only works when the calendar is right is not a flatten.
 */
process.env.ONEINCH_API_KEY ??= 'test-key';
process.env.XORR_CHAIN ??= 'base-sepolia';
/*
 * base-sepolia is a persistent chain, so the executor refuses to invent a delegate key there. This
 * passed only on machines that happened to have one on disk. Anvil's public development key #0 — it
 * holds nothing anywhere that matters, and no test here signs anything.
 */
process.env.DELEGATE_PRIVATE_KEY ??= '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

import { describe, expect, it, vi, beforeEach } from 'vitest';

const calendar = vi.fn();
const held = vi.fn(() => Promise.resolve([] as unknown[]));

vi.mock('../../market/edgar.js', () => ({ earningsCalendar: () => calendar() }));
vi.mock('../../evm/balances.js', () => ({ holdings: () => held(), cashUsd: async () => 5000 }));
vi.mock('../../market/prices.js', () => ({ priceOf: async () => 232 }));
vi.mock('../../backtest/engine.js', () => ({ history: async () => [], daily: (x: unknown) => x }));

const { PLANNERS } = await import('./index.js');
const plan = PLANNERS['event-driven']!;

const DAY = 86_400_000;
const POSITION = [{ symbol: 'NVDAc', units: 4, usd: 928, raw: 400000000n }];

const ctx = (params: Record<string, unknown>) => ({
  owner: '0x0000000000000000000000000000000000000001' as const,
  budgetUsd: 200,
  symbol: 'NVDAc',
  params,
});

/** A projectable calendar `days` from now, with `errorDays` of observed cadence spread. */
const cal = (days: number, errorDays = 0) => ({
  symbol: 'NVDAc',
  cik: 1045810,
  reported: [Date.now() - 91 * DAY],
  nextAt: Date.now() + days * DAY,
  gapDays: [91, 91],
  medianGapDays: 91,
  errorDays,
});

beforeEach(() => {
  calendar.mockReset();
  held.mockReset();
  held.mockResolvedValue([]);
});

describe('the entry', () => {
  it('buys inside the run-up window', async () => {
    calendar.mockResolvedValue(cal(7));
    const i = await plan(ctx({ usdPerEvent: 150 }));
    expect(i).not.toBeNull();
    expect(i!.outSymbol).toBe('NVDAc');
    expect(i!.usd).toBe(150);
    expect(i!.because).toContain('run-up');
    // It records WHICH event it opened for — that is what makes the exit unconditional later.
    expect((i!.stateAfter as { openedForEventAt: number }).openedForEventAt).toBeGreaterThan(0);
  });

  it('will not open too early', async () => {
    calendar.mockResolvedValue(cal(40));
    expect(await plan(ctx({ usdPerEvent: 150 }))).toBeNull();
  });

  it('will not open inside the flatten window', async () => {
    // Buying here means paying a spread for a position the next run is obliged to sell.
    calendar.mockResolvedValue(cal(1));
    expect(await plan(ctx({ usdPerEvent: 150 }))).toBeNull();
  });

  it('will not open inside a WIDENED flatten window', async () => {
    // 5 days away, 1 day lead, but the projection is ±7 — so this is already inside it.
    calendar.mockResolvedValue(cal(5, 7));
    expect(await plan(ctx({ usdPerEvent: 150 }))).toBeNull();
  });

  it('never adds to a position it already holds', async () => {
    calendar.mockResolvedValue(cal(7));
    held.mockResolvedValue(POSITION);
    expect(await plan(ctx({ usdPerEvent: 150 }))).toBeNull();
  });
});

describe('the flatten — the promise', () => {
  it('sells the WHOLE holding, not only what it bought', async () => {
    calendar.mockResolvedValue(cal(1));
    held.mockResolvedValue(POSITION);
    const i = await plan(ctx({ usdPerEvent: 150, openedForEventAt: Date.now() }));
    expect(i!.inSymbol).toBe('NVDAc');
    expect(i!.outSymbol).toBe('USDC');
    // A partial flatten leaves the user exposed to the event they created this to avoid.
    expect(i!.amountIn).toBe(4);
    expect(i!.amountInRaw).toBe(400000000n);
    expect(i!.because).toContain('Flat before the print');
  });

  it('widens the window by the projection error, and says why', async () => {
    // 6 days out would be safe on a confirmed date; ±7 makes it not.
    calendar.mockResolvedValue(cal(6, 7));
    held.mockResolvedValue(POSITION);
    const i = await plan(ctx({ openedForEventAt: Date.now() }));
    expect(i).not.toBeNull();
    expect(i!.because).toContain('projected');
    expect(i!.because).toContain('7 days of margin');
  });

  it('needs no margin when the user pinned the date', async () => {
    // A pinned date is knowledge, not a guess. Holding, 3 days out, 1-day lead: not yet — where a
    // ±7 projection would already have sold. And the calendar is never consulted at all.
    held.mockResolvedValue(POSITION);
    const i = await plan(ctx({ eventAt: Date.now() + 3 * DAY, openedForEventAt: Date.now() }));
    expect(i).toBeNull();
    expect(calendar).not.toHaveBeenCalled();
  });

  it('closes and stands down when the date has already passed', async () => {
    calendar.mockResolvedValue(cal(-2));
    held.mockResolvedValue(POSITION);
    const i = await plan(ctx({ openedForEventAt: Date.now() - 10 * DAY }));
    expect(i!.outSymbol).toBe('USDC');
    expect(i!.because).toContain('has passed');
  });

  it('closes when the calendar cannot be read at all', async () => {
    // No date means no promise can be kept. Holding on regardless is the failure this prevents.
    calendar.mockResolvedValue(null);
    held.mockResolvedValue(POSITION);
    const i = await plan(ctx({ openedForEventAt: Date.now() }));
    expect(i!.outSymbol).toBe('USDC');
    expect(i!.because).toContain('No reporting date');
  });

  it('closes when the cadence is not projectable', async () => {
    calendar.mockResolvedValue({ ...cal(7), nextAt: null });
    held.mockResolvedValue(POSITION);
    const i = await plan(ctx({ openedForEventAt: Date.now() }));
    expect(i!.outSymbol).toBe('USDC');
  });

  it('does nothing when there is no calendar AND nothing held', async () => {
    calendar.mockResolvedValue(null);
    expect(await plan(ctx({}))).toBeNull();
  });
});
