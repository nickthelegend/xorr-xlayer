/**
 * projection.ts — the candle projection, design.md §6 verbatim.
 *
 * "Author OHLC in **price space**, then project to percentage of the plot box. Never hand
 * -place pixels." Everything a chart draws comes out of these functions: give it prices,
 * it gives back a fraction of the box, and the component multiplies by the height it was
 * actually laid out at.
 *
 *   const y = v => ((hi - v) / (hi - lo)) * 100;   // price → % from top
 *
 *   const up   = close >= open;
 *   const bodyTop = y(Math.max(open, close));
 *   const bodyH   = Math.max(1.4, y(Math.min(open, close)) - bodyTop);  // 1.4% floor = doji
 *   const wickTop = y(high);
 *   const wickH   = y(low) - wickTop;
 *
 * **Two projections, deliberately.** Using one for both is a bug: the wide scale flattens
 * the candles, the tight scale pushes the TP marker off-canvas.
 */
import { chart } from '../tokens';

/** OHLC in price space. Nothing here is a pixel. */
export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  /** Optional, for the volume row under the candles. */
  volume?: number;
}

/**
 * The app's own bar shape — `[open, high, low, close]`, which is what every candle API on
 * the wire returns and what `data/types.ts` carries. The chart set works in named fields
 * because `c.high` at a call site is unambiguous where `c[1]` is not; this is the one place
 * the two shapes meet, so no screen has to remember which index is the low.
 */
export type Ohlc = readonly [open: number, high: number, low: number, close: number];

export function toCandles(bars: readonly Ohlc[]): Candle[] {
  return bars.map(([open, high, low, close]) => ({ open, high, low, close }));
}

/** The price bounds of a plot box. */
export interface Projection {
  hi: number;
  lo: number;
}

/**
 * Tight — the pro chart. Candles fill the box.
 *
 * The padding is relative (2026-09-12): a fifth of the series' own range, or a tenth of a percent of
 * the price when the range is flat, capped at `chart.candle.tightPad`. The prototype's ±120 is still
 * exactly what a $66k series gets; a $126 coin now fills the box instead of drawing as one line.
 *
 * `alsoPrices` are kept in frame too: the prices of the fills marked on the chart (FEATURES.md #9). A fill is
 * nearly always inside its candle's range, but a sale is recorded at what it measured after fees, and a fork's
 * pools can lag the feed the candles come from. Rather than draw that mark off the chart, or leave it off, the
 * candles make room for it — on the one projection both are drawn with.
 */
export function tightProjection(series: readonly Candle[], alsoPrices: readonly number[] = []): Projection {
  const { maxHigh, minLow } = extent(series, alsoPrices);
  const pad = Math.min(
    chart.candle.tightPad,
    Math.max(
      (maxHigh - minLow) * chart.candle.tightPadOfRange,
      Math.abs(maxHigh) * chart.candle.tightPadOfPrice,
    ),
  );
  return { hi: maxHigh + pad, lo: minLow - pad };
}

/**
 * Wide — Auto Close. `hi = max(maxHigh, tpPrice) + 150`, `lo = min(minLow, slPrice) − 150`.
 * The bounds follow the TP/SL prices so both markers stay in frame at any setting.
 */
export function wideProjection(
  series: readonly Candle[],
  tpPrice: number,
  slPrice: number,
): Projection {
  const { maxHigh, minLow } = extent(series);
  return {
    hi: Math.max(maxHigh, tpPrice) + chart.candle.widePad,
    lo: Math.min(minLow, slPrice) - chart.candle.widePad,
  };
}

function extent(
  series: readonly Candle[],
  alsoPrices: readonly number[] = [],
): { maxHigh: number; minLow: number } {
  if (series.length === 0 && alsoPrices.length === 0) return { maxHigh: 1, minLow: 0 };
  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (const c of series) {
    if (c.high > maxHigh) maxHigh = c.high;
    if (c.low < minLow) minLow = c.low;
  }
  for (const p of alsoPrices) {
    if (p > maxHigh) maxHigh = p;
    if (p < minLow) minLow = p;
  }
  return { maxHigh, minLow };
}

/** price → % from the top of the plot box. */
export function toPct(p: Projection, value: number): number {
  const span = p.hi - p.lo;
  if (span === 0) return 50;
  return ((p.hi - value) / span) * 100;
}

/** The geometry of one candle, in % of the plot box. */
export interface CandleGeometry {
  up: boolean;
  bodyTopPct: number;
  bodyHeightPct: number;
  wickTopPct: number;
  wickHeightPct: number;
}

export function candleGeometry(p: Projection, c: Candle): CandleGeometry {
  const up = c.close >= c.open;
  const bodyTop = toPct(p, Math.max(c.open, c.close));
  const bodyBottom = toPct(p, Math.min(c.open, c.close));
  const wickTop = toPct(p, c.high);
  return {
    up,
    bodyTopPct: bodyTop,
    /* The 1.4% floor is what keeps a doji visible instead of collapsing to nothing. */
    bodyHeightPct: Math.max(chart.candle.bodyMinPct, bodyBottom - bodyTop),
    wickTopPct: wickTop,
    wickHeightPct: toPct(p, c.low) - wickTop,
  };
}

export function projectSeries(
  p: Projection,
  series: readonly Candle[],
): CandleGeometry[] {
  return series.map((c) => candleGeometry(p, c));
}

/**
 * Price-axis labels, derived from the active projection — never hardcoded.
 * `[0, .25, .5, .75, 1].map(t => hi − t * (hi − lo))`.
 */
export function axisPrices(p: Projection): number[] {
  return chart.candle.axisTicks.map((t) => p.hi - t * (p.hi - p.lo));
}

/**
 * The default axis formatter: thousands, one decimal, `K`. state.md's formatting rules
 * apply to values the user acts on; an axis is a scale, so it abbreviates. Pass your own
 * for an instrument that doesn't trade in thousands.
 */
export function defaultAxisFormat(price: number): string {
  return `${(price / 1000).toFixed(1)}K`;
}

export function axisLabels(
  p: Projection,
  format: (price: number) => string = defaultAxisFormat,
): string[] {
  return axisPrices(p).map(format);
}
