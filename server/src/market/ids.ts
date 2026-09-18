/**
 * The one place a symbol is mapped to a price feed.
 *
 * This used to be duplicated in three files (client marketData, server prices, backtest engine);
 * they drifted, so a symbol could be tradable on one side and unpriceable on the other.
 */
export const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'ripple',
  DOGE: 'dogecoin',
  HYPE: 'hyperliquid',
  AAVE: 'aave',
  LINK: 'chainlink',
  TON: 'the-open-network',
  /*
   * Gold, priced as gold.
   *
   * The contract screen used to map XAUT to BITCOIN to get a number out of a feed that had
   * no entry for it — so it read "XAUT/USDT $79,900" while gold traded near $4,400. Nothing
   * about Bitcoin's price, funding or open interest says anything about gold, and a "proxy
   * feed" label does not make another asset's number true. Both of these are one-ounce
   * gold-backed tokens and both have their own feed.
   */
  XAUT: 'tether-gold',
  PAXG: 'pax-gold',
  // Base-native assets the delegation actually trades.
  WETH: 'weth',
  USDC: 'usd-coin',
  CBBTC: 'coinbase-wrapped-btc',
};

export function knownSymbols(): string[] {
  return Object.keys(COINGECKO_IDS);
}

/**
 * The one upstream URL, for the same reason there is one id map.
 *
 * There were two. `routes/market.ts` asked for `…&include_24hr_change=true` and
 * `market/prices.ts` asked for the same ids without it — two URLs, and `http/get.ts` keys
 * its cache, its in-flight dedupe and its stale-value window by URL. So the screens warmed
 * one entry and the executor's `priceOf` missed on the other, went upstream every single
 * time, and paid the rate-limit ladder: ~1.1s spacing, then 1.6s and 3.2s of backoff behind
 * two 429s. Measured from Railway that is 8.4s per price, which is how a check with an 8s
 * deadline came back `price deadline for BTC` while `/market/quotes` answered in 0.4s.
 *
 * The 24h change is a superset — the body carries `usd` either way — so one URL serves both
 * and halves what we ask of a tier that rate-limits us. A screen refreshing a chart now warms
 * the price the scheduler is about to fill at.
 */
export const COINGECKO_PRICE_URL =
  'https://api.coingecko.com/api/v3/simple/price' +
  `?ids=${[...new Set(Object.values(COINGECKO_IDS))].join(',')}` +
  '&vs_currencies=usd&include_24hr_change=true';

/** The shape that URL returns. */
export type CoingeckoPrices = Record<string, { usd?: number; usd_24h_change?: number }>;

/**
 * Every logo in one request, for exactly the reason above.
 *
 * `/coins/{id}` returns a logo but costs one rate-limited request per symbol, and the lane in
 * `http/get.ts` serialises them per host — so thirteen crypto rows meant thirteen queued calls,
 * each riding the 429 ladder to about twenty-eight seconds. `/coins/markets` answers for all of
 * them at once, and `market_data` is already in the response whether we read it or not.
 */
export const COINGECKO_IMAGE_URL =
  'https://api.coingecko.com/api/v3/coins/markets' +
  `?vs_currency=usd&ids=${[...new Set(Object.values(COINGECKO_IDS))].join(',')}` +
  '&per_page=250&page=1&sparkline=false&locale=en';

/** The subset of that response this reads. */
export type CoingeckoMarket = { id?: string; image?: string };
