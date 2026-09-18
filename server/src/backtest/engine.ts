/**
 * The backtest engine — PLAN.md 12.22 / 9.14, closing [G32].
 *
 * Screen 17's copy promises "run against real history at your current limits". The handoff
 * shipped four hardcoded rows. This replays a strategy over REAL price history from the same feed
 * the app quotes, at the user's ACTUAL daily cap, and returns computed statistics plus an equity
 * curve in the 360x110 viewBox design.md §6 specifies.
 *
 * It is deliberately conservative: fees and slippage are charged on every fill, and the result
 * carries a disclaimer, because screen 17 also says "Nothing here is a promise."
 */
import { getJson } from '../http/get.js';
import { COINGECKO_IDS } from '../market/ids.js';

const COINGECKO = 'https://api.coingecko.com/api/v3';

/*
 * The canonical map, not a second copy of it.
 *
 * This module kept its own nine-entry table with no WETH and no cbBTC — the two symbols the
 * executor actually trades — so backtesting the thing a user was about to run returned "no price
 * history for WETH". A private duplicate of a shared fact is a bug waiting for the shared fact to
 * grow, and this one had already been waiting.
 */
const IDS = COINGECKO_IDS;

/** Every window a backtest can replay. A route that takes one from a caller refuses anything else by name. */
export const LOOKBACKS = ['30d', '90d', '6m', '1y'] as const;
export type Lookback = (typeof LOOKBACKS)[number];

export function isLookback(value: string): value is Lookback {
  return (LOOKBACKS as readonly string[]).includes(value);
}

const DAYS: Record<Lookback, number> = { '30d': 30, '90d': 90, '6m': 180, '1y': 365 };

/**
 * The days a lookback spans — or a throw, never NaN.
 *
 * `DAYS['7d']` is undefined, and undefined days ran every replay loop zero times: `GET /agents/:id/backtest` published
 * 0% over 0 trades for a window that does not exist. The routes refuse such a lookback by name; this refuses it for any
 * caller that did not.
 */
function daysOf(lookback: Lookback): number {
  if (!isLookback(lookback)) throw new Error(`There is no ${String(lookback)} backtest window.`);
  return DAYS[lookback];
}

/** design.md §6 "Area / equity curve". */
/** About this many points survive the downsample — see `curvePoints`. */
const CURVE_POINTS = 40;

export type BacktestResult = {
  lookback: Lookback;
  ret: number;
  maxDd: number;
  sharpe: number;
  trades: number;
  /**
   * The equity series, downsampled for drawing. NUMBERS, not an SVG polyline.
   *
   * This used to be `curve: string` — the executor projected the series into a 360×110
   * viewBox and shipped that. Two things were wrong with it: the executor was doing the
   * chart's job (and had to know the chart's dimensions to do it), and the real values were
   * discarded, so the client could not label an axis, show a tooltip, or say what the line
   * was worth at any point. The chart scales a series itself; give it the series.
   */
  equity: number[];
  /** Honesty fields the UI can surface — a backtest with no context is a sales pitch. */
  feed: 'live';
  source: string;
  disclaimer: string;
};

const cache = new Map<string, { at: number; prices: [number, number][] }>();
const TTL_MS = 10 * 60_000;

/**
 * Daily closes for a symbol, cached and sliced from one long fetch.
 *
 * Exported because tier 6 needs the same series this file already fetches, and a second fetcher
 * would be a second answer to "what did this asset do" — two components disagreeing about history
 * is worse than either being slightly stale.
 */
