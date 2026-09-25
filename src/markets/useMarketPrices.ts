/**
 * The catalog's prices as two reads that do not wait for each other — the crypto feed and the share
 * snapshot — so each class draws as soon as its own source answers. See `prices.ts`.
 *
 * `stocks: false` is for a screen that has no use for share prices: Movers ranks by the day's change,
 * and a share has none, so asking would only add the slowest read in the app to a screen that ignores it.
 */
import { useMemo } from 'react';
import { shownClasses } from '@/data/fixtures/markets';
import { fetchQuotes, fetchStockQuotes, type StockQuote } from '@/data/marketData';
import { FEED_SYMBOLS, priceClasses, sourceOf, type PricedClass } from './prices';
import { useLiveRead } from './useLiveRead';

export type MarketClass = PricedClass & { reload: () => void };

export function useMarketPrices(options: { stocks?: boolean } = {}): MarketClass[] {
  const withStocks = options.stocks !== false;
  const feed = useLiveRead(() => fetchQuotes([...FEED_SYMBOLS]), []);
  const stocks = useLiveRead(
    () => (withStocks ? fetchStockQuotes() : Promise.resolve({} as Record<string, StockQuote>)),
    [withStocks],
  );

  const { data: feedData, error: feedError, reload: reloadFeed } = feed;
  const { data: stockData, error: stockError, reload: reloadStocks } = stocks;

  return useMemo(() => {
    const classes = shownClasses.filter((c) => withStocks || sourceOf(c) === 'feed');
    return priceClasses(
      classes,
      { data: feedData, error: feedError },
      { data: stockData, error: stockError },
    ).map((c) => ({ ...c, reload: sourceOf(c) === 'stocks' ? reloadStocks : reloadFeed }));
  }, [withStocks, feedData, feedError, stockData, stockError, reloadFeed, reloadStocks]);
}
