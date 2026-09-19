/**
 * What each tier decides to do.
 *
 * These are the branches that used not to exist: every strategy executed as a recurring buy
 * whatever it said it was. The properties below are the ones that make each tier trustworthy —
 * a rebalance trades only the drift, and a stop can only ever close.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * A holding with a raw balance that actually matches its unit count.
 *
 * `Holding.raw` exists because a float cannot represent a wei count, and closing a whole position
 * has to use the chain's own number. A fixture that made one up would defeat the point, so this
 * derives it the same way `holdings()` does — from the units and the token's decimals.
 */
function holding(symbol: string, units: number, usd: number, decimals = 18) {
  return { symbol, units, usd, raw: BigInt(Math.round(units * 10 ** decimals)) };
}


vi.mock('../../evm/balances.js', () => ({
  cashUsd: vi.fn(),
  holdings: vi.fn(),
}));
vi.mock('../../market/prices.js', () => ({ priceOf: vi.fn() }));

const { cashUsd, holdings } = await import('../../evm/balances.js');
const { priceOf } = await import('../../market/prices.js');
const { planRebalance, planExitRules, planDca, planGrid, observationFor } = await import(
  './index.js'
);

const OWNER = '0x0000000000000000000000000000000000000001' as const;

beforeEach(() => {
  vi.mocked(priceOf).mockResolvedValue(2_500);
});

describe('tier 1 — recurring buy', () => {
  it('buys exactly the budget, and picks nothing', () => {
    const i = planDca({ owner: OWNER, budgetUsd: 250, params: {}, symbol: 'WETH' });
    expect(i).toMatchObject({ inSymbol: 'USDC', outSymbol: 'WETH', amountIn: 250, usd: 250 });
  });

  it('maps ETH to WETH, because that is what settles', () => {
    expect(planDca({ owner: OWNER, budgetUsd: 100, params: {}, symbol: 'ETH' }).outSymbol).toBe(
      'WETH',
    );
  });

  it('a one-shot order an agent placed names the agent, not the person', () => {
    const placed = planDca({
      owner: OWNER,
      budgetUsd: 24,
      params: { usd: 24, manual: true, placedBy: 'Momentum Scout' },
      symbol: 'TSLAx',
    });
    expect(placed.because).toBe('Placed by Momentum Scout.');
  });

  it('a one-shot order a person placed says so, and carries the tolerance it was placed with (PLAN.md 3.9)', () => {
    const placed = planDca({ owner: OWNER, budgetUsd: 20, params: { usd: 20, manual: true, slippagePct: 0.5 }, symbol: 'WETH' });
    expect(placed).toMatchObject({ because: 'Placed by you.', slippagePct: 0.5 });
    const scheduled = planDca({ owner: OWNER, budgetUsd: 20, params: {}, symbol: 'WETH' });
    expect(scheduled.because).toBe('Scheduled recurring buy.');
    expect(scheduled).not.toHaveProperty('slippagePct');
  });
});

