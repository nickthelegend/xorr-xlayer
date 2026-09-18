/**
 * Hold to commit — the stop's gesture, as a state machine (FEATURES.md #3).
 *
 * The stop was a tap, and a tap is the easiest thing on a phone to make by accident: a thumb landing as the screen
 * settles, a press meant for the link beneath it. The stop signs a revoke. So it asks to be held — it fills while a
 * finger stays on it and commits at `HOLD_MS` — and a finger lifted sooner sends nothing.
 *
 * A hold is not accessible. A screen reader activates a control with one gesture and cannot keep a finger on it, and a
 * keyboard or a switch presses once. So only a press that can be held is asked to hold; an activation that no held press
 * came before — a screen reader's, a key's, an assistive click — commits at once. The biometric prompt behind the stop
 * guards every one of them.
 *
 * Apart from `HoldButton.tsx` for the reason `pressGuard.ts` is apart from `Button.tsx`: the timing is the part worth
 * testing, and a component holding a gesture and a timer is the part a test cannot reach.
 */

/** How long the stop is held before it commits. */
export const HOLD_MS = 600;

/**
 * How soon after a held press ends the click it produces arrives.
 *
 * Lifting a finger sends `onPressOut` and then `onPress`, on the phone and on the web. Without this, a finger lifted
 * early would cancel the hold and then commit it through its own click. The two arrive in the same turn; this is slack
 * for a busy thread, not a wait anyone sees.
 */
export const CLICK_AFTER_RELEASE_MS = 300;

export type HoldState = {
  phase: 'idle' | 'holding' | 'committed';
  /** When the hold in progress began. */
  since: number;
  /** A held press is still down: holding, or committed or cancelled with the finger still on it. */
  pressed: boolean;
  /** Until when an activation is the click of a held press that just ended, rather than an activation of its own. */
  quietUntil: number;
};

export type HoldEvent =
  /** A press began. `hold` is false where it cannot be held: a screen reader is on, or a key pressed it. */
  | { type: 'down'; at: number; hold: boolean }
  | { type: 'up'; at: number }
  /** The hold's timer fired. */
  | { type: 'elapsed'; at: number }
  /** The control was activated: a press's own click, a screen reader, a key, a switch. */
  | { type: 'activate'; at: number }
  /** The control was switched off mid-hold. */
  | { type: 'cancel' }
  /** What a commit started has finished, whichever way. */
  | { type: 'settled' };

export const HOLD_IDLE: HoldState = { phase: 'idle', since: 0, pressed: false, quietUntil: Number.NEGATIVE_INFINITY };

const unchanged = (state: HoldState) => ({ state, commit: false });

/**
 * The state after `event`, and whether `event` commits.
 *
 * A commit happens once, and nothing starts another until what it started has settled: the stop reads the permission
 * and asks for a signature, and a second commit behind it would be a second revoke — or, once the first has landed, a
 * resume.
 */
export function holdStep(state: HoldState, event: HoldEvent): { state: HoldState; commit: boolean } {
  if (event.type === 'down') {
    if (state.phase !== 'idle' || state.pressed || !event.hold) return unchanged(state);
    return { state: { ...state, phase: 'holding', since: event.at, pressed: true }, commit: false };
  }
  if (event.type === 'elapsed') {
    if (state.phase !== 'holding' || event.at - state.since < HOLD_MS) return unchanged(state);
    return { state: { ...state, phase: 'committed' }, commit: true };
  }
  if (event.type === 'up') {
    if (!state.pressed) return unchanged(state);
    const lifted: HoldState = { ...state, pressed: false, quietUntil: event.at + CLICK_AFTER_RELEASE_MS };
    if (state.phase !== 'holding') return { state: lifted, commit: false };
    // Held the whole way with the timer late: a finished hold, not a cancelled one.
    if (event.at - state.since >= HOLD_MS) return { state: { ...lifted, phase: 'committed' }, commit: true };
    return { state: { ...lifted, phase: 'idle' }, commit: false };
  }
  if (event.type === 'activate') {
    if (state.phase !== 'idle' || state.pressed || event.at <= state.quietUntil) return unchanged(state);
    return { state: { ...state, phase: 'committed' }, commit: true };
  }
  if (event.type === 'cancel') {
    return state.phase === 'holding' ? { state: { ...state, phase: 'idle' }, commit: false } : unchanged(state);
  }
  return state.phase === 'committed' ? { state: { ...state, phase: 'idle' }, commit: false } : unchanged(state);
}

/** What is left of the hold at `at`, in ms: for re-arming a timer that fired a moment early. */
export function holdRemaining(state: HoldState, at: number): number {
  return state.phase === 'holding' ? Math.max(0, HOLD_MS - (at - state.since)) : 0;
}
