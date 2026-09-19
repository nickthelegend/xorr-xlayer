/**
 * Live market data for the app — PLAN.md 12.12 / 12.14, closing part of [G22] and [G8].
 *
 * Everything here goes through the executor's public `/market/*` routes rather than straight to
 * CoinGecko. That is not indirection for its own sake: CoinGecko sends no
 * `access-control-allow-origin`, so the direct call failed the CORS preflight on web and every
 * quote and candle silently degraded to simulated. Behind the executor there is also one shared
 * rate-limit queue instead of one per open tab, and a stale-value fallback that keeps a slightly
 * old price on screen rather than a dash.
 *
 * PLAN.md §1.3 item 8: "Every price on screen is real, or labelled." Anything this module cannot
 * price comes back absent, and the screen says there is no price rather than showing one.
 */
import type { Bar, Candles, Timeframe } from './types';
import { API_BASE } from './apiBase';

/**
 * Which symbols have a real price feed — asked of the server, never restated here.
 *
 * This was a second copy of `server/src/market/ids.ts`, and it drifted exactly as that file's
 * own comment warns: XAUT and PAXG were given real gold feeds on the server and never added
 * here, so `fetchQuotes` filtered them out before the request and the commodities tab kept
 * showing the fixture's $3,412.10 for gold while the feed said $4,420. A symbol being
 * priceable is a fact about the server's configuration; asking is the only way to not be
 * wrong about it.
 *
 * One call, cached for the session. Until it answers, nothing is filtered out — the server
 * omits symbols it cannot price anyway, so the cost of guessing wrong in this direction is a
 * slightly longer query string, and in the other direction it was a year-old price on screen.
 */
let feedSymbols: Set<string> | undefined;
let feedSymbolsInFlight: Promise<Set<string>> | undefined;

export async function pricedSymbols(): Promise<Set<string>> {
  if (feedSymbols) return feedSymbols;
  feedSymbolsInFlight ??= getJson<string[]>('/market/symbols', 10 * 60_000)
    .then((list) => (feedSymbols = new Set(list)))
    .catch(() => {
      feedSymbolsInFlight = undefined;
      // Unknown, not empty. Returning an empty set here would filter every symbol out and turn
      // one failed request into a screen with no prices at all.
      return new Set<string>();
    });
  return feedSymbolsInFlight;
}

/** Testing only. */
export function resetPricedSymbols(): void {
  feedSymbols = undefined;
  feedSymbolsInFlight = undefined;
}

export type Quote = { price: number; change24h: number; source: 'coingecko' | 'uniswap-v3' };

/**
 * A short client-side cache on top of the server's own. Two components mounting on the same screen
 * should not produce two round trips for the same symbol list.
 */
const TTL_MS = 15_000;
/** How many times to wait out a "warming" 503 before handing the state to the screen. */
const WARMING_RETRIES = 4;

/**
 * The executor is fetching this from upstream and has not finished.
 *
 * Its own error type so a screen can say "fetching" rather than "there is nothing here" — the
 * difference between a wait and a dead end.
 */
export class StillWarming extends Error {
  constructor(path: string) {
    super(`still warming: ${path}`);
    this.name = 'StillWarming';
  }
}
const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

