/**
 * A futures screen shows the venue's numbers, or says why it cannot — it never fills a gap.
 *
 * The metrics used to be a spot price, a hardcoded 10x and nulls. They come from Hyperliquid now, so
 * these pin the three answers that matter: the venue's figures when it answers, "too slow" when it
 * does not, and "no such contract" — a different answer — when there is nothing to ask about.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PerpMarket } from './hyperliquid.js';

const perpMarkets = vi.fn();
vi.mock('./hyperliquid.js', () => ({ perpMarkets: (...a: unknown[]) => perpMarkets(...a) }));

const { perpMetrics, findPerp, nextFundingAt, PriceTooSlow } = await import('./perp.js');

const BTC: PerpMarket = {
  symbol: 'BTC',
  markPx: 77_178,
  oraclePx: 77_211.3,
  change24hPct: 0.126,
  fundingRate: 0.0000034505,
  openInterestUsd: 2_756_000_000,
  dayVolumeUsd: 628_585_034,
  maxLeverage: 40,
};
const ETH: PerpMarket = { ...BTC, symbol: 'ETH', markPx: 2_521.3, oraclePx: 2_521.92, maxLeverage: 25 };
const PEPE: PerpMarket = { ...BTC, symbol: 'kPEPE', markPx: 0.0093, oraclePx: 0.0093, maxLeverage: 10 };

/*
 * Braces matter here. `beforeEach(() => perpMarkets.mockReset())` RETURNS the mock, and vitest treats
 * a function returned from a hook as a teardown callback — so it would call the mock after each test.
 */
beforeEach(() => {
  perpMarkets.mockReset();
});

describe('perpMetrics', () => {
  it("reads every figure from the venue — nothing is a default", async () => {
    perpMarkets.mockResolvedValue([BTC, ETH]);
    const m = await perpMetrics('BTC');
    expect(m).toMatchObject({
      symbol: 'BTC',
      markPx: 77_178,
      oraclePx: 77_211.3,
      fundingRate: 0.0000034505,
      openInterestUsd: 2_756_000_000,
      dayVolumeUsd: 628_585_034,
      maxLeverage: 40,
      fundingIntervalHours: 1,
      venue: 'Hyperliquid',
    });
    // A real spread, not the zero-by-construction the spot-price version reported.
    expect(m?.markVsIndex).toBeCloseTo(-33.3, 5);
  });

  it('reports a slow venue as slow, not as a missing contract', async () => {
    perpMarkets.mockRejectedValue(new Error('api.hyperliquid.xyz timed out'));
    let caught: unknown;
    try {
      await perpMetrics('BTC');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PriceTooSlow);
    // The route turns this into a 503 "warming" with a retry-after, not a 404.
    expect((caught as Error).message).toContain('did not answer in time');
  });

  it('answers "no contract" for a stock without asking the venue', async () => {
    expect(await perpMetrics('NVDAc')).toBeNull();
    expect(perpMarkets).not.toHaveBeenCalled();
  });

  it('answers "no contract" for a symbol the venue does not list', async () => {
    perpMarkets.mockResolvedValue([BTC, ETH]);
    expect(await perpMetrics('NOTASYMBOL')).toBeNull();
  });
});

describe('findPerp', () => {
  it('matches whatever the case, keeping the venue spelling', () => {
    expect(findPerp([BTC, PEPE], 'kpepe')?.symbol).toBe('kPEPE');
    expect(findPerp([BTC, PEPE], 'btc')?.symbol).toBe('BTC');
  });

  it("finds a wrapped token's contract under its underlying", () => {
    expect(findPerp([BTC, ETH], 'WETH')?.symbol).toBe('ETH');
    expect(findPerp([BTC, ETH], 'cbBTC')?.symbol).toBe('BTC');
  });
});

describe('nextFundingAt', () => {
  it('is the top of the next hour — the venue settles hourly', () => {
    expect(nextFundingAt(Date.UTC(2026, 8, 13, 10, 15))).toBe(Date.UTC(2026, 8, 13, 11, 0));
  });
});