describe('tier 2 — rebalance', () => {
  it('does nothing when the portfolio is already on target', async () => {
    vi.mocked(cashUsd).mockResolvedValue(400);
    vi.mocked(holdings).mockResolvedValue([holding('WETH', 0.24, 600)]);
    // 600 of 1000 is exactly the 60% target.
    const i = await planRebalance({
      owner: OWNER,
      budgetUsd: 500,
      params: { targets: { WETH: 60 } },
      symbol: 'WETH',
    });
    expect(i).toBeNull();
  });

  it('buys the sleeve that is under weight', async () => {
    vi.mocked(cashUsd).mockResolvedValue(1_000);
    vi.mocked(holdings).mockResolvedValue([]);
    const i = await planRebalance({
      owner: OWNER,
      budgetUsd: 1_000,
      params: { targets: { WETH: 60 } },
      symbol: 'WETH',
    });
    expect(i).toMatchObject({ inSymbol: 'USDC', outSymbol: 'WETH' });
    expect(i!.usd).toBeCloseTo(600, 0);
    expect(i!.because).toMatch(/under its target/);
  });

  it('SELLS the sleeve that is over weight, sized in coins not dollars', async () => {
    vi.mocked(cashUsd).mockResolvedValue(0);
    vi.mocked(holdings).mockResolvedValue([holding('WETH', 0.4, 1_000)]);
    const i = await planRebalance({
      owner: OWNER,
      budgetUsd: 1_000,
      params: { targets: { WETH: 60 } },
      symbol: 'WETH',
    });
    expect(i).toMatchObject({ inSymbol: 'WETH', outSymbol: 'USDC' });
    // 400 dollars over, at 2500/coin, is 0.16 coins. Dollars here would have been a 400e18 order.
    expect(i!.amountIn).toBeCloseTo(0.16, 4);
    expect(i!.usd).toBeCloseTo(400, 0);
  });

  it('never trades below the point where gas costs more than the drift', async () => {
    vi.mocked(cashUsd).mockResolvedValue(1_000);
    vi.mocked(holdings).mockResolvedValue([holding('WETH', 0.6, 1_499)]);
    const i = await planRebalance({
      owner: OWNER,
      budgetUsd: 1_000,
      params: { targets: { WETH: 60 } },
      symbol: 'WETH',
    });
    expect(i).toBeNull();
  });

  it('is capped by what the run is allowed to spend', async () => {
    vi.mocked(cashUsd).mockResolvedValue(10_000);
    vi.mocked(holdings).mockResolvedValue([]);
    const i = await planRebalance({
      owner: OWNER,
      budgetUsd: 250,
      params: { targets: { WETH: 60 } },
      symbol: 'WETH',
    });
    expect(i!.usd).toBe(250);
  });
});

describe('tier 3 — take profit and stop loss', () => {
  const held = [holding('WETH', 0.4, 1_000)];

  it('does nothing while the price is between the bands', async () => {
    vi.mocked(holdings).mockResolvedValue(held);
    vi.mocked(priceOf).mockResolvedValue(2_500);
    const i = await planExitRules({
      owner: OWNER,
      budgetUsd: 0,
      params: { entryPrice: 2_400, takeProfitPct: 20, stopLossPct: 20 },
      symbol: 'WETH',
    });
    expect(i).toBeNull();
  });

  /*
   * Stacking. Two exits on one symbol both close the WHOLE position, so without this the second to
   * fire would sell units the first had already sold — the failure that used to be prevented by
   * refusing the second strategy outright.
   */
  it('sells only what the rest of the stack has not already claimed', async () => {
    vi.mocked(holdings).mockResolvedValue(held);
    vi.mocked(priceOf).mockResolvedValue(3_000);

    const i = await planExitRules({
      owner: OWNER,
      budgetUsd: 0,
      params: { entryPrice: 2_400, takeProfitPct: 20 },
      symbol: 'WETH',
      claimedSellUnits: 0.3,
    });

    expect(i?.amountIn).toBeCloseTo(held[0]!.units - 0.3, 9);
    // The raw figure is a claim on the whole balance, so it is dropped once part is spoken for.
    expect(i?.amountInRaw).toBeUndefined();
    expect(i!.usd).toBeLessThan(held[0]!.usd);
  });

  it('closes the whole position, to the wei, when nothing else is stacked', async () => {
    vi.mocked(holdings).mockResolvedValue(held);
    vi.mocked(priceOf).mockResolvedValue(3_000);

    const i = await planExitRules({
      owner: OWNER,
      budgetUsd: 0,
      params: { entryPrice: 2_400, takeProfitPct: 20 },
      symbol: 'WETH',
      claimedSellUnits: 0,
    });

    expect(i?.amountIn).toBe(held[0]!.units);
    expect(i?.amountInRaw).toBe(held[0]!.raw);
  });

  it('does nothing when the rest of the stack has already sold everything', async () => {
    vi.mocked(holdings).mockResolvedValue(held);
    vi.mocked(priceOf).mockResolvedValue(3_000);

    const i = await planExitRules({
      owner: OWNER,
      budgetUsd: 0,
      params: { entryPrice: 2_400, takeProfitPct: 20 },
      symbol: 'WETH',
      claimedSellUnits: held[0]!.units,
    });

    expect(i).toBeNull();
  });

  it('closes the whole position on a take profit', async () => {
    vi.mocked(holdings).mockResolvedValue(held);
    vi.mocked(priceOf).mockResolvedValue(3_000);
    const i = await planExitRules({
      owner: OWNER,
      budgetUsd: 0,
      params: { entryPrice: 2_400, takeProfitPct: 20 },
      symbol: 'WETH',
    });
    expect(i).toMatchObject({ inSymbol: 'WETH', outSymbol: 'USDC', amountIn: 0.4 });
    expect(i!.because).toMatch(/take profit/);
  });

  it('closes the whole position on a stop', async () => {
    vi.mocked(holdings).mockResolvedValue(held);
    vi.mocked(priceOf).mockResolvedValue(1_800);
    const i = await planExitRules({
      owner: OWNER,
      budgetUsd: 0,
      params: { entryPrice: 2_400, stopLossPct: 20 },
      symbol: 'WETH',
    });
    expect(i!.because).toMatch(/your stop/);
  });

  it('CANNOT open a position — there is no branch that buys', async () => {
    vi.mocked(holdings).mockResolvedValue([]);
    vi.mocked(priceOf).mockResolvedValue(3_000);
    const i = await planExitRules({
      owner: OWNER,
      budgetUsd: 1_000,
      params: { entryPrice: 2_400, takeProfitPct: 20 },
      symbol: 'WETH',
    });
    // Nothing held, so nothing to close. It must not decide to buy instead.
    expect(i).toBeNull();
  });

  it('does nothing without an entry price to measure against', async () => {
    vi.mocked(holdings).mockResolvedValue(held);
    const i = await planExitRules({
      owner: OWNER,
      budgetUsd: 0,
      params: { takeProfitPct: 20 },
      symbol: 'WETH',
    });
    expect(i).toBeNull();
  });
});

