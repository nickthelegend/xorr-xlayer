/**
 * IconButton.tsx — the circular glyph button.
 *
 * design.md §1 gives `surfaceAlt` as "Icon buttons, inactive tabs", §3 gives radius 50% for
 * "circular icon buttons", and §1 gives `ink55` for "Icon glyphs, chevrons". Those three
 * lines are the whole recipe, and it appears in almost every screen header: back on the
 * pushed screens, search on Markets, sort on the leaderboard, gear on Home.
 *
 * It is 34pt drawn — under the 44pt minimum — so it grows its touch area through `Press`
 * rather than growing the circle, which is the §7 rule for every small control.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Press } from './Press';
import { colors, radius, size, space } from './tokens';
import { Icon, type IconName } from '@/design/Icon';

export interface IconButtonProps {
  name: IconName;
  /** Required: a bare glyph gives a screen reader nothing to announce. */
  accessibilityLabel: string;
  onPress?: () => void;
  /** Diameter. §5 uses 34 in headers and 30 where a row is tight. */
  circle?: number;
  /** Glyph size inside the circle. */
  glyph?: number;
  color?: string;
  /** Glyph stroke. The icon set's 1.8 unless a control has to read heavier — see `BackButton`. */
  strokeWidth?: number;
  /** Circle fill. `'none'` draws no circle — a bare glyph that still has a 44pt target. */
  background?: string | 'none';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function IconButton({
  name,
  accessibilityLabel,
  onPress,
  circle = size.mark,
  glyph = size.stepperGlyph,
  color = colors.ink55,
  strokeWidth,
  background = colors.surfaceAlt,
  disabled,
  style,
  testID,
}: IconButtonProps) {
  return (
    <Press
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitHeight={circle}
      hitWidth={circle}
      style={[
        {
          width: circle,
          height: circle,
          borderRadius: radius.full,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: background === 'none' ? 'transparent' : background,
        },
        style,
      ]}
    >
      {/*
        The glyph must not swallow the press.

        `style.pointerEvents`, not the prop: react-native-web deprecated the prop form and warns
        once per render on every screen that draws an icon button — which is nearly all of them.
      */}
      <View style={{ pointerEvents: 'none' }}>
        <Icon name={name} size={glyph} color={color} strokeWidth={strokeWidth} />
      </View>
    </Press>
  );
}

/** Back's glyph: heavier than the set's 1.8, so a 20px chevron holds its own in a 44pt circle. */
const BACK_GLYPH = 20;
const BACK_STROKE = 2.4;

/**
 * Back — one control, drawn the same on every screen (2026-09-13).
 *
 * It used to be an `IconButton` drawn two ways: a bare grey chevron on most screens and every sheet,
 * and the same 15px, 1.8-stroke glyph in a 34pt circle through `HeaderBar`. Both read as faint and
 * small, and the product owner called every one of them bad. Now it is the whole 44pt target drawn as
 * a circle in the control fill, with a white chevron at a heavier stroke.
 *
 * It does not navigate by itself — `src/ui` stays free of the router. Screens pass `useGoBack()`,
 * which falls back to Home when there is no history to pop.
 */
export function BackButton({
  onPress,
  accessibilityLabel = 'Back',
  style,
  testID,
}: {
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <IconButton
      name="back"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      circle={size.hit}
      glyph={BACK_GLYPH}
      strokeWidth={BACK_STROKE}
      color={colors.ink}
      background={colors.control}
      style={style}
      testID={testID}
    />
  );
}

/** A cross reads larger than a chevron drawn at the same size, so close's glyph is a touch smaller. */
const CLOSE_GLYPH = 18;

/**
 * Close — `BackButton`'s twin, for sheets that dismiss rather than pop (2026-09-13).
 *
 * The same 44pt circle and heavier stroke. `light` is for the white sheets — the order ticket, Auto
 * Close, the strategy set-ups — where a dark circle would read as a hole in the page.
 */
export function CloseButton({
  onPress,
  accessibilityLabel = 'Close',
  light = false,
  style,
  testID,
}: {
  onPress?: () => void;
  accessibilityLabel?: string;
  light?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <IconButton
      name="close"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      circle={size.hit}
      glyph={CLOSE_GLYPH}
      strokeWidth={BACK_STROKE}
      color={light ? colors.sheet.ink : colors.ink}
      background={light ? colors.sheet.fill : colors.control}
      style={style}
      testID={testID}
    />
  );
}

/**
 * A screen header: a back circle, a title, and an optional trailing control.
 *
 * Every pushed screen opens with this shape. Keeping it here is what stops each screen from
 * re-deriving the same row and drifting by a couple of points.
 */
export function HeaderBar({
  onBack,
  backLabel = 'Back',
  title,
  right,
  style,
  testID,
}: {
  onBack?: () => void;
  backLabel?: string;
  title?: React.ReactNode;
  right?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.s14,
          minHeight: size.mark,
        },
        style,
      ]}
    >
      {onBack ? <BackButton onPress={onBack} accessibilityLabel={backLabel} /> : null}
      <View style={{ flex: 1 }}>{title}</View>
      {right}
    </View>
  );
}
