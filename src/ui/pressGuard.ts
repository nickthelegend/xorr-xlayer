/**
 * The thing that stops one press becoming two records.
 *
 * `useGuardedPress` in `Button.tsx` carried this logic inline, and its own docblock explains why it
 * exists at all: `loading` is React state, so two presses dispatched in the same tick both read
 * `loading === false` and both fire. Measured, not theorised — double-tapping "Alert me when WETH
 * is above $9000" created two identical alerts.
 *
 * It had no test, because a hook holding a ref inside a component is awkward to exercise and the
 * only honest end-to-end check is a real double-tap in a browser. Split out here for the same
 * reason `apiError.ts` was split out of `api.ts`: the part worth testing was the part that could
 * not be reached. The hook keeps one of these in a ref and is otherwise unchanged.
 */

/** Long enough to swallow a double tap, short enough not to be felt. Unchanged from Button.tsx. */
export const DOUBLE_TAP_MS = 800;

export type PressGuard = {
  /**
   * Try to take the lock. `true` means the caller owns it and should run; `false` means a press is
   * already in flight and this one must be dropped.
   */
  take(): boolean;
  /** Release it — on the promise settling, on `loading` clearing, or after the timeout. */
  release(): void;
  /** Whether a press is currently in flight. Exposed for tests and for the `loading` effect. */
  readonly held: boolean;
};

export function createPressGuard(): PressGuard {
  let inFlight = false;
  return {
    take() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    release() {
      inFlight = false;
    },
    get held() {
      return inFlight;
    },
  };
}

/**
 * Guards that survive the button being torn down and rebuilt.
 *
 * The lock used to live in a `useRef`, which ties it to one component INSTANCE — and a press that
 * makes its own button unmount takes the lock with it. Retry is exactly that shape: pressing "Try
 * again" puts the screen into its loading state, `ErrorState` disappears, the request fails, and
 * `ErrorState` comes back as a NEW instance holding a NEW, unlocked guard. The 800ms timeout from
 * the first press is still pending, on an object nothing can reach any more.
 *
 * Measured on the deployed app, not reasoned about: a real double-click on "Try again" produced
 * two `/limits` requests **11ms apart**, against one for a single click.
 *
 * Keyed by `testID`, and only by `testID`. Keying on the label would make every "Continue" in the
 * app share one lock, so pressing Continue on one step and again on the next inside 800ms would
 * silently swallow the second — trading a harmless duplicate request for a dead button, which is
 * the worse failure. A button with no `testID` keeps exactly the behaviour it had.
 */
const shared = new Map<string, PressGuard>();

export function pressGuardFor(key: string | undefined): PressGuard {
  if (!key) return createPressGuard();
  const existing = shared.get(key);
  if (existing) return existing;
  const made = createPressGuard();
  shared.set(key, made);
  return made;
}

/** Test seam. The registry is module state and would otherwise leak between cases. */
export function resetSharedGuards(): void {
  shared.clear();
}