export async function history(symbol: string, days: number): Promise<[number, number][]> {
  const id = IDS[symbol];
  if (!id) throw new Error(`No price history for ${symbol}`);
  const key = `${id}:${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.prices;

  /*
   * One request per symbol, ever — the longest window, sliced.
   *
   * A longer series contains every shorter one, so there is no reason to ask the upstream twice.
   * It used to fetch per lookback, and against a tier that rate-limits each cold call waited out
   * its own retry ladder: a first `90d` backtest measured **118 seconds**, then `1y` another 63,
   * on a screen that promises "run against real history at your current limits". Fetching the
   * full span once makes the first backtest of a symbol the only slow one and every other
   * lookback instant — and it makes them provably the same data over different spans rather than
   * separate fetches that could disagree.
   */
  const cached = [...cache.entries()].find(
    ([k, e]) =>
      k.startsWith(`${id}:`) &&
      Date.now() - e.at < TTL_MS &&
      Number(k.slice(id.length + 1)) >= days,
  );
  if (cached) {
    const slice = cached[1].prices.slice(-(days + 1));
    if (slice.length >= 5) {
      cache.set(key, { at: cached[1].at, prices: slice });
      return slice;
    }
  }

  /** The longest span the app offers. Asking for it is what makes every other lookback free. */
  const span = Math.max(...Object.values(DAYS));

  /*
   * No `interval=daily` — the granularity is ours to impose.
   *
   * `interval=daily` is a paid-plan parameter on CoinGecko's public API: a keyless caller sending
   * it is making a request it is not entitled to, which is one more way for a lookback to fail
   * that has nothing to do with the data being available.
   *
   * But it was doing real work. Without it the API granulates by range — hourly from 2 to 90
   * days, daily beyond — so a 90-day backtest silently became 2,160 hourly points and ran
   * twenty-four times as many buys as a weekly schedule should. Asking for the range and taking
   * one sample per day gives the same series the parameter would have, from data we are allowed
   * to ask for.
   */
  const json = await getJson<{ prices?: [number, number][] }>(
    `${COINGECKO}/coins/${id}/market_chart?vs_currency=usd&days=${span}`,
    // History changes once a day; caching it hard is both correct and kind to the upstream.
    10 * 60_000,
  );
  const full = daily(json.prices ?? []);
  if (full.length < 5) throw new Error(`not enough history for ${symbol}`);
  cache.set(`${id}:${span}`, { at: Date.now(), prices: full });
  const prices = full.slice(-(days + 1));
  cache.set(key, { at: Date.now(), prices });
  return prices;
}

/**
 * One sample per UTC day — the last of each, which is that day's close.
 *
 * A no-op on a series that is already daily, so the same code serves every lookback.
 */
export function daily(points: [number, number][]): [number, number][] {
  const byDay = new Map<number, [number, number]>();
  for (const p of points) byDay.set(Math.floor(p[0] / 86_400_000), p);
  return [...byDay.values()].sort((a, b) => a[0] - b[0]);
}

/**
 * Downsample an equity series for drawing, keeping the LAST point.
 *
 * A 365-point line is unreadable at phone width, so it thins to about 40 — but the final
 * value is the one the screen quotes beside the chart, so it is always kept: a line that
 * ends a stride short of the real close disagrees with the number next to it.
 */
export function curvePoints(equity: readonly number[], target = CURVE_POINTS): number[] {
  if (equity.length === 0) return [];
  const stride = Math.max(1, Math.floor(equity.length / target));
  const out: number[] = [];
  for (let i = 0; i < equity.length; i += stride) out.push(equity[i]!);
  const last = equity[equity.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export function maxDrawdown(equity: readonly number[]): number {
  let peak = equity[0] ?? 0;
  let worst = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? ((v - peak) / peak) * 100 : 0;
    if (dd < worst) worst = dd;
  }
  return worst;
}

/** Annualised Sharpe from daily returns, zero risk-free rate. */
export function sharpeRatio(dailyReturns: readonly number[]): number {
  if (dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyReturns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (mean / sd) * Math.sqrt(365);
}

const FEE_PCT = 0.001; // 0.1%, matching the order ticket
const SLIPPAGE_PCT = 0.0005;

/**
 * Replay a recurring buy over real history.
 * `perRun` is capped by the user's actual daily cap — screen 17 promises "at your current limits".
 */
export async function backtestDca(params: {
  symbol: string;
  lookback: Lookback;
  perRunUsd: number;
  dailyCapUsd: number;
  everyNDays: number;
}): Promise<BacktestResult> {
  const days = daysOf(params.lookback);
  const prices = await history(params.symbol, days);
  const perRun = Math.min(params.perRunUsd, params.dailyCapUsd);

  let units = 0;
  let invested = 0;
  let trades = 0;
  const equity: number[] = [];

  for (let i = 0; i < prices.length; i++) {
    const px = prices[i]![1];
    if (i % params.everyNDays === 0) {
      const effective = px * (1 + SLIPPAGE_PCT);
      const spend = perRun * (1 - FEE_PCT);
      units += spend / effective;
      invested += perRun;
      trades += 1;
    }
    equity.push(units * px);
  }

  const finalValue = equity[equity.length - 1] ?? 0;
  const ret = invested > 0 ? ((finalValue - invested) / invested) * 100 : 0;

  // Drawdown and Sharpe measure the VALUE of what is held, net of contributions, so a schedule
  // that keeps adding capital does not look like a rising strategy when it is only a rising float.
  const perUnit = prices.map(([, p]) => p);
  const dailyReturns: number[] = [];
  for (let i = 1; i < perUnit.length; i++) {
    dailyReturns.push((perUnit[i]! - perUnit[i - 1]!) / perUnit[i - 1]!);
  }

  return {
    lookback: params.lookback,
    ret: Number(ret.toFixed(1)),
    maxDd: Number(maxDrawdown(perUnit).toFixed(1)),
    sharpe: Number(sharpeRatio(dailyReturns).toFixed(1)),
    trades,
    equity: curvePoints(equity),
    feed: 'live',
    source: 'coingecko market_chart, daily closes',
    disclaimer: 'Nothing here is a promise.',
  };
}

export type GridBacktest = BacktestResult & {
  /** How much of the window the price actually spent inside the band. */
  inRangePct: number;
  buys: number;
  sells: number;
  /** Units still held at the end — the position a broken range leaves you with. */
  unitsLeft: number;
  /** What those units are worth at the last price, and what they cost. */
  leftValue: number;
  leftCost: number;
};

/**
 * A grid, replayed over real daily closes.
 *
 * This is the tier where a backtest earns its keep. A grid's entire risk is the assumption in its
 * own description — that the range holds — and that is a question about history, not about the
 * future: "over the last ninety days, how much of the time was the price actually inside the band
 * I am about to draw?" A user who sees 41% has learned something a projection could never tell
 * them.
 *
 * It replays the SAME rules the executor runs: rungs are crossings, a rung is bought once, a rise
 * closes the cheapest lot, and the whole thing stops outside the band. A backtest of different
 * rules than the ones that will run is worse than none, because it is believed.
 */
export async function backtestGrid(params: {
  symbol: string;
  lookback: Lookback;
  lower: number;
  upper: number;
  steps: number;
  usdPerStep: number;
}): Promise<GridBacktest> {
  const { lower, upper, steps, usdPerStep } = params;
  const prices = await history(params.symbol, daysOf(params.lookback));
  const rungs = Array.from({ length: steps + 1 }, (_, i) => lower + (i * (upper - lower)) / steps);
  const levelOf = (px: number) => rungs.filter((r) => px >= r).length - 1;

  /** Open lots, keyed by the rung they were bought at, holding the units acquired there. */
  const lots = new Map<number, number>();
  let lastLevel: number | null = null;
  let invested = 0;
  let realised = 0;
  let buys = 0;
  let sells = 0;
  let inRange = 0;
  const equity: number[] = [];

  for (const [, px] of prices) {
    const inside = px >= lower && px <= upper;
    if (inside) inRange += 1;

    if (!inside) {
      // Outside the band the executor stops. Holding still has value, so the curve continues.
      equity.push([...lots.values()].reduce((a, u) => a + u * px, 0) + realised);
      continue;
    }

    const level = levelOf(px);
    if (lastLevel === null) {
      lastLevel = level;
    } else if (level < lastLevel && !lots.has(level)) {
      const effective = px * (1 + SLIPPAGE_PCT);
      const spend = usdPerStep * (1 - FEE_PCT);
      lots.set(level, spend / effective);
      invested += usdPerStep;
      buys += 1;
      lastLevel = level;
    } else if (level > lastLevel && lots.size > 0) {
      // The cheapest lot, exactly as the planner does — it is the one the rise has made a profit
      // on, and closing the newest instead books the smallest gain available.
      const cheapest = Math.min(...lots.keys());
      const units = lots.get(cheapest)!;
      lots.delete(cheapest);
      const effective = px * (1 - SLIPPAGE_PCT);
      realised += units * effective * (1 - FEE_PCT);
      sells += 1;
      lastLevel = level;
    } else if (level !== lastLevel) {
      lastLevel = level;
    }

    equity.push([...lots.values()].reduce((a, u) => a + u * px, 0) + realised);
  }

  const lastPx = prices[prices.length - 1]?.[1] ?? 0;
  const unitsLeft = [...lots.values()].reduce((a, u) => a + u, 0);
  const leftValue = unitsLeft * lastPx;
  const finalValue = leftValue + realised;
  const ret = invested > 0 ? ((finalValue - invested) / invested) * 100 : 0;

  const perUnit = prices.map(([, p]) => p);
  const dailyReturns: number[] = [];
  for (let i = 1; i < perUnit.length; i++) {
    dailyReturns.push((perUnit[i]! - perUnit[i - 1]!) / perUnit[i - 1]!);
  }

  return {
    lookback: params.lookback,
    ret: Number(ret.toFixed(1)),
    maxDd: Number(maxDrawdown(equity.length ? equity : perUnit).toFixed(1)),
    sharpe: Number(sharpeRatio(dailyReturns).toFixed(1)),
    trades: buys + sells,
    buys,
    sells,
    equity: curvePoints(equity),
    inRangePct: prices.length ? Number(((inRange / prices.length) * 100).toFixed(0)) : 0,
    unitsLeft: Number(unitsLeft.toFixed(6)),
    leftValue: Number(leftValue.toFixed(2)),
    /*
     * What the open lots COST, not what they are worth.
     *
     * The difference between these two is the honest answer to "what happens if the range breaks",
     * and it is the number a grid's marketing never shows.
     */
    leftCost: Number((lots.size * usdPerStep).toFixed(2)),
    feed: 'live',
    source: 'coingecko market_chart, daily closes',
    disclaimer: 'Nothing here is a promise. A range that held is not a range that will hold.',
  };
}

/**
 * The replay itself, with no network in it.
 *
 * Split out so the rule can be tested against a series constructed to trigger it, rather than
 * against whatever the last 90 days of a live market happened to do. A backtest whose only proof
 * is "it returned a number" is not proof that it implements the strategy on the tin — and the bug
 * this replaces was exactly that: four agents, four plausible numbers, one wrong strategy.
 *
 * `days` is how many bars to REPORT on; anything before that is warm-up the windows need in order
 * for the first reported bar to be testable at all.
 */
export function momentumReplay(
  closes: readonly number[],
  opts: { days: number; window: number; stopPct: number; size: number },
): { equity: number[]; trades: number } {
  const { days, window, stopPct, size } = opts;

  let cash = size;
  let units = 0;
  let stop = 0;
  let trades = 0;
  const equity: number[] = [];

  const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const start = Math.max(window + 1, closes.length - days);

  for (let i = start; i < closes.length; i++) {
    const px = closes[i]!;

    if (units > 0) {
      // The stop is checked before any new signal: a position that should already be closed
      // cannot also be the reason not to open another.
      if (px <= stop) {
        cash += units * px * (1 - SLIPPAGE_PCT) * (1 - FEE_PCT);
        units = 0;
        stop = 0;
        trades += 1;
      }
    } else {
      // The window EXCLUDES the bar being tested — a close compared to a high it set itself
      // always breaks out. Same slice the live planner takes.
      const prior = closes.slice(i - window, i);
      const high = Math.max(...prior);
      const fast = mean(closes.slice(i - Math.max(3, Math.floor(window / 4)), i));
      const slow = mean(prior);
      if (px > high && fast > slow && cash > 0) {
        const effective = px * (1 + SLIPPAGE_PCT);
        units = (cash * (1 - FEE_PCT)) / effective;
        stop = px * (1 - stopPct / 100);
        cash = 0;
        trades += 1;
      }
    }

    equity.push(cash + units * px);
  }

  return { equity, trades };
}

/**
 * Momentum, replayed rather than approximated.
 *
 * `GET /agents/:id/backtest` ran `backtestDca` for every agent — and, because `const id = await
 * walletId(c)` shadowed the route param, without ever reading which agent was asked for. So the
 * Momentum Scout's published track record was a weekly $50 buy of SOL, and so was everyone else's:
 * four agents, one number, none of them the strategy named above it.
 *
 * This runs tier 6's ACTUAL rule from `executor/kinds/index.ts` over the same `daily(history())`
 * series the live planner reads, bar by bar:
 *
 *   - flat, and the close is above the highest close of the preceding `lookbackDays` window
 *     (excluding the bar being tested — a bar compared to a high it set itself always breaks out),
 *     and the fast average is above the slow one: enter.
 *   - open, and the close is at or below the stop set `stopPct` under the entry: exit there.
 *
 * The one deviation from live is deliberate and stated: the planner reads an intraday `priceOf()`
 * for its entry, and history only has closes, so a backtest cannot know where inside the day the
 * break happened. Both fills take the close, with the same fee and slippage the other engines use.
 * That is a real limitation of daily data, not a modelling choice — and it is why a stop can only
 * be checked once a day here, which flatters the result on a gap down. Said plainly rather than
 * smoothed over.
 */
export async function backtestMomentum(params: {
  symbol: string;
  lookback: Lookback;
  usdPerEntry: number;
  dailyCapUsd: number;
  lookbackDays?: number;
  stopPct?: number;
}): Promise<BacktestResult> {
  const window = Math.floor(params.lookbackDays ?? 20);
  const stopPct = params.stopPct ?? 8;
  const size = Math.min(params.usdPerEntry, params.dailyCapUsd);

  /*
   * Enough history to test the FIRST bar of the requested window, not just to fill it.
   *
   * Asking for 30 days and starting the replay on day 21 would report a "30-day backtest" that
   * looked at nine days. The warm-up is fetched on top of the window and then skipped.
   */
  const days = daysOf(params.lookback);
  const prices = daily(await history(params.symbol, days + window + 1));
  const closes = prices.map(([, p]) => p);
  const { equity, trades } = momentumReplay(closes, { days, window, stopPct, size });

  const first = equity[0] ?? size;
  const last = equity[equity.length - 1] ?? size;
  const ret = first > 0 ? ((last - first) / first) * 100 : 0;

  /*
   * Measured on the STRATEGY's equity, not the asset's.
   *
   * `backtestDca` deliberately measures drawdown and Sharpe per-unit, because a schedule that
   * keeps adding capital would otherwise look like a rising strategy when it is a rising float.
   * Momentum contributes once and then sits in cash between entries, so its own equity curve is
   * the honest series here — and the flat stretches are part of what the strategy IS. Using the
   * asset's series instead would report the drawdown of holding, which this does not do.
   */
  const dailyReturns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!;
    if (prev > 0) dailyReturns.push((equity[i]! - prev) / prev);
  }

  return {
    lookback: params.lookback,
    ret: Number(ret.toFixed(1)),
    maxDd: Number(maxDrawdown(equity).toFixed(1)),
    sharpe: Number(sharpeRatio(dailyReturns).toFixed(1)),
    trades,
    equity: curvePoints(equity),
    feed: 'live',
    source: `coingecko market_chart, daily closes · ${window}-day breakout, ${stopPct}% stop`,
    disclaimer:
      'Entries and stops fill at the daily close, so a stop is only checked once a day. Nothing here is a promise.',
  };
}
