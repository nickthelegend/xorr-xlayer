/**
 * Writing down what the xStocks cost, on a schedule, so a band can exist at all.
 *
 * `xStockPriceUsd` records every reading it takes — but only when something asks, and until now
 * nothing asked on a timer. So `price_observations` filled only as a side effect of somebody
 * opening a screen, and the agent's range strategies, which need six readings before a high and a
 * low count as a band, stood down on assets nobody had looked at.
 *
 * Found by driving the demo end to end: NVDAx had five recorded readings and TSLAx had two, so even
 * with every other gate clear the momentum and accumulate branches had nothing to work from.
 *
 * ## Why this is paced rather than per-tick
 *
 * The scheduler ticks every thirty seconds and there are eleven xStocks, which would be more than
 * thirty thousand Jupiter quotes a day to build a series whose own window is a month. A reading
 * every few minutes is a denser series than the range logic can use and is still polite to the
 * venue. The interval is the unit of resolution, not a rate limit worked around.
 *
 * ## What it does not do
 *
 * It does not invent a reading when the venue does not answer. `xStockPriceUsd` returns null for a
 * symbol it cannot route, and a gap in the series is the honest record of a gap in what was
 * knowable — the whole reason the range logic counts observations rather than assuming a shape.
 */
import { log } from '../http/request-id.js';
import { XSTOCKS, xStockPriceUsd } from '../venues/xstocks.js';

/** How often a symbol is priced for the record. */
export const OBSERVE_EVERY_MS = Number(process.env.OBSERVE_EVERY_MS ?? 5 * 60_000);

let lastRunAt = 0;

/** Testing only — the module-level clock would otherwise carry one case into the next. */
export function resetObserveClock(): void {
  lastRunAt = 0;
}

export type ObserveResult = { asked: number; recorded: number; unpriced: string[] };

/**
 * One pass over the universe, or nothing if the last pass was recent.
 *
 * Returns what it did rather than logging and swallowing it, so the scheduler can report a sweep
 * that priced nothing as distinct from one that did not run.
 */
export async function observeSweep(now: Date = new Date()): Promise<ObserveResult | null> {
  if (now.getTime() - lastRunAt < OBSERVE_EVERY_MS) return null;
  lastRunAt = now.getTime();

  const symbols = Object.keys(XSTOCKS);
  const unpriced: string[] = [];
  let recorded = 0;

  for (const symbol of symbols) {
    /*
     * The read IS the write: `xStockPriceUsd` records what it sees. Asking is the whole job, and
     * a failure is a symbol this venue could not price right now rather than something to retry
     * into a number.
     */
    const price = await xStockPriceUsd(symbol).catch(() => null);
    if (price === null || !(price > 0)) unpriced.push(symbol);
    else recorded += 1;
  }

  if (unpriced.length > 0) {
    log.info(`[observe] priced ${recorded}/${symbols.length}; no route for ${unpriced.join(', ')}`);
  }
  return { asked: symbols.length, recorded, unpriced };
}