async function getJson<T>(path: string, ttlMs = TTL_MS): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;

  const pending = inflight.get(path);
  if (pending) return pending as Promise<T>;

  const run = (async () => {
    try {
      // A 503 means the executor is still fetching this entry from the upstream, not that the
      // data does not exist. It arrives with a Retry-After, so wait it out — rendering "no chart"
      // for something a few seconds away is a worse lie than a brief spinner.
      for (let attempt = 0; attempt < WARMING_RETRIES; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15_000);
        try {
          const res = await fetch(`${API_BASE}${path}`, {
            signal: ctrl.signal,
            headers: { accept: 'application/json' },
          });
          // A 503 is always "still warming", on the last attempt as much as the first. Falling
          // through to the generic error on the final try meant the caller saw a plain Error, the
          // `instanceof StillWarming` check failed, and the screen said "no feed" for data that
          // was seconds away — the exact confusion this state exists to prevent.
          if (res.status === 503) {
            if (attempt === WARMING_RETRIES - 1) throw new StillWarming(path);
            const after = Number(res.headers.get('retry-after'));
            await new Promise((r) =>
              setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : 2_000),
            );
            continue;
          }
          if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
          const value = (await res.json()) as T;
          cache.set(path, { at: Date.now(), value });
          return value;
        } finally {
          clearTimeout(timer);
        }
      }
      // Unreachable: the loop either returns, throws, or continues.
      throw new StillWarming(path);
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, run);
  return run;
}

/** Testing/diagnostics only. */
export function clearMarketDataCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Spot quotes for any symbols we have a feed for. Unknown symbols are omitted.
 *
 * Throws `StillWarming` when the executor is fetching from upstream, so a caller can tell "not
 * yet" from "no feed" — the price is the number a user reads first, and labelling one that is
 * seconds away as unavailable is the more expensive of the two mistakes.
 */
export async function fetchQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  const priced = await pricedSymbols();
  const known = priced.size === 0 ? symbols : symbols.filter((s) => priced.has(s));
  /*
   * The tokenized equities are priced too, just not by the same feed.
   *
   * `/market/symbols` lists what CoinGecko covers, which is crypto — so every equity was filtered
   * out here and `usePrice` returned nothing for them. The market list did not show it, because
   * it merges `/market/stocks` itself; every other screen did. The order ticket read **"No live
   * NVDAx price"** directly above the route's minimum out in NVDAx, quoting a real route for an
   * asset it had just called unpriced, on the buy screen for the whole stocks track.
   *
   * `/market/stocks` derives its price from a real Uniswap v3 quote, which is the right number
   * anyway: what the user pays is what the X Layer pools give, not the NYSE print.
   */
  const wantsStocks = symbols.some((s) => !priced.has(s) && STOCK_SUFFIX.test(s));
  const [live, stocks] = await Promise.all([
    known.length
      ? getJson<Record<string, Quote>>(
          `/market/quotes?symbols=${encodeURIComponent(known.join(','))}`,
        )
      : Promise.resolve({} as Record<string, Quote>),
    wantsStocks ? fetchStockQuotes().catch(() => ({}) as Record<string, StockQuote>) : Promise.resolve({} as Record<string, StockQuote>),
  ]);

  const out: Record<string, Quote> = { ...live };
  for (const sym of symbols) {
    const s = stocks[sym];
    // A null price means nothing routes right now, which is a real "no price" and stays one.
    if (!out[sym] && s?.price != null) {
      // No 24h change: a swap quote is one observation, and deriving a delta from it would be
      // the same invention the rest of this file exists to avoid.
      out[sym] = { price: s.price, change24h: 0, source: 'uniswap-v3' };
    }
  }
  return out;
}

/** `NVDAx`, `TSLAx` — a ticker with the lowercase `x` that marks the wrapped xStock. */
const STOCK_SUFFIX = /^[A-Z]{1,6}x$/;

/**
 * Is this a tokenized share — priced by the route that would fill it, not by the crypto feed?
 *
 * Exported so a screen can ask each symbol's own source instead of one request that waits for both:
 * the share snapshot has measured eight seconds on the hosted executor, and every crypto price on
 * the same screen sat behind it.
 */
export function isStockSymbol(symbol: string): boolean {
  return STOCK_SUFFIX.test(symbol);
}

/** design.md §6 renders 12 candles. */
export const CANDLE_COUNT = 12;

