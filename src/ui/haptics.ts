/**
 * haptics.ts — a small vocabulary, used sparingly (FEATURES.md #23).
 *
 * A tick when a selection changes: a switch flips, a segment or a filter is chosen. And one heavy tap when a held stop
 * commits (`HoldButton`, FEATURES.md #3): that is the moment the stop is pulled — the finger's, not the signature's that
 * follows it. That is the whole of it in the design system. A fill, a refusal and a confirmed stop each get their own
 * when the screens that own those moments call them, and nothing else in the app buzzes — a phone that vibrates on
 * every tap stops meaning anything by the second screen.
 *
 * The phone only. `expo-haptics` does nothing useful in a browser, and a web page that vibrates is the opposite of
 * quiet. A failure is ignored on purpose: a device with no haptic engine is not a reason for a control to stop working.
 */
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

const ON_PHONE = Platform.OS === 'ios' || Platform.OS === 'android';

/** A selection changed. */
export function selectionTick(): void {
  if (ON_PHONE) void Haptics.selectionAsync().catch(() => undefined);
}

/** Something the user asked for happened: a fill, a confirmed stop. */
export function successTap(): void {
  if (ON_PHONE) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
}

/** Something the user asked for was refused. */
export function warningTap(): void {
  if (ON_PHONE) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
}

/** The one heavy moment: pulling the stop, as a hold on `HoldButton` completes. */
export function heavyTap(): void {
  if (ON_PHONE) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => undefined);
}

/** How long after the thud the latch lands. Short enough to be one event, long enough to be two beats. */
const LATCH_MS = 90;

/**
 * The stop, confirmed on-chain — the only two-beat haptic in the app.
 *
 * A thud and a latch: `Heavy`, then `Rigid` a beat later. `heavyTap` is the finger's moment, when the
 * hold completes and the signature goes out; this is the chain's answer, and the two must not feel the
 * same or the second says nothing. Every other confirmation in the app is a single tap, so a phone in a
 * pocket can tell this one apart from a fill without being looked at.
 *
 * The beat is a real interval and not an animation: nothing on screen is waiting for it.
 */
export function killTap(): void {
  if (!ON_PHONE) return;
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => undefined);
  setTimeout(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(() => undefined);
  }, LATCH_MS);
}
