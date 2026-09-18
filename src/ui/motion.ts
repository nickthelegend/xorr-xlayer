/**
 * motion.ts — the motion policy.
 *
 * Rewritten 2026-09-12 to the product owner's reference video. There are two kinds of motion now,
 * with different rules:
 *
 *   INTERACTION — a control the user touched: Switch, Segmented, the chat sheet going down. Platform default
 *   easing, the 150/180/250 scale, no overshoot. Unchanged.
 *
 *   ARRIVAL — a screen appearing. Sections rise into place one after another, a chart draws itself
 *   left to right, a figure's digits roll in. Ease-out, `duration.enter` / `duration.draw`, staggered
 *   so the eye reads top to bottom. Screens get it from `<Rise>` and `<RollingNumber>`, never from
 *   reanimated's builders directly.
 *
 * The Messages drawer rises on the arrival curve over `duration.enter` (2026-09-16): the one sheet that crosses the whole
 * height of the screen, where 250ms on the interaction curve read as a cut. The tab bar moves with it.
 *
 * And, since 2026-09-14, one gesture with a motion of its own:
 *
 *   HOLD — the stop filling while a finger stays on it (FEATURES.md #3). Linear over `HOLD_MS`,
 *   because the fill is the hold's clock drawn and has to reach the end at the moment the commit
 *   happens: an eased fill looks nearly done a third of the way in, and teaches a thumb to let go
 *   early. Off the interaction scale for the reason arrival is — it answers a finger kept down, not a
 *   tap. `<HoldButton>` is the one place it is made.
 *
 * What did not change: no spring, bounce or overshoot anywhere; every animation collapses to an
 * instant state change under reduced motion; and no figure ever shows a value it does not have.
 * Digits roll in AT their true value — nothing counts through numbers the market never printed.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { Easing, ReduceMotion, withDelay, withTiming, type WithTimingConfig } from 'react-native-reanimated';
import { HOLD_MS } from './holdToCommit';
import { duration } from './tokens';

/**
 * The interaction easing: the platform default. CSS `ease` is `cubic-bezier(.25,.1,.25,1)`, which is
 * exactly `Easing.inOut(Easing.ease)`.
 */
export const easing = Easing.inOut(Easing.ease);

/** The arrival easing: quick out of the gate, settling gently — how a sheet comes to rest. */
export const easeOut = Easing.out(Easing.cubic);

/**
 * A timing config. Pass `reduced` from `useReducedMotion()` and the transition collapses to an
 * instant state change — the colour or position alone still carries the meaning.
 *
 * Seed a shared value with the current state and drive it from a `useEffect` with this, rather than
 * returning `withTiming` out of a `useDerivedValue` — the latter starts at 0 and animates to the
 * current state on mount, which is an entrance on a control that has not changed.
 */
export function timing(ms: number, reduced: boolean): WithTimingConfig {
  return { duration: reduced ? 0 : ms, easing };
}

/** The same, on the arrival curve. */
export function arrival(ms: number, reduced: boolean): WithTimingConfig {
  return { duration: reduced ? 0 : ms, easing: easeOut };
}

/** The beat between one arriving element and the next. */
export const STAGGER = 60;

/**
 * The arrival of the `index`-th element of a screen, as a 0 → 1 progress for `<Rise>` to draw from.
 *
 * A timing, not reanimated's `entering` builders. Those animate through CSS on the web, which takes a
 * named curve or a bezier and nothing composed: `Easing.out(Easing.cubic)` logged "Selected easing is
 * not currently supported on web" on every screen and arrived linearly. Every named web curve is an
 * ease-in, and a bezier of our own is the custom curve this policy does not allow (a86d8a0 tried one,
 * and CI said so). A timing runs `easeOut` itself, so the web and the phone arrive the same way.
 *
 * `ReduceMotion.System` as well as the flag: `useReducedMotion` answers asynchronously, so on the very
 * first mount it still reads false. Reanimated asks the OS itself when the animation starts, and
 * finishes it at once.
 */
export function riseTo(index: number, reduced: boolean) {
  return withDelay(
    reduced ? 0 : index * STAGGER,
    withTiming(1, { ...arrival(duration.enter, reduced), reduceMotion: ReduceMotion.System }),
    ReduceMotion.System,
  );
}

/**
 * The hold's fill, on `<HoldButton>`: linear over the whole hold, so the fill and the commit arrive together.
 *
 * Under reduced motion the fill is simply there once the press lands. The press is still held for the commit, so the
 * state shows without the movement. `ReduceMotion.System` as well, for the first mount `riseTo` describes.
 */
export function holdFill(reduced: boolean): WithTimingConfig {
  return { duration: reduced ? 0 : HOLD_MS, easing: Easing.linear, reduceMotion: ReduceMotion.System };
}

export { duration };

/** Tracks the OS "reduce motion" setting for the life of the component. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (alive) setReduced(on);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  return reduced;
}