/** `[time ms, open, high, low, close]`, oldest first — the feed's rows as the executor relays them. */
export type OhlcRow = readonly [number, number, number, number, number];

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How many days of history each timeframe asks for when it is read as a WINDOW, folded to the 12
 * candles the design draws. [G8]: the handoff shipped one 12-bar series and the pills were decorative.
 *
 * This is what `repos.markets.candles` means by a timeframe, and Portfolio reads it that way: `1H` is the
 * day of closes on each position card. A pill that promises candles of a length reads `fetchChartCandles`
 * below, and a range that promises a span reads `fetchHistory`.
 *
 * `15m` asks for nothing. It fetched the same day as `1H` under another name, so the two pills drew
 * the same chart: the feed's finest rows are thirty minutes long, and there is nothing finer to fold.
 */
const TIMEFRAME_DAYS: Readonly<Record<Timeframe, number | null>> = {
  '15m': null,
  '1H': 1,
  '4H': 7,
  '1D': 30,
  '1W': 90,
};

/** Fold bars into one: first open, max high, min low, last close. */
function fold(bars: readonly Bar[]): Bar {
  return [
    bars[0]![0],
    Math.max(...bars.map((b) => b[1])),
    Math.min(...bars.map((b) => b[2])),
    bars[bars.length - 1]![3],
  ];
}

/** Fold n raw OHLC bars into `count` equal candles, newest last. A remainder at the old end is dropped. */
export function aggregateBars(raw: Bar[], count = CANDLE_COUNT): Bar[] {
  if (raw.length === 0) return [];
  if (raw.length <= count) return raw.slice(-count);
  const size = Math.floor(raw.length / count);
  const out: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const start = raw.length - (count - i) * size;
    const slice = raw.slice(Math.max(0, start), Math.max(0, start) + size);
    if (slice.length === 0) continue;
    out.push(fold(slice));
  }
  return out;
}

/**
 * Fold a whole window into at most `count` candles, newest last, keeping all of it.
 *
 * `aggregateBars` drops the rows that do not divide evenly, so a week of four-hour rows drew six days.
 * A range is a promise about how far back the chart reaches — "past week" — so here the oldest candle
 * may be short instead, and the first open is the window's own.
 */
export function foldWindow(raw: readonly Bar[], count = CANDLE_COUNT): Bar[] {
  if (raw.length <= count) return raw.slice();
  const size = Math.ceil(raw.length / count);
  const out: Bar[] = [];
  for (let end = raw.length; end > 0; end -= size) {
    out.unshift(fold(raw.slice(Math.max(0, end - size), end)));
  }
  return out;
}

/** The feed's rows for a symbol, or null when nothing on this server prices it. */
async function fetchRows(symbol: string, days: number): Promise<OhlcRow[] | null> {
  if (isStockSymbol(symbol)) return fetchObservedRows(symbol, days);
  const priced = await pricedSymbols();
  if (priced.size > 0 && !priced.has(symbol)) return null;
  const { rows } = await getJson<{ rows: OhlcRow[] }>(
    `/market/ohlc?symbol=${encodeURIComponent(symbol)}&days=${days}`,
    60_000,
  );
  return rows;
}

/**
 * A wrapped xStock's rows: the prices this deployment recorded for it (`/market/stocks/history`), each reading a row
 * whose open, high, low and close are that one price.
 *
 * No market-data feed carries these tokens, so `/market/ohlc` answers `no_feed` for every one, and the asset screen
 * said "No chart yet." under a live price — for the assets this product is about — while the executor held a
 * thousand readings of each. A reading is a real quote of the pool a fill would use; nothing between them is drawn.
 * An empty history is `[]`, which the screen shows as no chart yet — true then.
 */
async function fetchObservedRows(symbol: string, days: number): Promise<OhlcRow[]> {
  const { points } = await getJson<{ points: { at: number; usd: number }[] }>(
    `/market/stocks/history?symbol=${encodeURIComponent(symbol)}&hours=${Math.round(days * 24)}`,
    60_000,
  );
  return points
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.usd) && p.usd > 0)
    .map((p) => [p.at, p.usd, p.usd, p.usd, p.usd] as const);
}

