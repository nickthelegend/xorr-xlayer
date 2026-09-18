/**
 * `useAsync`, for a market read that can answer "still fetching".
 *
 * The executor answers a cold price or history request with a warming 503, and `marketData` waits that
 * out a few times before giving up with `StillWarming` — or, through `series.ts`, with an answer marked
 * `warming`. That is neither a failure nor "no feed". The read stays loading and asks again, the way
 * the asset screen always has: a screen that sat on "warming" until someone navigated away looked
 * exactly like a stuck one.
 */
import { useEffect } from 'react';
import { StillWarming } from '@/data/marketData';
import { useAsync, type AsyncState } from '@/data/useAsync';

/** How long to wait before asking a warming executor again. */
const RETRY_MS = 4_000;

export function useLiveRead<T>(
  read: () => Promise<T>,
  deps: unknown[],
  isWarming: (value: T) => boolean = () => false,
): AsyncState<T> {
  const state = useAsync(read, deps);
  const { data, error, loading, reload } = state;
  const warmingAnswer = data !== undefined && isWarming(data);
  const warming = error instanceof StillWarming || (!loading && warmingAnswer);

  useEffect(() => {
    if (!warming) return;
    const t = setTimeout(reload, RETRY_MS);
    return () => clearTimeout(t);
  }, [warming, reload]);

  return {
    ...state,
    data: warmingAnswer ? undefined : data,
    error: error instanceof StillWarming ? undefined : error,
    loading: loading || warming,
  };
}
