/**
 * A `503 warming` is a WAIT, not a failure.
 *
 * The executor bounds the routes whose upstreams can be slow — a cold backtest replays ninety days
 * of real history, the proposal engine prices a market — and answers `503` with a `retry-after`
 * and a sentence rather than hanging or lying. The work continues server-side, so the retry a few
 * seconds later reads a warm cache.
 *
 * A caller that treats that 503 like any other error turns "still computing" into "this failed",
 * which is how `/bot/:id/backtest` came to render its ErrorState — and, because that screen
 * deliberately hides "run against real history at your current limits. Nothing here is a promise."
 * whenever it is showing an error, the disclaimer vanished along with it.
 *
 * Extracted because this is the third caller. `marketData.ts` waits out its own 503s inside its
 * fetch, and `generateProposal` grew a copy of this loop; a fourth would have been the point where
 * one of them quietly stopped matching the others.
 */
import { ApiError } from './apiError';

/** How many times to wait out a warming 503 before handing the state to the screen. */
const ATTEMPTS = 4;
const GAP_MS = 3_000;

export async function waitOutWarming<T>(
  read: () => Promise<T>,
  attempts = ATTEMPTS,
  gapMs = GAP_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read();
    } catch (e) {
      /*
       * Only a 503. Every other status is a real answer the screen should show — a 404 for an
       * agent that does not exist, a 422 for one that cannot be backtested, a 401 for no session.
       * Retrying those would make a correct refusal take four times as long to arrive.
       */
      const warming = e instanceof ApiError && e.status === 503;
      if (!warming || attempt >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
}
