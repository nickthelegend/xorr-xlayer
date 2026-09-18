/**
 * Perpetual metrics — one contract, from the venue that lists it (2026-09-13).
 *
 * This used to be honest about what it did not know and fill the rest with arithmetic: a spot price
 * as the mark, a hardcoded 10x, an eight-hour funding clock, and nulls for open interest, volume and
 * the funding rate. Every figure now comes from Hyperliquid (see `hyperliquid.ts`): mark and oracle,
 * hourly funding, open interest, day volume and the contract's own maximum leverage.
 *
 * xorr does not trade futures, and nothing here opens a position.
 */
import { isStock } from '../venues/stocks.js';
import { perpMarkets, type PerpMarket } from './hyperliquid.js';

export type PerpMetrics = {
  symbol: string;
  markPx: number;
  oraclePx: number;
  /** Mark minus oracle, in dollars — how far the contract trades from the index it tracks. */
  markVsIndex: number;
  change24hPct: number | null;
  openInterestUsd: number;
  dayVolumeUsd: number;
  /** Per funding interval, as a fraction. Positive means longs pay shorts. */
  fundingRate: number;
  fundingIntervalHours: number;
  maxLeverage: number;
  nextFundingSeconds: number;
  /** Absolute unix ms, so the client counts down purely rather than anchoring in an effect. */
  nextFundingAt: number;
  venue: 'Hyperliquid';
  feed: 'live';
};

/** Hyperliquid settles funding every hour, on the hour. */
const FUNDING_INTERVAL_MS = 60 * 60 * 1000;

export function nextFundingAt(now = Date.now()): number {
  return Math.ceil(now / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;
}

/** The venue exists and did not answer in time — distinct from "there is no such contract". */
export class PriceTooSlow extends Error {
  constructor(readonly symbol: string) {
    super(`The futures venue did not answer in time for ${symbol}.`);
    this.name = 'PriceTooSlow';
  }
}

/** A wrapped token's contract is its underlying's: nobody lists a WETH perpetual, and ETH's is the one. */
const UNDERLYING: Readonly<Record<string, string>> = { WETH: 'ETH', CBBTC: 'BTC', WBTC: 'BTC' };

/** The contract for a symbol, whatever its case — Hyperliquid names some in mixed case, like `kPEPE`. */
export function findPerp(markets: readonly PerpMarket[], symbol: string): PerpMarket | undefined {
  const upper = symbol.toUpperCase();
  const wanted = UNDERLYING[upper] ?? upper;
  return markets.find((m) => m.symbol.toUpperCase() === wanted);
}

export async function perpMetrics(symbol: string): Promise<PerpMetrics | null> {
  // A tokenized equity has no perpetual market — a real answer, and one that needs no venue call.
  if (isStock(symbol)) return null;

  const markets = await perpMarkets().catch(() => {
    throw new PriceTooSlow(symbol.toUpperCase());
  });
  const m = findPerp(markets, symbol);
  if (!m) return null;

  const at = nextFundingAt();
  return {
    symbol: m.symbol,
    markPx: m.markPx,
    oraclePx: m.oraclePx,
    markVsIndex: m.markPx - m.oraclePx,
    change24hPct: m.change24hPct,
    openInterestUsd: m.openInterestUsd,
    dayVolumeUsd: m.dayVolumeUsd,
    fundingRate: m.fundingRate,
    fundingIntervalHours: FUNDING_INTERVAL_MS / (60 * 60 * 1000),
    maxLeverage: m.maxLeverage,
    nextFundingSeconds: Math.max(0, Math.round((at - Date.now()) / 1000)),
    nextFundingAt: at,
    venue: 'Hyperliquid',
    feed: 'live',
  };
}
