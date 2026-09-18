/**
 * Button.tsx
 *
 * design.md §5:
 *   height 52–56 · radius 30 · 15.5–16/600
 *   default      #fff on #000
 *   destructive  #EF3B36 on #fff
 *   disabled     #1B1C1E on ink35
 *   confirmed    #2BD87A on #04160C
 *   secondary    #1B1C1E on white
 *   ghost        ghostBorder · height 46–48 · label ink65
 *
 * **One primary button per screen.** Two-button rows are `flex:1` / `flex:1.3` with the
 * affirmative action wider and on the right — `ButtonRow` is that rule, so a screen can't
 * put "Cancel" on the right by accident.
 *
 * There is no hover variant. design.md lists one (`rgba(255,255,255,.88)`) because the
 * prototype ran in a browser; on a phone the press state is the feedback, and it is the
 * global `opacity: .85` from `Press`.
 *
 * `success` is not a selection colour. It is the state of an order that filled — a P&L
 * fact — which is the only reason a button is ever green.
 */
import React from 'react';
import { ActivityIndicator, View, type StyleProp, type ViewStyle } from 'react-native';
import type { FigureKind } from './mask';
import { Press } from './Press';
import { DOUBLE_TAP_MS, pressGuardFor } from './pressGuard';
import { Text } from './Text';
import { border, colors, radius, size, space } from './tokens';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'destructive'
  | 'success'
  | 'sheetPrimary';

interface Skin {
  bg: string;
  fg: string;
  bordered: boolean;
  height: number;
}

const SKINS: Readonly<Record<ButtonVariant, Skin>> = Object.freeze({
  primary: { bg: colors.ink, fg: colors.bg, bordered: false, height: size.button },
  secondary: { bg: colors.control, fg: colors.ink, bordered: false, height: size.button },
  ghost: { bg: 'transparent', fg: colors.ink65, bordered: true, height: size.ghost },
  destructive: { bg: colors.candleDown, fg: colors.ink, bordered: false, height: size.buttonLg },
  success: { bg: colors.up, fg: colors.upInk, bordered: false, height: size.button },
  /** A primary CTA sitting on the light sheet: the ink inverts. */
  sheetPrimary: { bg: colors.sheet.ink, fg: colors.sheet.bg, bordered: false, height: size.button },
});

const DISABLED: Pick<Skin, 'bg' | 'fg'> = { bg: colors.control, fg: colors.ink35 };

