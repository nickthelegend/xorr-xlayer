/**
 * What the cost of an xStock order reads as, before anyone confirms it.
 *
 * The ticket shows a size and a button. Between them sits everything that decides what the person
 * ends up holding — the venue's price impact at this size, the tolerance the swap is sent with, the
 * pools it routes through — and a ticket that hides those asks someone to agree to a number it has
 * not shown them.
 *
 * Three rules run through every line here, and each is checked in `breakdown.test.ts`:
 *
 *   1. A figure the venue did not report says so. Never a zero: on this screen "0.00%" reads as
 *      "measured, and it costs nothing", which is the opposite of "we do not know".
 *   2. A percentage is always shown beside what it costs in money. "0.5%" is arithmetic homework;
 *      "at worst $1.25 less" is the same fact already answered.
 *   3. A cost too small to render at the screen's precision is `<0.01%`, not `0.00%` — the second
 *      claims a measurement the number does not support.
 */
import type { XStockQuote, RouteHop } from '@/data/system';

/** What a row says when the venue reported nothing for it. Not a dash, which reads as zero. */
export const NOT_REPORTED = 'Not reported';

/** Below this, a percentage cannot be honestly printed to two places. */
const SMALLEST_SHOWN_PCT = 0.01;

/**
 * A cost as a percentage.
 *
 * Null is "the venue did not say". A positive number under a hundredth of a percent is `<0.01%`,
 * because rounding it to `0.00%` would turn a real cost into a claim that there was none.
 */
export function impactPct(pct: number | null): string {
  if (pct === null) return NOT_REPORTED;
  if (pct > 0 && pct < SMALLEST_SHOWN_PCT) return `<${SMALLEST_SHOWN_PCT.toFixed(2)}%`;
  return `${pct.toFixed(2)}%`;
}

/** Basis points as the percentage a reader thinks in. 50 bps is 0.50%. */
export function slippagePct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * The route, in the venue's own words.
 *
 * Uniswap v3 routes are sequential, not split: the whole order passes through every pool, so a share
 * beside each hop ("100%") would only invite the reader to look for the rest. A single hop is named
 * alone — "Uniswap v3 USDC→TSLAx 0.05%". A path through several pools of one venue reads as the path,
 * joined with arrows — "Uniswap v3 USDC → USDG → NVDAx" — with each pool's fee tier after it, because
 * the tiers are what the hops cost. Hops that do not chain (a venue that reports them unordered) are
 * named one by one, still joined with arrows, since that is the order they were given in.
 */
export function routeLabel(hops: readonly RouteHop[]): string {
  if (hops.length === 0) return NOT_REPORTED;
  if (hops.length === 1) return hops[0]!.label;
  const venue = hops[0]!.venue;
  const chains = hops.every((h, i) => h.venue === venue && (i === 0 || hops[i - 1]!.to === h.from));
  if (!chains || !venue) return hops.map((h) => h.label).join(' → ');
  const path = [hops[0]!.from, ...hops.map((h) => h.to)].join(' → ');
  const fees = hops.map((h) => `${h.feePct}%`).join(' + ');
  return `${venue} ${path} (${fees})`;
}

export type BreakdownRow = {
  label: string;
  value: string;
  /** The same fact in money, where the value is a percentage. Null where there is nothing to add. */
  note: string | null;
  /**
   * Whether this line is a cost the person bears.
   *
   * The screen draws these differently from the plain readings beside them — what you receive is
   * not the same kind of fact as what the route takes off it.
   */
  cost: boolean;
};

/**
 * The breakdown, line by line, in the order it should be read.
 *
 * Money and quantity formatting are passed in rather than imported so this stays a pure list of
 * decisions — which line exists, what it says, and when it admits to not knowing.
 */
export function breakdownRows(
  q: XStockQuote,
  fmt: { money: (n: number) => string; quantity: (n: number) => string; price: (n: number) => string },
): BreakdownRow[] {
  const rows: BreakdownRow[] = [
    {
      label: 'You pay',
      value: `${fmt.quantity(q.pay)} ${q.payToken}`,
      note: null,
      cost: false,
    },
    {
      label: 'Expected',
      value: `${fmt.quantity(q.receive)} ${q.receiveToken}`,
      // What one share works out to once impact is in it, against the pool's own mark.
      note: `${fmt.price(q.effectivePrice)} each · mark ${fmt.price(q.markPrice)}`,
      cost: false,
    },
    {
      label: 'Price impact',
      value: impactPct(q.priceImpactPct),
      note: q.priceImpactUsd === null ? null : `${fmt.money(q.priceImpactUsd)} of this order`,
      cost: true,
    },
    {
      label: 'Max slippage',
      value: slippagePct(q.slippageBps),
      // The percentage already answered: what it costs if the price moves the whole way against you.
      note: `at worst ${fmt.money(q.slippageWorstUsd)} less`,
      cost: true,
    },
    {
      label: 'Venue fee',
      /*
       * Null is nothing taken beyond each pool's own fee tier (named on the Route line), and it is
       * said in a word rather than left off. An absent line reads the same as a line nobody checked.
       */
      value: q.platformFeeUsd === null ? 'None' : fmt.money(q.platformFeeUsd),
      note: null,
      cost: q.platformFeeUsd !== null,
    },
    {
      label: 'Route',
      value: routeLabel(q.hops),
      note: null,
      cost: false,
    },
    {
      label: 'Minimum received',
      value: `${fmt.quantity(q.minimumReceive)} ${q.receiveToken}`,
      // The one number the venue is held to. Less than this and the swap reverts rather than fills.
      note: 'the least this can fill at',
      cost: false,
    },
  ];
  return rows;
}

/**
 * The single sentence above the rows: the worst this order can do.
 *
 * Someone about to commit money reads one thing. Impact and tolerance are both costs and they
 * compound, so the honest summary is the floor — what they are guaranteed, not what is expected.
 */
export function worstCase(
  q: XStockQuote,
  fmt: { quantity: (n: number) => string },
): string {
  return `At worst you get ${fmt.quantity(q.minimumReceive)} ${q.receiveToken}.`;
}
