/**
 * One symbol's spot price, from the source that prices it — or null when nothing does.
 *
 * `usePrice` reads `repos.markets.quotes`, which answers a failed request with no price, so an outage
 * read as "No price feed". Here a failed read throws, and the screen can say it did not load.
 *
 * A tokenized share asks only the share snapshot, and anything else only the crypto feed. The snapshot
 * has taken eight seconds on the hosted executor, and a crypto price has no reason to wait for it.
 */
import { fetchQuotes, fetchStockQuotes, isStockSymbol } from '@/data/marketData';

export type SpotQuote = { price: number; change24h?: number };

export async function quoteOf(symbol: string): Promise<SpotQuote | null> {
  if (isStockSymbol(symbol)) {
    const row = (await fetchStockQuotes())[symbol];
    // A share with no route right now has no price. That is an answer, not a failure, and it has no
    // 24h change: a swap quote is one observation.
    return row?.price != null ? { price: row.price } : null;
  }
  const q = (await fetchQuotes([symbol]))[symbol];
  return q ? { price: q.price, change24h: q.change24h } : null;
}
