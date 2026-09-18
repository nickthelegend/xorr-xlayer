/**
 * The arithmetic, and the rows it must refuse to include.
 *
 * A fill-quality number computed over rows with no quote is not a measurement, it is a shape; the
 * pre-migration rows have no quote to recover and inventing one would put a fabricated figure into
 * the only table that says how well the routing works.
 *
 * And a sale is measured in what it paid (PLAN.md 2.9). It was compared in the asset it sold — which
 * the delegation moves exactly — so every sale scored zero basis points by construction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../evm/chains.js', () => ({ CHAIN_KEY: 'xlayer-fork' }));
vi.mock('../db/index.js', () => ({ query: vi.fn() }));

const { query } = await import('../db/index.js');
const { fillQuality, shortfallBps } = await import('./fill-quality.js');

/** A filled run as the query returns it; a buy of 0.04 units with a matching quote unless overridden. */
const fill = (over: Record<string, unknown>) => ({
  venue: '1inch',
  side: 'buy',
  asset_class: 'crypto',
  quoted_units: '100',
  units: '100',
  quoted_usd: null,
  usd: '100',
  ...over,
});
const rows = (...r: Record<string, unknown>[]) => vi.mocked(query).mockResolvedValue(r as never);

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe('how close each venue came to its quote', () => {
  it('reports a fill that beat the quote as POSITIVE basis points', async () => {
    rows(fill({ venue: 'aqua', units: '100.5' }));
    expect((await fillQuality()).venues[0]!.meanBps).toBe(50);
  });

  it('reports slippage as negative, because the sign is the fact', async () => {
    rows(fill({ units: '99.7' }));
    expect((await fillQuality()).venues[0]!.meanBps).toBe(-30);
  });

  it('keeps the worst single fill, which a mean hides', async () => {
    rows(fill({ venue: 'aqua', units: '101' }), fill({ venue: 'aqua', units: '99' }));
    const q = await fillQuality();
    expect(q.venues[0]!.meanBps).toBe(0);
    expect(q.venues[0]!.worstBps).toBe(-100);
    expect(q.venues[0]!.bestBps).toBe(100);
  });

  it('separates venues rather than averaging them together', async () => {
    rows(fill({ venue: 'aqua', units: '101' }), fill({ units: '99' }));
    expect((await fillQuality()).venues.map((v) => v.venue).sort()).toEqual(['1inch', 'aqua']);
  });

  it('orders by fill count, so one lucky fill does not lead the table', async () => {
    rows(fill({ venue: 'aqua', units: '105' }), fill({}), fill({}));
    expect((await fillQuality()).venues[0]!.venue).toBe('1inch');
  });

  it('refuses a row whose quote is zero rather than dividing by it', async () => {
    rows(fill({ venue: 'aqua', quoted_units: '0', units: '5' }), fill({ venue: 'aqua' }));
    const q = await fillQuality();
    expect(q.venues[0]!.fills).toBe(1);
    expect(Number.isFinite(q.venues[0]!.meanBps)).toBe(true);
    expect(q.unmeasurable).toBe(1);
  });

  /*
   * The first Earn deposit on the rebuilt fork was written down as a 1inch fill, and the table read
   * "1inch: 1 fill, 0 bps" for a trade the aggregator never saw. A supply is 1:1 by construction;
   * there is no execution in it to grade.
   */
  it('leaves a supply to Aave out of the table instead of scoring it as a perfect fill', async () => {
    rows(fill({ venue: 'aave', side: null }), fill({ venue: 'swapvm', units: '100.7' }));
    const q = await fillQuality();
    expect(String(vi.mocked(query).mock.calls[0]![0])).toMatch(/side IS DISTINCT FROM 'supply'/);
    expect(q.venues.map((v) => v.venue)).toEqual(['swapvm']);
    expect(q.measured).toBe(1);
  });

  it('states how many fills could not be measured instead of dropping them silently', async () => {
    rows(fill({ venue: 'aqua' }), ...Array.from({ length: 41 }, () => fill({ venue: 'aqua', quoted_units: null })));
    const q = await fillQuality();
    expect(q.measured).toBe(1);
    expect(q.unmeasurable).toBe(41);
  });

  /*
   * On a fork the reference quote prices live mainnet while the fill executes against a pinned
   * block, so the figure carries drift as well as venue quality. Saying which situation produced
   * it is the difference between a measurement and a number.
   */
  it('says whether the quote and the fill describe the same chain', async () => {
    rows(fill({ venue: 'swapvm' }));
    expect((await fillQuality()).basis).toBe('forked');
  });
});

describe('a sale', () => {
  it('is scored by the USDC it paid against the USDC the arrival price implied', async () => {
    rows(
      // Sold exactly the units asked for — which the old comparison scored as perfect — for $98.70 of
      // a $100.00 arrival value.
      fill({ side: 'sell', quoted_units: '0.04', units: '0.04', quoted_usd: '100', usd: '98.7' }),
      // A buy that delivered 0.0398 of the 0.04 the price implied.
      fill({ quoted_units: '0.04', units: '0.0398' }),
    );
    const q = await fillQuality();
    expect(q.venues).toEqual([
      { venue: '1inch', assetClass: 'crypto', fills: 2, sells: 1, meanBps: -90, worstBps: -130, bestBps: -50 },
    ]);
    expect(q.unmeasurable).toBe(0);
  });

  it('with no quote kept — recorded before 2.9, or proceeds not read back — is unmeasured, not perfect', async () => {
    rows(fill({ side: 'sell', quoted_usd: null, usd: '100' }));
    const q = await fillQuality();
    expect(q.venues).toEqual([]);
    expect(q.unmeasurable).toBe(1);
  });

  it('is signed for the taker: more USDC than implied is positive', () => {
    expect(shortfallBps(fill({ side: 'sell', quoted_usd: '100', usd: '100.5' }) as never)).toBeCloseTo(50, 6);
  });
});

describe('equities', () => {
  it('are reported beside crypto, not averaged in with it', async () => {
    rows(fill({ quoted_units: '0.04', units: '0.0398' }), fill({ asset_class: 'equity', quoted_units: '2', units: '1.99' }));
    const q = await fillQuality();
    expect(q.venues.map((v) => [v.venue, v.assetClass, v.meanBps])).toEqual([
      ['1inch', 'crypto', -50],
      ['1inch', 'equity', -50],
    ]);
  });
});
