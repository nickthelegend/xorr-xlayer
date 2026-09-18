/**
 * Hyperliquid — where the futures numbers come from (2026-09-13).
 *
 * `perp.ts` used to say, truthfully, that xorr runs no perp venue and so could not know open interest,
 * volume or the funding rate — and then showed a spot price as the mark, a hardcoded 10x and an
 * eight-hour clock. Hyperliquid is a perpetual futures venue with a public, keyless read API, so those
 * figures are now the venue's own: its mark and oracle, its hourly funding, its open interest and
 * volume, and each contract's real maximum leverage.
 *
 * xorr still does not trade futures. This is market data, and the screens say so.
 */
import { postJson, postKey, staleValue } from '../http/get.js';

const INFO_URL = 'https://api.hyperliquid.xyz/info';

/** Marks move; a quarter-minute cache keeps the list and the detail screen quoting the same number. */
const MARKETS_TTL_MS = 15_000;
const CANDLES_TTL_MS = 60_000;
/** How long a screen waits on the venue before it says the venue is slow. */
const TIMEOUT_MS = 8_000;
/** Past this, an old answer is worse than saying the venue did not answer. */
const STALE_MS = 5 * 60_000;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Universe = { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean };
type AssetContext = {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  oraclePx: string;
  markPx: string;
};
type RawCandle = { t: number; o: string; h: string; l: string; c: string };

export type PerpMarket = {
  /** The venue's own name for the contract — `BTC`, `kPEPE`. Case matters to Hyperliquid. */
  symbol: string;
  markPx: number;
  oraclePx: number;
  /** Mark against the price 24 hours earlier, in percent. Null when the venue has no earlier price. */
  change24hPct: number | null;
  /** Paid every hour, as a fraction: 0.0000125 is 0.00125% an hour. Positive means longs pay shorts. */
  fundingRate: number;
  openInterestUsd: number;
  dayVolumeUsd: number;
  maxLeverage: number;
};

export const PERP_RANGES = ['1D', '1W', '1M', '1Y'] as const;
export type PerpRange = (typeof PERP_RANGES)[number];

/** Each range as a candle size and a count — the same shapes the asset charts draw. */
const RANGE_CANDLES: Readonly<Record<PerpRange, { interval: string; stepMs: number; count: number }>> = {
  '1D': { interval: '1h', stepMs: HOUR, count: 24 },
  '1W': { interval: '4h', stepMs: 4 * HOUR, count: 42 },
  '1M': { interval: '1d', stepMs: DAY, count: 30 },
  '1Y': { interval: '1w', stepMs: 7 * DAY, count: 52 },
};

export type PerpCandles = {
  symbol: string;
  range: PerpRange;
  interval: string;
  /** Candle open times, unix ms, one per bar. */
  times: number[];
  /** `[open, high, low, close]` — the app's Bar shape. */
  bars: [number, number, number, number][];
};

/** Ask the venue; if it does not answer, the last answer from the past five minutes, else the error. */
async function info<T>(payload: unknown, ttlMs: number): Promise<T> {
  try {
    // Two tries, not five: a screen would rather say the venue is slow than wait half a minute.
    return await postJson<T>(INFO_URL, payload, ttlMs, TIMEOUT_MS, { attempts: 2 });
  } catch (e) {
    const stale = staleValue<T>(postKey(INFO_URL, payload), STALE_MS);
    if (stale !== undefined) return stale;
    throw e;
  }
}

/** Every live contract, busiest first. Delisted ones are dropped: there is no market to show. */
export async function perpMarkets(): Promise<PerpMarket[]> {
  const [meta, contexts] = await info<[{ universe: Universe[] }, AssetContext[]]>(
    { type: 'metaAndAssetCtxs' },
    MARKETS_TTL_MS,
  );
  const markets: PerpMarket[] = [];
  meta.universe.forEach((u, i) => {
    const ctx = contexts[i];
    if (!ctx || u.isDelisted) return;
    const markPx = Number(ctx.markPx);
    if (!(markPx > 0)) return;
    const prev = Number(ctx.prevDayPx);
    markets.push({
      symbol: u.name,
      markPx,
      oraclePx: Number(ctx.oraclePx),
      change24hPct: prev > 0 ? ((markPx - prev) / prev) * 100 : null,
      fundingRate: Number(ctx.funding),
      openInterestUsd: Number(ctx.openInterest) * markPx,
      dayVolumeUsd: Number(ctx.dayNtlVlm),
      maxLeverage: u.maxLeverage,
    });
  });
  return markets.sort((a, b) => b.dayVolumeUsd - a.dayVolumeUsd);
}

/**
 * The venue's candles for one contract.
 *
 * The window ends at the close of the current candle rather than at `Date.now()`, so the question is
 * the same for a whole candle and the cache can answer it — a window that moved every millisecond
 * would be a new question, and a new request, every time a screen opened.
 */
export async function perpCandles(symbol: string, range: PerpRange, now = Date.now()): Promise<PerpCandles> {
  const { interval, stepMs, count } = RANGE_CANDLES[range];
  const endTime = Math.ceil(now / stepMs) * stepMs;
  const startTime = endTime - count * stepMs;
  const raw = await info<RawCandle[]>(
    { type: 'candleSnapshot', req: { coin: symbol, interval, startTime, endTime } },
    CANDLES_TTL_MS,
  );
  const rows = raw.slice(-count);
  return {
    symbol,
    range,
    interval,
    times: rows.map((r) => r.t),
    bars: rows.map((r) => [Number(r.o), Number(r.h), Number(r.l), Number(r.c)]),
  };
}
