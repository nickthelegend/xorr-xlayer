/**
 * The proposer's market read for a wrapped xStock. CoinGecko lists none of them, so the range came back null for every
 * one and the Bot tab said "No live market for TSLAx." while this executor quoted and filled TSLAx. Its band is the one
 * this app recorded, and "no market" is kept for a symbol that really has no price.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  observations: [] as number[],
  price: 365,
  riskProfile: 'balanced' as string | null,
  sql: [] as string[],
}));

vi.mock('../db/index.js', () => ({
  one: async (sql: string) => {
    h.sql.push(sql);
    if (/FROM proposals/.test(sql)) return null;
    if (/FROM wallets/.test(sql)) return { address: '0x00000000000000000000000000000000000000A1', agents_stopped: false, risk_profile: h.riskProfile };
    if (/FROM strategies/.test(sql)) return { symbol: 'TSLAx' };
    return null;
  },
  query: async (sql: string) => {
    h.sql.push(sql);
    return /price_observations/.test(sql) ? h.observations.map((usd) => ({ usd: String(usd) })) : [];
  },
}));
vi.mock('../db/chain-scope.js', () => ({ THIS_CHAIN: `'xlayer-fork'` }));
vi.mock('../market/prices.js', () => ({ priceOf: async () => h.price }));
vi.mock('../http/get.js', () => ({ getJson: vi.fn(async () => { throw new Error('CoinGecko must not be asked for an xStock'); }) }));
vi.mock('../evm/delegation.js', () => ({
  readPolicy: async () => ({ dailyCapUsd: 100, expiresAt: Date.now() + 86_400_000, revoked: false }),
}));
vi.mock('../rules/engine.js', () => ({
  evaluate: async () => ({ allowed: true, remainingUsd: 99, reason: 'ok', detail: '' }),
}));
vi.mock('./llm.js', () => ({ speak: async () => ({ ok: false }) }));

const { propose } = await import('./propose.js');

beforeEach(() => {
  h.observations = [];
  h.price = 365;
  h.riskProfile = 'balanced';
  h.sql = [];
});

describe('propose on a wrapped xStock', () => {
  it('reads the band this app recorded, and judges the price against it — not "no live market"', async () => {
    h.observations = [355, 358, 360, 362, 364, 370]; // balanced needs six; 365 sits mid-band
    const r = await propose('w1');
    expect(r).toMatchObject({ created: false, reason: 'no_setup', detail: 'TSLAx is mid-range, so there is nothing worth proposing.' });
    expect(h.sql.some((s) => /price_observations/.test(s))).toBe(true);
  });

  it('says it has not seen enough yet when the price is live but the history is short', async () => {
    h.observations = [360, 364]; // two readings, balanced wants six
    const r = await propose('w1');
    expect(r).toEqual({
      created: false,
      reason: 'no_market_data',
      detail: 'TSLAx is trading, but I have not seen enough of its price yet to judge a range.',
    });
  });

  it("holds the wallet's own risk profile to its evidence bar", async () => {
    h.riskProfile = 'aggressive'; // four readings are enough
    h.observations = [355, 360, 364, 370];
    expect(await propose('w1')).toMatchObject({ reason: 'no_setup' });
    h.riskProfile = 'conservative'; // the same four are not
    expect(await propose('w1')).toMatchObject({ reason: 'no_market_data' });
  });

  it('keeps "No live market" for a symbol with no price at all', async () => {
    h.price = 0;
    h.observations = [355, 358, 360, 362, 364, 370];
    expect(await propose('w1')).toEqual({ created: false, reason: 'no_market_data', detail: 'No live market for TSLAx.' });
  });
});
