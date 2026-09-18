/**
 * The market catalog with its prices, each class priced by the one source that prices it.
 *
 * `repos.markets.listClasses` asks both sources and waits for both, so the whole Markets list sat on the
 * share snapshot — eight seconds on the hosted executor — before crypto, commodities, indices or pre-IPO
 * could draw a row. It also turns a failed read into a list of dashes, so the error state written for it
 * could never show. Here a class follows only its own read, and a failed read is a failure.
 *
 * The merge is the one `listClasses` applies, kept pure so it can be tested without a network.
 */
import { assetClasses } from '@/data/fixtures/markets';
import { isStockSymbol, type Quote, type StockQuote } from '@/data/marketData';
import type { AssetClass, Instrument } from '@/data/types';
import { percent, price as fmtPrice } from '@/format';

/** Which read prices a class: the crypto feed, or the snapshot of what a share buy would cost. */
export type PriceSource = 'feed' | 'stocks';

export function sourceOf(cls: AssetClass): PriceSource {
  return cls.instruments.some((i) => isStockSymbol(i.sym)) ? 'stocks' : 'feed';
}

/**
 * Every catalog symbol the crypto feed could price: all but the shares.
 *
 * Asked all at once, like `listClasses`: `/market/quotes` leaves out what it has no feed for, so gold
 * gets its real price and an index simply gets none.
 */
export const FEED_SYMBOLS: readonly string[] = assetClasses
  .flatMap((c) => c.instruments)
  .map((i) => i.sym)
  .filter((s) => !isStockSymbol(s));

/** One instrument with whatever priced it. With no answer for it, a live instrument shows a dash, never the catalog's number. */
export function priceInstrument(
  i: Instrument,
  live: Readonly<Record<string, Quote>>,
  stocks: Readonly<Record<string, StockQuote>>,
): Instrument {
  const s = stocks[i.sym];
  if (s) {
    // No 24h change: a swap quote is one observation, and a delta from one would be invented.
    return s.price === null
      ? { ...i, px: '—', chg: '', feed: 'unavailable' }
      : { ...i, px: fmtPrice(s.price), chg: '', feed: 'live' };
  }
  const q = live[i.sym];
  if (!q) return i.feed === 'live' ? { ...i, px: '—', chg: '', feed: 'unavailable' } : i;
  return {
    ...i,
    px: fmtPrice(q.price),
    chg: percent(q.change24h, { digits: 2 }),
    up: q.change24h >= 0,
    feed: 'live',
  };
}

/** Where a class's own read stands. */
export type ClassState = 'loading' | 'ready' | 'failed';

export type PricedClass = AssetClass & { state: ClassState; error?: Error };

type Read<T> = { data?: T; error?: Error };

/**
 * Each class, priced by whichever read has answered for it.
 *
 * A class whose read is still out keeps its catalog rows and says `loading`, so a screen can list names
 * without claiming prices; one whose read failed says `failed`, with the error.
 */
export function priceClasses(
  classes: readonly AssetClass[],
  feed: Read<Record<string, Quote>>,
  stocks: Read<Record<string, StockQuote>>,
): PricedClass[] {
  return classes.map((cls): PricedClass => {
    const byStocks = sourceOf(cls) === 'stocks';
    const read = byStocks ? stocks : feed;
    if (read.error) return { ...cls, state: 'failed', error: read.error };
    if (!read.data) return { ...cls, state: 'loading' };
    const live = byStocks ? {} : (feed.data ?? {});
    const shares = byStocks ? (stocks.data ?? {}) : {};
    return { ...cls, state: 'ready', instruments: cls.instruments.map((i) => priceInstrument(i, live, shares)) };
  });
}
