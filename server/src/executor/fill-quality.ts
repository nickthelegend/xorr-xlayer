/**
 * How far each fill landed from the market price at the moment the run decided to trade.
 *
 * WHAT THE REFERENCE IS — stated first, because it was described wrongly when this shipped.
 * `quoted_units` is the `units` value `run.ts` computes before sending: `usd / priceOf(symbol)`,
 * the amount of the asset the LIVE MARKET PRICE implied at decision time. It is not any venue's
 * own quote. That makes this implementation shortfall against the arrival price — the standard,
 * venue-neutral measure of execution — and it is what makes venues comparable at all: measuring
 * the aggregator against its own quote would be the aggregator grading itself.
 *
 * The trail already names the venue that settled every trade. That is a label. This is the claim:
 * how many basis points of the market each venue actually delivered, over real fills.
 *
 * Reported signed, from the taker's point of view: **positive means the fill bought more of the
 * asset than the market price implied**. Negative is the cost. "30 bps of slippage" and "+30 bps"
 * are opposite facts about the same trade, so the sign is always shown.
 *
 * WHAT THIS NUMBER IS NOT, ON A FORK
 *
 * The market price comes from a live feed; a fork is pinned at a block, so its pools have drifted
 * from the market the price describes. On `base-fork` the figure therefore mixes venue quality
 * with however far the fork has moved — and with the pricing of whichever maker happened to ship a
 * book. The first measurements came out at **SwapVM +71 bps** and **Aqua −308 bps**, and neither
 * is a ranking of the venues. `basis` says which situation produced the figure so a reader is never
 * left to guess; on Base mainnet, where price and fill describe the same market, it means what it
 * says.
 */
import { query } from '../db/index.js';
import { THIS_CHAIN } from '../db/chain-scope.js';
import { CHAIN_KEY } from '../evm/chains.js';

export type VenueQuality = {
  venue: string;
  /** `crypto` or `equity`: tokenized equities fill against other liquidity and are not averaged in with crypto (PLAN.md 2.9). */
  assetClass: string;
  /** How many of `fills` were sales, measured by the USDC they paid. */
  sells: number;
  /** Fills with BOTH a quote and a measured delta. Rows predating migration 012 are excluded. */
  fills: number;
  /** Mean signed difference from the arrival price, in basis points. Positive = more asset than the price implied. */
  meanBps: number;
  /** The worst single fill, which a mean hides and a user cares about. */
  worstBps: number;
  bestBps: number;
};

export type FillQuality = {
  venues: VenueQuality[];
  /** Fills that could be measured at all — the denominator behind every figure above. */
  measured: number;
  /** Fills recorded before the quote was kept. Stated rather than quietly dropped. */
  unmeasurable: number;
  /**
   * Whether the quote and the fill describe the same chain.
   *
   * `same-chain` — the market price and the fill describe the same chain. The figure is execution quality.
   * `forked` — the price is the live market and the fill executed against a pinned block, so the
   * figure also carries however far the fork has drifted. Not a smaller number; a different one.
   */
  basis: 'same-chain' | 'forked';
};

export async function fillQuality(): Promise<FillQuality> {
  /*
   * Only rows where the comparison is real.
   *
   * `quoted_units > 0` excludes both the pre-migration rows and any fill whose quote was never
   * established — dividing by that would produce an infinity and a very confident chart.
   */
  const rows = await query<FillRow>(
    `SELECT venue, side, asset_class, quoted_units::text, units::text, quoted_usd::text, usd::text
       FROM strategy_runs
      WHERE status = 'filled' AND chain = ${THIS_CHAIN}
        AND side IS DISTINCT FROM 'supply'`,
    [],
  );

  /*
   * A supply is not a fill against a market.
   *
   * 100 USDC into Aave is 100 aUSDC by construction, so its "distance from the arrival price" is
   * zero every time — a figure that says nothing about execution and drags whichever venue it is
   * filed under toward zero. It was filed under `1inch`. It is excluded, not re-labelled into the
   * table, because there is nothing about it to measure.
   */
  const trades = rows.filter((r) => r.venue !== 'aave');

  const groups = new Map<string, { venue: string; assetClass: string; bps: number[]; sells: number }>();
  let unmeasurable = 0;
  for (const r of trades) {
    const bps = shortfallBps(r);
    if (bps === undefined) {
      unmeasurable += 1;
      continue;
    }
    const venue = r.venue ?? 'unrecorded';
    const assetClass = r.asset_class ?? 'unrecorded';
    const key = `${venue}|${assetClass}`;
    const group = groups.get(key) ?? { venue, assetClass, bps: [], sells: 0 };
    group.bps.push(bps);
    if (r.side === 'sell') group.sells += 1;
    groups.set(key, group);
  }

  const venues: VenueQuality[] = [...groups.values()]
    .map((g) => ({
      venue: g.venue,
      assetClass: g.assetClass,
      fills: g.bps.length,
      sells: g.sells,
      meanBps: Math.round((g.bps.reduce((a, b) => a + b, 0) / g.bps.length) * 10) / 10,
      worstBps: Math.round(Math.min(...g.bps) * 10) / 10,
      bestBps: Math.round(Math.max(...g.bps) * 10) / 10,
    }))
    // Most fills first: a venue with one lucky fill should not lead a table about consistency.
    .sort((a, b) => b.fills - a.fills);

  return {
    venues,
    measured: venues.reduce((n, v) => n + v.fills, 0),
    unmeasurable,
    basis: CHAIN_KEY === 'xlayer' ? 'same-chain' : 'forked',
  };
}

type FillRow = {
  venue: string | null;
  side: string | null;
  asset_class: string | null;
  quoted_units: string | null;
  units: string | null;
  quoted_usd: string | null;
  usd: string | null;
};

/**
 * One fill's distance from the arrival price, signed so that positive is better for the taker — or
 * undefined when it cannot be measured.
 *
 * A buy is measured in the asset: units that arrived against the units the price implied. A sale is
 * measured in what it paid: USDC that arrived against the USDC the price implied (PLAN.md 2.9). Sales
 * were compared in the asset they sold, which the delegation moves exactly, so every one scored zero.
 * A sale with no quote — recorded before one was kept, or whose proceeds could not be read back — is
 * unmeasurable, not perfect.
 */
export function shortfallBps(r: FillRow): number | undefined {
  const [quoted, filled] =
    r.side === 'sell' ? [Number(r.quoted_usd), Number(r.usd)] : [Number(r.quoted_units), Number(r.units)];
  if (!Number.isFinite(quoted) || !Number.isFinite(filled) || quoted <= 0 || filled <= 0) return undefined;
  return ((filled - quoted) / quoted) * 10_000;
}