const toBar = (r: OhlcRow): Bar => [r[1], r[2], r[3], r[4]];

/** Real OHLC for a symbol over a timeframe's window, folded to the 12 candles the design draws. */
export async function fetchCandles(symbol: string, timeframe: Timeframe): Promise<Candles | null> {
  const days = TIMEFRAME_DAYS[timeframe];
  if (days === null) return null;
  const rows = await fetchRows(symbol, days);
  if (!rows) return null;
  const bars = aggregateBars(rows.map(toBar));
  if (bars.length === 0) return null;
  return { symbol, timeframe, bars, feed: 'live' };
}

/** The timeframes a chart can draw as candles of exactly that length. */
export type ChartTimeframe = '1H' | '4H' | '1D';

/**
 * Candles as long as the pill says, and the window whose rows they are cut from.
 *
 * The feed decides what is possible. Through the executor it answers a day in thirty-minute rows, a
 * week or a month in four-hour rows, and ninety days in four-day rows (measured 2026-09-14). So an hour
 * is two rows of a day, four hours one row of a week, and a day six rows of a month. A 15-minute candle
 * would be finer than any row, and four-day rows cannot be cut into weeks, so neither is offered: the
 * chart's pills used to include both, drawn from other lengths.
 */
export const CHART_PLAN: Readonly<Record<ChartTimeframe, { days: number; candleMs: number }>> = {
  '1H': { days: 1, candleMs: HOUR_MS },
  '4H': { days: 7, candleMs: 4 * HOUR_MS },
  '1D': { days: 30, candleMs: DAY_MS },
};

export const CHART_TIMEFRAMES = Object.keys(CHART_PLAN) as ChartTimeframe[];

/** The usual gap between rows. The median, so one missing row does not change the answer. */
function rowStep(rows: readonly OhlcRow[]): number {
  const gaps = rows
    .slice(1)
    .map((r, i) => r[0] - rows[i]![0])
    .filter((g) => g > 0)
    .sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 0;
}

/**
 * Cut rows into `count` candles of exactly `candleMs`, newest last — or none, when the rows cannot make
 * candles that long.
 *
 * Grouped by time rather than by position, so a missing row thins one candle instead of shifting every
 * candle after it into the wrong hour. A candle shorter than a row, or one that is not a whole number of
 * rows, would be a different length from its label, and the answer then is no candles at all. The
 * oldest candle is left out when the rows stop partway through it, for the same reason.
 */
export function candlesOfLength(rows: readonly OhlcRow[], candleMs: number, count = CANDLE_COUNT): Bar[] {
  if (rows.length < 2) return [];
  const step = rowStep(rows);
  if (!(step > 0) || candleMs < step || candleMs % step !== 0) return [];

  const newest = rows[rows.length - 1]![0];
  const buckets = new Map<number, Bar[]>();
  for (const r of rows) {
    const age = Math.floor((newest - r[0]) / candleMs);
    if (age >= count) continue;
    buckets.set(age, [...(buckets.get(age) ?? []), toBar(r)]);
  }

  const reach = Math.floor((newest - rows[0]![0]) / candleMs);
  const out: Bar[] = [];
  for (let age = count - 1; age >= 0; age--) {
    const bars = buckets.get(age);
    if (!bars) continue;
    if (age === reach && bars.length < candleMs / step) continue;
    out.push(fold(bars));
  }
  return out;
}

/** Candles exactly as long as `timeframe`, or null when nothing prices the symbol. See `CHART_PLAN`. */
export async function fetchChartCandles(symbol: string, timeframe: ChartTimeframe): Promise<Bar[] | null> {
  const plan = CHART_PLAN[timeframe];
  const rows = await fetchRows(symbol, plan.days);
  return rows ? candlesOfLength(rows, plan.candleMs) : null;
}

/** How far back a price chart reaches. */
export type HistoryRange = '1D' | '1W' | '1M' | '1Y';

