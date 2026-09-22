/**
 * An exit is judged on the price the sale would be paid, not on the market's.
 *
 * On a fork of X Layer the two part: signals read the live mainnet pools, while a sale settles in the fork's pools,
 * which stand where they stood at the fork block. The hosted fork showed what that costs — a "+10% take profit" fired on
 * METAx because the market was up 10.8%, and the sale returned $9.99 for $10 in. These pin both directions with those
 * numbers: a market move the position cannot realise does not fire, and one it can, does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../evm/chains.js', async (orig) => ({
  ...(await orig<typeof import('../../evm/chains.js')>()),
  CHAIN_KEY: 'xlayer-fork',
  IS_MAINNET_STATE: true,
}));
vi.mock('../../evm/balances.js', () => ({ cashUsd: vi.fn(), holdings: vi.fn() }));
vi.mock('../../market/prices.js', () => ({ priceOf: vi.fn() }));
vi.mock('../../venues/uniswap.js', () => ({ quote: vi.fn() }));

const { holdings } = await import('../../evm/balances.js');
const { priceOf } = await import('../../market/prices.js');
const { quote } = await import('../../venues/uniswap.js');
const { planExitRules, observationFor } = await import('./index.js');

const OWNER = '0x0000000000000000000000000000000000000001' as const;
const UNITS = 0.01485999;
const ENTRY = 672.95;
const held = [{ symbol: 'WOKB', units: UNITS, usd: 10, raw: 14_859_990_000_000_000n }];

/** What the settling chain's pools would pay for the units, as a per-unit price. */
function settlesAt(perUnit: number) {
  vi.mocked(quote).mockResolvedValue({ outAmount: perUnit * UNITS } as Awaited<ReturnType<typeof quote>>);
}

const ctx = {
  owner: OWNER,
  budgetUsd: 0,
  params: { entryPrice: ENTRY, takeProfitPct: 10, stopLossPct: 5 },
  symbol: 'WOKB',
};

beforeEach(() => {
  vi.mocked(holdings).mockResolvedValue(held);
  vi.mocked(priceOf).mockResolvedValue(745.63); // the market: +10.8%
});

describe('exit rules on a fork of mainnet', () => {
  it('does not take a profit the sale would not realise', async () => {
    settlesAt(672.28); // what the fork's pool pays: −0.1%
    expect(await planExitRules(ctx)).toBeNull();
  });

  it('takes it when the sale itself clears the level', async () => {
    settlesAt(ENTRY * 1.12);
    const i = await planExitRules(ctx);
    expect(i).toMatchObject({ inSymbol: 'WOKB', outSymbol: 'USDC' });
    expect(i?.because).toMatch(/up 12\.0% .*take profit/);
  });

  it('quotes the units it would actually sell, into the settlement token', async () => {
    settlesAt(ENTRY);
    await planExitRules(ctx);
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ inSymbol: 'WOKB', outSymbol: 'USDC', amount: UNITS }));
  });

  it('never fires on a sale with no route', async () => {
    vi.mocked(quote).mockRejectedValue(new Error('No route'));
    vi.mocked(priceOf).mockResolvedValue(ENTRY * 0.5); // the market says the stop is far past
    expect(await planExitRules(ctx)).toBeNull();
  });

  it('trails the peak in the same terms the stop is judged in', async () => {
    settlesAt(700);
    const obs = await observationFor('exit-rules', { ...ctx, params: { ...ctx.params, trailPct: 5, peakPrice: 690 } });
    // The settling chain's 700, not the market's 745.63.
    expect(obs?.peakPrice).toBeCloseTo(700, 6);
  });
});
