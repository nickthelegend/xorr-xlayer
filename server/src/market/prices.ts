/**
 * Prices for the executor. The same real source the app uses (CoinGecko), so a quote shown to the
 * user and a fill recorded by the executor come from the same place.
 */
import { getJson, staleValue } from '../http/get.js';
import { StillFetching, beforeDeadline } from '../http/deadline.js';
import { COINGECKO_IDS, COINGECKO_PRICE_URL, type CoingeckoPrices } from './ids.js';
import { isStock, stockPriceUsd } from '../venues/stocks.js';
import { feedFor } from './feeds.js';

const IDS = COINGECKO_IDS;

/** A price this old is still better than a missed scheduled buy. */
const STALE_TOLERANCE_MS = 10 * 60_000;

/**
 * One URL for every symbol, so a price is a cache hit rather than a queue slot.
 *
 * Asking per symbol meant each one was its own URL, its own cache entry and its own trip through
 * the rate limiter — the leaderboard prices a handful of symbols and took over thirty seconds from
 * cold.
 *
 * It now comes from `ids.ts`, and it is the same string `/market/quotes` uses — see the note
 * there for why having two of them cost the executor 8.4s a price.
 */
const ALL_IDS_URL = COINGECKO_PRICE_URL;

/**
 * @param deadlineMs How long the CALLER is willing to wait.
 *
 * The executor should wait: a scheduled buy that gives up because a price tier was busy is a
 * missed buy. A screen should not: the leaderboard blocked for sixty seconds on a cold cache while
 * the user looked at a spinner. Same function, different patience, stated at the call site.
 *
 * Past the deadline: the last price within `STALE_TOLERANCE_MS`, or `StillFetching`. That was a bare
 * `price deadline for X`, which nothing could tell apart from a symbol with no feed at all, so a balance counted a price
 * that was only late as $0.
 */
export async function priceOf(symbol: string, deadlineMs?: number): Promise<number> {
  const late = () => new StillFetching(`the price of ${symbol}`);
  /*
   * Tokenized equities are priced by the venue that would fill them, not by a market-data feed.
   *
   * `IDS` is CoinGecko's table and has no equities in it, so this threw `No price feed for NVDAc`
   * for every one of the eight — and with it went the executor's ability to size, cap-check or
   * record an equity trade at all. The failure surfaced the first time tier 7 tried to open a real
   * position, which is the one strategy whose entire remit is equities. The UI had the number all
   * along, from `/market/stocks`; the executor could not reach it.
   *
   * Held to the caller's deadline too. The deadline raced only the CoinGecko fetch below, so an equity waited out the
   * 1inch lane whatever its caller had said — which is why `/wallet/tokens` wraps every price in a race of its own.
   */
  const feed = feedFor(symbol);

  /*
   * A tokenized equity on Solana, priced by the Jupiter route that would fill it.
   *
   * The same read `executor/place.ts` marks a fill against, so an alert on NVDAx watches the number
   * a buy of it would actually pay rather than a second opinion about the same asset. `xStockPriceUsd`
   * answers null when nothing will route — never a zero — and a missing price is an error here,
   * because every caller of `priceOf` is about to size, cap-check or compare against it.
   */
  if (feed === 'xstock') {
    // Imported here rather than at the top: the Solana venue pulls in a web3 connection, and the
    // EVM callers of this module must not pay for it to ask CoinGecko what ETH costs.
    const { xStockPriceUsd } = await import('../venues/xstocks.js');
    const px = await beforeDeadline(xStockPriceUsd(symbol), deadlineMs, late);
    if (px && px > 0) return px;
    throw new Error(`No route for ${symbol} right now, so it has no price to trade against.`);
  }

  if (feed === 'equity') {
    const px = await beforeDeadline(stockPriceUsd(symbol), deadlineMs, late);
    if (px && px > 0) return px;
    throw new Error(`No route for ${symbol} right now, so it has no price to trade against.`);
  }

  const id = IDS[symbol];
  if (!id) throw new Error(`No price feed for ${symbol}`);
  const url = ALL_IDS_URL;

  // A value already in hand beats waiting, whatever the caller's patience.
  const warm = staleValue<CoingeckoPrices>(url, 30_000);
  if (warm?.[id]?.usd !== undefined) return warm[id]!.usd!;

  let json: CoingeckoPrices;
  try {
    // A fetch the deadline outruns keeps going in the background, so the next caller is instant (`beforeDeadline`).
    json = await beforeDeadline(getJson<CoingeckoPrices>(url, 30_000), deadlineMs, late);
  } catch (e) {
    // Every retry failed, or the caller stopped waiting. Fall back to the last good value within a bounded window, rather
    // than dropping a scheduled buy because a public price tier was busy.
    const stale = staleValue<CoingeckoPrices>(url, STALE_TOLERANCE_MS);
    if (!stale) throw e;
    json = stale;
  }
  const price = json[id]?.usd;
  if (typeof price !== 'number') throw new Error(`No price returned for ${symbol}`);
  return price;
}

export function knownSymbols(): string[] {
  return Object.keys(IDS);
}
