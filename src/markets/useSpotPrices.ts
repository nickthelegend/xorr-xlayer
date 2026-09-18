/**
 * Spot prices for a list of symbols, each waiting only for its own source.
 *
 * `usePrices` prices every symbol in one request, and a request that includes a share waits for the
 * share snapshot — eight seconds on the hosted executor, signed in or not — so on the watchlist SOL and
 * HYPE sat at "· · ·" behind TSLAc. It also answers a failed request with no prices. Here the crypto
 * feed and the snapshot are separate reads, and a failure is reported.
 */
import {
  fetchQuotes,
  fetchStockQuotes,
  isStockSymbol,
  type Quote,
  type StockQuote,
} from '@/data/marketData';
import type { SpotQuote } from './quote';
import { useLiveRead } from './useLiveRead';

export type SpotPrice = { loading: true } | { loading: false; quote: SpotQuote | null };

export function useSpotPrices(symbols: readonly string[]) {
  const feedKey = symbols.filter((s) => !isStockSymbol(s)).join(',');
  const hasShares = symbols.some((s) => isStockSymbol(s));

  const feed = useLiveRead(
    () => (feedKey ? fetchQuotes(feedKey.split(',')) : Promise.resolve({} as Record<string, Quote>)),
    [feedKey],
  );
  const shares = useLiveRead(
    () => (hasShares ? fetchStockQuotes() : Promise.resolve({} as Record<string, StockQuote>)),
    [hasShares],
  );

  /** A read still out, or one answering an earlier list, is loading — never "no price". */
  function priceOf(symbol: string): SpotPrice {
    if (isStockSymbol(symbol)) {
      if (shares.loading || !shares.data) return { loading: true };
      const row = shares.data[symbol];
      return { loading: false, quote: row?.price != null ? { price: row.price } : null };
    }
    if (feed.loading || !feed.data) return { loading: true };
    const q = feed.data[symbol];
    return { loading: false, quote: q ? { price: q.price, change24h: q.change24h } : null };
  }

  return {
    priceOf,
    error: feed.error ?? shares.error,
    reload: () => {
      if (feed.error) feed.reload();
      if (shares.error) shares.reload();
    },
  };
}