export interface ButtonProps {
  label: string;
  /**
   * May return a promise. If it does, the button refuses further presses until it settles —
   * see `guardedPress` for why `loading` alone was not enough.
   */
  onPress?: () => void | Promise<unknown>;
  variant?: ButtonVariant;
  disabled?: boolean;
  /**
   * The action is in flight. The button stops accepting presses and announces `busy` —
   * without this a user who taps "Create wallet" twice gets two wallets, and the second
   * one silently replaces the first.
   */
  loading?: boolean;
  /** §5: 52–56 primary, 46–48 ghost. Defaults per variant. */
  height?: number;
  /** Overrides the fill — the gold "Long gold" CTA takes the instrument's own colour. */
  backgroundColor?: string;
  color?: string;
  /**
   * A label that names the person's money — "Withdraw $1,200.00" — says which figure it is, and hides it while balances
   * are hidden (FEATURES.md #47). Unsaid, a label is words.
   */
  figure?: FigureKind;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * One press, one action — enforced synchronously.
 *
 * `loading` was supposed to do this and cannot on its own: it is React state, so a screen sets it
 * inside its async handler and the flag only reaches the button on the NEXT render. Two taps
 * dispatched in the same tick both read `loading === false` and both fire. Measured, not theorised:
 * double-tapping "Buy $25 of WETH, weekly" created **two identical recurring buys**, and the user
 * would have been charged twice a week from then on. Seventeen screens share that pattern.
 *
 * A ref flips in the same tick as the first press, so the second one has something to see. It
 * clears when the handler's promise settles — or immediately for a synchronous handler, which
 * cannot have an in-flight state to protect.
 */
/** Long enough to absorb a double tap, short enough that a real second press still lands. */


function useGuardedPress(
  onPress: (() => void | Promise<unknown>) | undefined,
  loading: boolean,
  testID?: string,
) {
  /*
   * The lock itself lives in `pressGuard.ts`, where it can be tested; see the note there.
   *
   * Keyed by `testID` when there is one, so it outlives a press that unmounts its own button —
   * the retry case, where the guard was measurably useless. Without a `testID` this is a fresh
   * per-instance guard, exactly as before.
   */
  const guard = React.useMemo(() => pressGuardFor(testID), [testID]);

  const wasLoading = React.useRef(loading);
  React.useEffect(() => {
    /*
     * A screen that finished its own work and cleared `loading` releases the guard with it, so a
     * handler that never returns a promise still cannot wedge the button shut.
     *
     * On the TRANSITION out of loading, not on every render where loading is false. Releasing
     * unconditionally also fired on mount, which for a keyed guard means the remount that the key
     * exists to survive would immediately unlock it — the bug, reintroduced by its own fix.
     */
    if (wasLoading.current && !loading) guard.release();
    wasLoading.current = loading;
  }, [loading, guard]);

  return React.useCallback(() => {
    if (!onPress || !guard.take()) return;
    const result = onPress();
    if (result && typeof (result as Promise<unknown>).finally === 'function') {
      void (result as Promise<unknown>).finally(() => {
        guard.release();
      });
      return;
    }
    /*
     * A handler that returns nothing still gets a lock, just a short one.
     *
     * `onPress={() => void create()}` is a promise thrown away — the work is async and the button
     * cannot see it. Six call sites did that, including "Create wallet", which is the exact case
     * this component's docblock warns about. Double-tapping "Alert me when WETH is above $9000"
     * created two identical alerts even with the promise guard in place, because there was no
     * promise to guard.
     *
     * So a synchronous-looking press is locked for long enough to swallow a double tap and not
     * long enough to be felt. Deliberate repeats — a keypad digit, a stepper — go through `Press`
     * and are untouched; this is only the one primary action a screen has.
     */
    setTimeout(() => {
      guard.release();
    }, DOUBLE_TAP_MS);
  }, [onPress, guard]);
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  height,
  backgroundColor,
  color,
  figure,
  style,
  testID,
}: ButtonProps) {
  const skin = SKINS[variant];
  const press = useGuardedPress(onPress, loading, testID);
  const bg = disabled ? DISABLED.bg : (backgroundColor ?? skin.bg);
  const fg = disabled ? DISABLED.fg : (color ?? skin.fg);
  const h = height ?? skin.height;

  return (
    <Press
      testID={testID}
      onPress={press}
      disabled={disabled || loading || !onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      style={[
        {
          height: h,
          borderRadius: radius.sheet,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: space.s8,
          paddingHorizontal: space.s20,
          backgroundColor: bg,
        },
        skin.bordered && !disabled ? border.ghost : null,
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={fg} /> : null}
      <Text variant="button" color={fg} numberOfLines={1} figure={figure}>
        {label}
      </Text>
    </Press>
  );
}

export interface ButtonRowProps {
  /** The dismissive action. Narrower, and on the left. */
  secondary: React.ReactElement;
  /** The affirmative action. Wider (flex 1.3), and on the right. */
  primary: React.ReactElement;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function ButtonRow({ secondary, primary, style, testID }: ButtonRowProps) {
  return (
    <View
      testID={testID}
      style={[{ flexDirection: 'row', gap: space.s12 }, style]}
    >
      <View style={{ flex: 1 }}>{secondary}</View>
      <View style={{ flex: 1.3 }}>{primary}</View>
    </View>
  );
}

/**
 * A two-button row where neither action is affirmative — Short / Long, Sell / Buy. Both
 * halves are equal because neither is the safe one.
 */
export function ButtonPair({
  left,
  right,
  style,
  testID,
}: {
  left: React.ReactElement;
  right: React.ReactElement;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View testID={testID} style={[{ flexDirection: 'row', gap: space.s12 }, style]}>
      <View style={{ flex: 1 }}>{left}</View>
      <View style={{ flex: 1 }}>{right}</View>
    </View>
  );
}
