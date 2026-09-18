/**
 * marks.ts — your fills, placed on the chart of the price they happened at (FEATURES.md #9).
 *
 * A fill is a moment, a side and a price. These put one on a line or a candle with nothing chosen by hand: the candle
 * is the one whose stretch of time holds the fill, the place along a line is its time between the two points either
 * side of it, and the height is the price, projected by the chart itself. A fill outside the window a chart shows is
 * not placed at all — the chart says nothing about it, rather than pinning it to an edge it did not happen at.
 *
 * Pure, so every rule here is tested without a renderer.
 */
import { venueNaming } from '../fillVenue';
import { chart } from '../tokens';
import type { Candle } from './projection';

export type MarkSide = 'buy' | 'sell';

/**
 * A fill as a chart takes it: when it settled (ms since the epoch), which way it went, and the price recorded for it —
 * with where it filled and the run that recorded it, when known, for a mark's detail to name.
 */
export interface TimedFill {
  at: number;
  side: MarkSide;
  price: number;
  /** The recorded venue (`uniswap-v3`, `okx-dex`, …). Null or absent: the run recorded none. */
  venue?: string | null;
  /** The run's id, for opening its receipt. */
  id?: string;
}

/** What a mark carries besides where it sits: the fill it stands for, unchanged. */
export interface MarkedFill {
  side: MarkSide;
  price: number;
  /** When the fill settled, as recorded — never the time of the point it was placed beside. */
  at: number;
  venue?: string | null;
  id?: string;
}

/** The fill's own facts, copied onto its mark — absent fields stay absent. */
function carried(f: TimedFill): MarkedFill {
  const m: MarkedFill = { side: f.side, price: f.price, at: f.at };
  if (f.venue !== undefined) m.venue = f.venue;
  if (f.id !== undefined) m.id = f.id;
  return m;
}

/**
 * The stretch of time one candle covers: after `start`, up to and including `end`.
 *
 * Closed at the end because the price feed stamps each row with the moment its period closes (`foldWindowTimed` in
 * src/data/marketData.ts says how that was measured), so a fill at exactly a candle's close is that candle's.
 */
export interface Span {
  start: number;
  end: number;
}

/** A fill on a line. `position` is a fractional point index: 2.5 is halfway between the third and fourth points. */
export interface LineMark extends MarkedFill {
  position: number;
}

/** A fill on a candle chart, in the candle it happened in. */
export interface CandleMark extends MarkedFill {
  index: number;
}

/**
 * A mark's size: the radius of the circle through its three corners. Half again the end dot, so a mark reads as a
 * thing sitting on the line rather than a kink in it, and still smaller than a candle's column on a phone.
 */
export const MARK_RADIUS = chart.area.endDotRadius * 1.5;

/**
 * The line a run of candles draws: the window's first open at its start, then each close at the end of its candle.
 *
 * The asset screen's line was the closes alone, so it began a whole candle into the range its pill names. The change
 * printed above it was already measured from that first open, and a fill in the first stretch had no line to sit on.
 * `candles` and `spans` run in parallel; past the shorter of the two there is nothing to pair.
 */
export function closeLine(
  candles: readonly Pick<Candle, 'open' | 'close'>[],
  spans: readonly Span[],
): { values: number[]; times: number[] } {
  const n = Math.min(candles.length, spans.length);
  if (n === 0) return { values: [], times: [] };
  const values = [candles[0]!.open];
  const times = [spans[0]!.start];
  for (let i = 0; i < n; i++) {
    values.push(candles[i]!.close);
    times.push(spans[i]!.end);
  }
  return { values, times };
}

/**
 * Fills placed along a line whose points were read at `times`, oldest first.
 *
 * Only fills from the first point's time to the last point's: before the line starts or after its newest point there
 * is no line to put them on. That newest point is the feed's newest row, which trails the present by up to a row's
 * length, so a fill from the last few minutes appears once the row that holds it has closed.
 */
export function lineMarks(fills: readonly TimedFill[], times: readonly number[]): LineMark[] {
  const n = times.length;
  if (n === 0) return [];
  const first = times[0]!;
  const last = times[n - 1]!;
  const out: LineMark[] = [];
  for (const f of fills) {
    if (!(f.at >= first && f.at <= last)) continue;
    if (n === 1) {
      out.push({ position: 0, ...carried(f) });
      continue;
    }
    // The segment whose two points bracket the fill.
    let k = 0;
    while (k < n - 2 && times[k + 1]! < f.at) k++;
    const from = times[k]!;
    const to = times[k + 1]!;
    const along = to > from ? Math.min(1, Math.max(0, (f.at - from) / (to - from))) : 0;
    out.push({ position: k + along, ...carried(f) });
  }
  return out;
}

/** Fills placed in the candle whose span holds them. A fill in no candle's span is outside the chart, and left off. */
export function candleMarks(fills: readonly TimedFill[], spans: readonly Span[]): CandleMark[] {
  const out: CandleMark[] = [];
  for (const f of fills) {
    const index = spans.findIndex((s) => f.at > s.start && f.at <= s.end);
    if (index !== -1) out.push({ index, ...carried(f) });
  }
  return out;
}

/**
 * What a mark says when it is inspected: which way the fill went, and where it filled.
 *
 * The venue comes from `venueNaming`, the one place this app names a venue, so an `aave` supply reads "Aave" and is
 * never called a swap or a route — cash went into a lending pool and nothing was traded.
 * A fill whose run recorded no venue says so, rather than borrowing one.
 */
export function markDetail(m: Pick<MarkedFill, 'side' | 'venue'>): { action: string; venue: string; routed?: boolean } {
  const action = m.side === 'buy' ? 'Bought' : 'Sold';
  const naming = venueNaming(m.venue);
  if (naming === undefined) return { action, venue: 'Venue not recorded' };
  return naming.routed === undefined ? { action, venue: naming.label } : { action, venue: naming.label, routed: naming.routed };
}

/** Whether two marks stand for the same fill: the run's id when both have one, else the same moment, side and price. */
export function sameFill(a: MarkedFill, b: MarkedFill): boolean {
  if (a.id !== undefined && b.id !== undefined) return a.id === b.id;
  return a.at === b.at && a.side === b.side && a.price === b.price;
}

/** What a screen reader hears about the marks after the chart's own sentence — "2 buys and 1 sell marked" — or nothing. */
export function describeMarks(marks: readonly { side: MarkSide }[]): string {
  const buys = marks.filter((m) => m.side === 'buy').length;
  const sells = marks.length - buys;
  const parts = [
    buys > 0 ? `${buys} ${buys === 1 ? 'buy' : 'buys'}` : '',
    sells > 0 ? `${sells} ${sells === 1 ? 'sell' : 'sells'}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(' and ')} marked` : '';
}

/**
 * The triangle a mark is drawn as, centred on its point: pointing up for a buy, down for a sell.
 *
 * A shape, not a colour. Green and red on this app mean profit and loss, and a buy is neither; which way the triangle
 * points says which way the trade went, to anyone, whatever colours they can tell apart.
 */
export function markPath(x: number, y: number, side: MarkSide, radius: number = MARK_RADIUS): string {
  // Up the screen is negative y.
  const toApex = side === 'buy' ? -radius : radius;
  // Half the base of an equilateral triangle drawn inside a circle of this radius.
  const half = radius * Math.sin(Math.PI / 3);
  const apex = y + toApex;
  const base = y - toApex / 2;
  return `M ${x},${apex} L ${x + half},${base} L ${x - half},${base} Z`;
}
