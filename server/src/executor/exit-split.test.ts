/**
 * End to end: does a split still liquidate the position?
 *
 * `planExitRules` compares a mark to a stored entry price. Both are USD per DISPLAYED token, and a
 * split changes what a displayed token is — so without adjustment a 4:1 split reads as a 75% fall
 * and closes the position. This drives the real planner through a split and asserts it stays put.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

process.env.XORR_CHAIN ??= 'base-sepolia';

const MARK = vi.hoisted(() => ({ priceOf: vi.fn() }));
vi.mock('../market/prices.js', () => MARK);

const HOLD = vi.hoisted(() => ({ holdings: vi.fn(), cashUsd: vi.fn(async () => 1000) }));
vi.mock('../evm/balances.js', () => HOLD);

const RESTING = vi.hoisted(() => ({ restingLevels: vi.fn() }));
vi.mock('./resting.js', () => RESTING);

const { planExitRules } = await import('./kinds/index.js');

const OWNER = '0xC38f38f45463f77bD823FebE16b15714Eb98c8A5' as const;

beforeEach(() => {
  vi.clearAllMocks();
  HOLD.holdings.mockResolvedValue([{ symbol: 'NVDAx', usd: 2000, units: 10, raw: 10n }]);
});

/** Entry $200, stop 10%. After a 4:1 split the mark is ~$50. */
const ctx = () => ({
  owner: OWNER,
  budgetUsd: 1000,
  symbol: 'NVDAx',
  levelSetAt: new Date('2026-09-01T00:00:00Z'),
  params: { entryPrice: 200, stopLossPct: 10, multiplierBasis: { multiplier: 1, recordedAt: '2026-09-01T00:00:00Z' } },
});

describe('a split must not fire the stop', () => {
  it('holds the position when levels are adjusted for the split', async () => {
    MARK.priceOf.mockResolvedValue(50);
    RESTING.restingLevels.mockResolvedValue({
      status: 'ok',
      levels: { entryPrice: 50, peakPrice: 0 },
      factor: 0.25,
      adjusted: true,
      basis: { multiplier: 1, recordedAt: '2026-09-01T00:00:00Z' },
      currentMultiplier: 4,
    });

    // $50 against an adjusted entry of $50 is a 0% move. Nothing should fire.
    expect(await planExitRules(ctx() as never)).toBeNull();
  });

  it('would have liquidated without the adjustment — the bug this prevents', async () => {
    MARK.priceOf.mockResolvedValue(50);
    // Levels left in their pre-split terms, as before this change.
    RESTING.restingLevels.mockResolvedValue({
      status: 'ok',
      levels: { entryPrice: 200, peakPrice: 0 },
      factor: 1,
      adjusted: false,
      basis: { multiplier: 1, recordedAt: '2026-09-01T00:00:00Z' },
      currentMultiplier: 1,
    });

    const plan = await planExitRules(ctx() as never);
    expect(plan).not.toBeNull();
    expect(plan!.because).toMatch(/down 75\.0% from 200/);
    expect(plan!.outSymbol).toBe('USDC');
  });

  it('does not fire when the levels cannot be adjusted safely', async () => {
    MARK.priceOf.mockResolvedValue(50);
    RESTING.restingLevels.mockResolvedValue({
      status: 'unsafe',
      reason: 'a split since then cannot be ruled out',
    });

    // Refusing to act is the point: a stop that cannot be trusted must not sell.
    expect(await planExitRules(ctx() as never)).toBeNull();
    // And it must not even have asked for a mark to compare against.
    expect(MARK.priceOf).not.toHaveBeenCalled();
  });

  it('still takes a genuine stop after a split', async () => {
    // A real 20% fall on top of the split: mark $40 against an adjusted entry of $50.
    MARK.priceOf.mockResolvedValue(40);
    RESTING.restingLevels.mockResolvedValue({
      status: 'ok',
      levels: { entryPrice: 50, peakPrice: 0 },
      factor: 0.25,
      adjusted: true,
      basis: { multiplier: 1, recordedAt: '2026-09-01T00:00:00Z' },
      currentMultiplier: 4,
    });

    const plan = await planExitRules(ctx() as never);
    expect(plan).not.toBeNull();
    expect(plan!.because).toMatch(/down 20\.0% from 50/);
  });
});
