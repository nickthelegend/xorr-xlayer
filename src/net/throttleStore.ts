/**
 * What the app has actually observed about being throttled.
 *
 * Everything in here is recorded from a real answer: a 429's own `retry-after`, and the `breakers` array
 * `/health` publishes. Nothing is estimated, and nothing is remembered past the moment it stops being true —
 * a countdown to a time nothing happens at would be worse than no banner.
 *
 * Deliberately not persisted. A rate limit is a property of the last sixty seconds, and restoring one from
 * disk on a cold start would tell someone they are throttled by a window that closed while the app was shut.
 */
import { create } from 'zustand';
import { NO_THROTTLE, type Breaker, type ThrottleState } from './throttle';

type ThrottleStore = ThrottleState & {
  /** Our limiter refused a request: `retry-after`, in seconds, exactly as it said. */
  limited: (retryAfterSec: number, now?: number) => void;
  /** The breakers as `/health` last reported them. Replaces rather than merges: this is a full picture each time. */
  reportBreakers: (breakers: readonly Breaker[]) => void;
};

/**
 * The timer that puts `limitedUntil` back to zero when the window closes.
 *
 * Without it the field stays in the past forever and every reader has to compare it against the clock — which
 * they do anyway, but the component that draws the banner would then have to keep a one-second tick running
 * for the rest of the session to notice it had expired. Clearing the state instead means the countdown
 * unmounts itself.
 */
let clearAt: ReturnType<typeof setTimeout> | undefined;

export const useThrottle = create<ThrottleStore>((set, get) => ({
  ...NO_THROTTLE,
  limited: (retryAfterSec, now = Date.now()) => {
    const until = now + Math.max(0, retryAfterSec) * 1000;
    // The later of the two: a second refusal inside the window must not shorten the wait.
    if (until <= get().limitedUntil) return;
    set({ limitedUntil: until });
    if (clearAt) clearTimeout(clearAt);
    clearAt = setTimeout(() => {
      clearAt = undefined;
      // Only if nothing later moved it: a refusal that arrived while this was pending owns the window now.
      if (useThrottle.getState().limitedUntil <= Date.now()) set({ limitedUntil: 0 });
    }, until - now);
  },
  reportBreakers: (breakers) => set({ breakers: [...breakers] }),
}));

/**
 * Called by the transport when a 429 comes back, from outside React.
 *
 * `api.ts` is not a component and must not import one. Zustand's store is callable directly, which is the
 * whole reason the observation lives in a store rather than in a provider's state.
 */
export function noteRateLimited(retryAfterSec: number | undefined): void {
  if (retryAfterSec === undefined) return;
  useThrottle.getState().limited(retryAfterSec);
}
