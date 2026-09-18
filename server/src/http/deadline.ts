/**
 * An upstream that has not answered yet, bounded.
 *
 * A read behind a screen that waits with the scheduler's patience waits as long as the slowest upstream it touches, and
 * the app stops waiting at 45 seconds (`http/patience.ts`). These two are what its bounds are made of.
 */

/**
 * Not a failure: what a read needs is still on its way from upstream, and the same read shortly will find it.
 *
 * `/market/quotes`, `/market/ohlc` and the backtests already answer this state as `503 warming` with a `retry-after` and
 * a sentence. A screen read that runs out of patience for a price throws this, and the error handler gives the same
 * answer (`http/errors.ts`) — never a hang past the app's deadline, and never a $0 where a price was only late.
 */
export class StillFetching extends Error {
  constructor(
    /** What is still being fetched, as the sentence says it: "the price of WETH". */
    readonly what: string,
    /** When asking again is likely to find it: the fetch keeps going after the caller stops waiting. */
    readonly retryAfterSec = 5,
  ) {
    super(`${what.charAt(0).toUpperCase()}${what.slice(1)} is still being fetched; try again in a moment.`);
    this.name = 'StillFetching';
  }
}

/**
 * `work`, or the error `late()` makes once `ms` has passed, whichever comes first. Without `ms`, simply `work`.
 *
 * The work is not cancelled. A read cannot be taken back and does no harm finishing, and finishing is what fills the
 * cache the next caller reads — a bound that cancelled would make every attempt equally slow. Its late failure is caught
 * here, so it never surfaces as an unhandled rejection. The timer is cleared as soon as either side wins: an uncleared
 * one holds the event loop open for the whole bound after the work has already answered.
 */
export async function beforeDeadline<T>(work: Promise<T>, ms: number | undefined, late: () => Error): Promise<T> {
  if (ms === undefined) return work;
  void work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(late()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