/**
 * Days per range.
 *
 * `1Y` asked for ninety days, and so did `All`, and the asset screen called them "past year" and "all
 * time". A year is 365 days, which the feed serves in four-day rows. The public price tier keeps no
 * more than a year of history, so there is no "all time" to ask it for.
 */
export const HISTORY_DAYS: Readonly<Record<HistoryRange, number>> = {
  '1D': 1,
  '1W': 7,
  '1M': 30,
  '1Y': 365,
};

/** A whole range of history, folded to at most 12 candles, or null when nothing prices the symbol. */
export async function fetchHistory(symbol: string, range: HistoryRange): Promise<Bar[] | null> {
  const rows = await fetchRows(symbol, HISTORY_DAYS[range]);
  return rows ? foldWindow(rows.map(toBar)) : null;
}

/**
 * A candle of a range, and the stretch of time it covers: after `start`, up to and including `end`.
 *
 * The feed stamps each row with the moment its period CLOSES. CoinGecko documents it that way, and it was measured
 * through the executor on 2026-09-14: ETH's four-hour row stamped 00:00 UTC is exactly the eight thirty-minute rows
 * stamped 20:30 to 00:00 — the open of the 20:30 row (2505.45), the close of the 00:00 one (2476.32), and the high and
 * low of all eight. So a row stamped `t` is the price from one row's length before `t` up to `t`.
 */
export type TimedBar = { bar: Bar; start: number; end: number };

/**
 * `foldWindow`, keeping the time each candle covers — the same candles bar for bar, so a chart that places a fill or
 * names the moment under a finger draws exactly what the untimed fold drew.
 *
 * A candle ends at its last row's stamp and starts where the candle before it ended, so the candles tile the window
 * with no gap for a fill to fall through, across a missing row too. The oldest starts one row before its first stamp.
 */
export function foldWindowTimed(rows: readonly OhlcRow[], count = CANDLE_COUNT): TimedBar[] {
  if (rows.length === 0) return [];
  const step = rowStep(rows);
  const size = rows.length <= count ? 1 : Math.ceil(rows.length / count);
  const groups: OhlcRow[][] = [];
  for (let end = rows.length; end > 0; end -= size) {
    groups.unshift(rows.slice(Math.max(0, end - size), end));
  }
  const out: TimedBar[] = [];
  for (const group of groups) {
    const start = out.length === 0 ? group[0]![0] - step : out[out.length - 1]!.end;
    out.push({ bar: fold(group.map(toBar)), start, end: group[group.length - 1]![0] });
  }
  return out;
}

/** A whole range with each candle's time: `fetchHistory` for a chart that marks fills or can be scrubbed. */
export async function fetchTimedHistory(symbol: string, range: HistoryRange): Promise<TimedBar[] | null> {
  const rows = await fetchRows(symbol, HISTORY_DAYS[range]);
  return rows ? foldWindowTimed(rows) : null;
}

/**
 * One of this wallet's fills as a chart marks it: when it settled, which way it went, the price recorded for it, and
 * where it filled (`strategy_runs.venue`, null on a run that recorded none). `id` is the run, for opening its receipt.
 */
export type RecordedFill = { at: number; side: 'buy' | 'sell'; price: number; venue: string | null; id?: string };

/**
 * The fields of a `/runs` row a fill is read from.
 *
 * `side` is optional because `StrategyRunRow` in src/data/system.ts does not declare it, though the executor sends it
 * with every run (PLAN.md 3.1): `buy`, `sell`, or `supply` for cash put to work, which is not a trade in the asset.
 */
export type FillRun = {
  id?: string;
  symbol: string;
  status: string;
  side?: string | null;
  price: number | null;
  finishedAt: string | null;
  /** Where it filled — `uniswap-v3`, `okx-dex`, `aave`, or an older run's venue. Absent or null: not recorded. */
  venue?: string | null;
};

