/**
 * A symbol's range as this app has recorded it (`price_observations`), for the assets no feed hands a history for —
 * the wrapped xStocks, which trade on X Layer and nowhere CoinGecko lists them. The autonomous agent and the proposer
 * read the same band, so they cannot disagree about where a price sits in it.
 */
import { query } from '../db/index.js';

/**
 * How far back a range is drawn. A month of readings, matching what the asset screen charts.
 *
 * Not a risk knob. How much history to LOOK at is a question about the asset; how much of it is
 * enough to act on is the question the profile answers, and that is `minObservations`.
 */
export const RANGE_HOURS = 24 * 30;

/**
 * The high and the low this app has actually seen for a symbol, or null when it has not seen enough.
 *
 * Null is the point. The previous version of this derived a "30-day range" as current price ±8%,
 * which put every asset at exactly the 50th percentile of a band that was a restatement of its own
 * price — so "breaking out near the upper band" was a sentence about arithmetic, not about the
 * market, and the two branches that read it could never fire.
 */
export async function observedRange(
  symbol: string,
  minObservations: number,
): Promise<{ high: number; low: number } | null> {
  const rows = await query<{ usd: string }>(
    `SELECT usd FROM price_observations
      WHERE symbol = $1 AND at > now() - ($2 || ' hours')::interval`,
    [symbol, String(RANGE_HOURS)],
  ).catch(() => []);

  const prices = rows.map((r) => Number(r.usd)).filter((n) => Number.isFinite(n) && n > 0);
  if (prices.length < minObservations) return null;

  const high = Math.max(...prices);
  const low = Math.min(...prices);
  return high > low ? { high, low } : null;
}