describe('tier 5 — range accumulation', () => {
  // rungs at 2000, 2250, 2500, 2750, 3000
  const BASE = { lower: 2000, upper: 3000, steps: 4, usdPerStep: 50 };
  const ctx = (params: Record<string, unknown>) => ({
    owner: OWNER,
    budgetUsd: 500,
    params,
    symbol: 'WETH',
  });

  beforeEach(() => {
    vi.mocked(holdings).mockResolvedValue([holding('WETH', 0.04, 100)]);
  });

  it('places nothing on its first sight of the price', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_600);
    // Nothing has been crossed yet, because there is no previous position to have crossed from.
    // Inventing one would open a position at a price the user never chose.
    expect(await planGrid(ctx({ ...BASE }))).toBeNull();
  });

  it('records where the price is, so the next move is a real crossing', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_600);
    expect(await observationFor('grid', ctx({ ...BASE }))).toEqual({ lastLevel: 2, openLots: [] });
  });

  it('does nothing while the price drifts inside one rung', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_620);
    expect(await planGrid(ctx({ ...BASE, lastLevel: 2, openLots: [] }))).toBeNull();
  });

  it('buys when the price falls through a rung', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_400);
    const i = await planGrid(ctx({ ...BASE, lastLevel: 2, openLots: [] }));
    expect(i?.outSymbol).toBe('WETH');
    expect(i?.usd).toBe(50);
    expect(i?.stateAfter).toEqual({ lastLevel: 1, openLots: [1] });
  });

  it('does not buy the same rung twice while the price sits below it', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_300);
    // The crossing already happened. Acting on "is below" rather than "has crossed" would buy
    // this rung on every single tick for as long as the price stayed there.
    expect(await planGrid(ctx({ ...BASE, lastLevel: 1, openLots: [1] }))).toBeNull();
  });

  it('sells the CHEAPEST lot when the price rises through a rung', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_400);
    const i = await planGrid(ctx({ ...BASE, lastLevel: 0, openLots: [0, 1] }));
    expect(i?.outSymbol).toBe('USDC');
    // Selling the newest lot instead would book the smallest gain available and leave the cheap
    // lot exposed to the range breaking.
    expect(i?.because).toContain('2000.00');
    expect(i?.stateAfter).toEqual({ lastLevel: 1, openLots: [1] });
  });

  it('stops when the price leaves the range rather than chasing it', async () => {
    vi.mocked(priceOf).mockResolvedValue(3_400);
    expect(await planGrid(ctx({ ...BASE, lastLevel: 4, openLots: [] }))).toBeNull();
    vi.mocked(priceOf).mockResolvedValue(1_500);
    // The alternative is averaging down past the floor its owner drew, forever.
    expect(await planGrid(ctx({ ...BASE, lastLevel: 0, openLots: [0] }))).toBeNull();
  });

  it('refuses an inverted or nonsensical range instead of guessing', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_500);
    expect(await planGrid(ctx({ lower: 3_000, upper: 2_000, steps: 4, usdPerStep: 50, lastLevel: 1 }))).toBeNull();
    vi.mocked(priceOf).mockResolvedValue(2_100);
    expect(await planGrid(ctx({ ...BASE, usdPerStep: 0.5, lastLevel: 3, openLots: [] }))).toBeNull();
  });

  it('sells nothing when it is holding nothing', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_600);
    expect(await planGrid(ctx({ ...BASE, lastLevel: 1, openLots: [] }))).toBeNull();
  });
});