/**
 * This wallet's buys and sells of one token, oldest first, from its runs (FEATURES.md #9).
 *
 * Filled runs only, a buy or a sell only, and only with a price and the time the fill settled: without any one of
 * those there is nothing true to place, and a mark put somewhere near is a guess drawn on a price chart. `symbol` is
 * the token a market settles as — BTC's fills are XBTC's — matched without case, since a route param may spell
 * `xbtc` or `NVDAX`. Manual buys and sales are here as well: the executor records each as a one-off strategy's run.
 *
 * A rebalance's legs are not. Its runs carry the strategy's own symbol, `PORTFOLIO`, rather than the token each leg
 * traded, so no asset's chart can claim them.
 */
export function fillsOf(runs: readonly FillRun[], symbol: string): RecordedFill[] {
  const token = symbol.toUpperCase();
  const out: RecordedFill[] = [];
  for (const r of runs) {
    if (r.status !== 'filled' || r.symbol.toUpperCase() !== token) continue;
    if (r.side !== 'buy' && r.side !== 'sell') continue;
    const at = r.finishedAt === null ? Number.NaN : Date.parse(r.finishedAt);
    if (!Number.isFinite(at) || r.price === null || !(r.price > 0)) continue;
    const venue = typeof r.venue === 'string' && r.venue.trim() !== '' ? r.venue : null;
    const fill: RecordedFill = { at, side: r.side, price: r.price, venue };
    if (r.id !== undefined) fill.id = r.id;
    out.push(fill);
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * From when a list of runs is known to hold every fill, or null when it holds all of them.
 *
 * `/runs` answers the newest `limit` runs, newest first. Fewer than that is the whole record. A full page is not: a
 * run older than the oldest one here may exist and be missing, so a chart stretch before it is unknown rather than
 * empty — and a screen that drew it unmarked without saying so would be claiming nothing filled there.
 */
export function fillsKnownFrom(runs: readonly { at: string }[], limit: number): number | null {
  if (runs.length < limit) return null;
  let oldest = Number.POSITIVE_INFINITY;
  for (const r of runs) {
    const t = Date.parse(r.at);
    if (Number.isFinite(t) && t < oldest) oldest = t;
  }
  // A full page with no readable time at all says nothing about where the record starts: treat all of it as unknown.
  return Number.isFinite(oldest) ? oldest : Number.POSITIVE_INFINITY;
}

export type StockQuote = {
  symbol: string;
  name: string;
  address: string;
  /** USD per share, derived from a real Uniswap v3 quote. Null when nothing routes right now. */
  price: number | null;
  venues: string[];
  feed: 'live' | 'unavailable';
};

/**
 * Tokenized equities, priced off the venue that would fill the trade.
 *
 * These have no CoinGecko feed, and the NYSE print would be the wrong number anyway: what a user
 * pays is what the Uniswap v3 pools on X Layer give. The executor derives the price from a real quote.
 */
export async function fetchStockQuotes(): Promise<Record<string, StockQuote>> {
  const rows = await getJson<StockQuote[]>('/market/stocks', 30_000);
  return Object.fromEntries(rows.map((r) => [r.symbol, r]));
}


/**
 * A day of closes per symbol, for the 90×30 glyph in a market row.
 *
 * One request for the whole screen. Nine rows asking `/market/ohlc` individually would be nine
 * round trips for data the server already holds in one cache, and the cost of a sparkline is
 * entirely in the requests.
 *
 * Symbols still warming are absent from the response, and absent is what the row renders — no
 * glyph. `Sparkline` draws nothing below two points, which is the honest picture; a flat line
 * would claim the price did not move.
 */
export async function fetchSparklines(symbols: string[]): Promise<Record<string, number[]>> {
  const priced = await pricedSymbols();
  const known = priced.size === 0 ? symbols : symbols.filter((s) => priced.has(s));
  if (known.length === 0) return {};
  return getJson<Record<string, number[]>>(
    `/market/sparklines?symbols=${encodeURIComponent(known.join(','))}`,
    60_000,
  );
}
