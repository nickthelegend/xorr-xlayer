/**
 * Price history, in the three answers a chart has to tell apart.
 *
 * `repos.markets.candles` turns every failure into "no feed" (src/data/local.ts), so a chart whose
 * request failed said there was no price feed for BTC, and so did one whose history was seconds away.
 * Here `warming` is a wait, `unavailable` is a symbol nothing prices, and a failed read throws for the
 * screen's error state.
 *
 * Each answer carries the question it answered. `useAsync` keeps the last answer on screen while the
 * next one loads, and a chart that has moved to another range must not draw the last range's candles
 * under the new label in the meantime.
 */
import {
  StillWarming,
  fetchChartCandles,
  fetchHistory,
  type ChartTimeframe,
  type HistoryRange,
} from '@/data/marketData';
import type { Bar } from '@/data/types';

export type Series<W extends string> = {
  symbol: string;
  window: W;
  bars: Bar[];
  feed: 'live' | 'unavailable' | 'warming';
};

async function settle<W extends string>(
  symbol: string,
  window: W,
  load: () => Promise<Bar[] | null>,
): Promise<Series<W>> {
  try {
    const bars = await load();
    return { symbol, window, bars: bars ?? [], feed: bars === null ? 'unavailable' : 'live' };
  } catch (e) {
    if (e instanceof StillWarming) return { symbol, window, bars: [], feed: 'warming' };
    throw e;
  }
}

/** Candles exactly as long as the pill says. */
export function chartSeries(symbol: string, timeframe: ChartTimeframe): Promise<Series<ChartTimeframe>> {
  return settle(symbol, timeframe, () => fetchChartCandles(symbol, timeframe));
}

/** A whole range, folded to the candles the design draws. */
export function historySeries(symbol: string, range: HistoryRange): Promise<Series<HistoryRange>> {
  return settle(symbol, range, () => fetchHistory(symbol, range));
}

/** For `useLiveRead`: an answer that is really a wait. */
export const stillWarming = (s: Series<string>): boolean => s.feed === 'warming';

/**
 * The span a run of candles covers, the way a change line reads it: "past 12 hours", "past 2 days".
 *
 * The chart said "today" under every pill, including the ones that measured twelve days.
 */
export function spanWords(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return hours === 1 ? 'past hour' : `past ${hours} hours`;
  return `past ${Math.round(hours / 24)} days`;
}