describe('tier 3 — trailing stop', () => {
  const ctx = (params: Record<string, unknown>) => ({
    owner: OWNER,
    budgetUsd: 0,
    params,
    symbol: 'WETH',
  });

  beforeEach(() => {
    vi.mocked(holdings).mockResolvedValue([holding('WETH', 0.4, 1_000)]);
  });

  it('follows a rise', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_800);
    expect(await observationFor('exit-rules', ctx({ entryPrice: 2_000, trailPct: 10, peakPrice: 2_500 })))
      .toEqual({ peakPrice: 2_800 });
  });

  it('never follows a fall', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_100);
    // The whole mechanism is that the high-water mark only goes up. If it tracked down, the stop
    // would trail the price forever and never fire.
    expect(await observationFor('exit-rules', ctx({ entryPrice: 2_000, trailPct: 10, peakPrice: 2_500 })))
      .toBeNull();
  });

  it('seeds from entry, not from a mark that is already underwater', async () => {
    vi.mocked(priceOf).mockResolvedValue(1_800);
    // Seeding from today's price on a losing position would put the stop below where the user set
    // it and let the loss keep running.
    expect(await observationFor('exit-rules', ctx({ entryPrice: 2_000, trailPct: 10 })))
      .toEqual({ peakPrice: 2_000 });
  });

  it('does nothing while the price holds above the trail', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_600);
    expect(await planExitRules(ctx({ entryPrice: 2_000, trailPct: 10, peakPrice: 2_800 }))).toBeNull();
  });

  it('closes the whole position when the price falls through the trail', async () => {
    vi.mocked(priceOf).mockResolvedValue(2_500);
    const i = await planExitRules(ctx({ entryPrice: 2_000, trailPct: 10, peakPrice: 2_800 }));
    expect(i?.outSymbol).toBe('USDC');
    expect(i?.amountIn).toBe(0.4);
    // It fired from the HIGH, not from entry — the position is still well above where it was
    // bought, which is exactly the case a fixed stop cannot express.
    expect(i?.because).toContain('2800.00');
  });

  it('is inert without a trail configured', async () => {
    vi.mocked(priceOf).mockResolvedValue(1_000);
    expect(await observationFor('exit-rules', ctx({ entryPrice: 2_000 }))).toBeNull();
  });
});
