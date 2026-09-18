/**
 * SheetCard.tsx — the card and the bottom sheet.
 *
 * design.md §5: `background #0C0C0D · border cardBorder · radius 22–34 · padding 16–26`.
 * A full-bleed sheet uses `radius: 30px 30px 0 0` and sits at the bottom of the frame.
 *
 * §3: shadows are almost none, and a card gets none of them. **No `elevation`.** On
 * Android an elevation paints a grey halo that the true-black background turns into a
 * visible box, and it lifts the card off a surface that is meant to be flush. The 1px
 * `rgba(255,255,255,.06)` border is the whole separation.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './Text';
import { border, colors, radius, space } from './tokens';

export interface SheetCardProps {
  children?: React.ReactNode;
  /** §5: 22–34. */
  borderRadius?: number;
  /** §5: 16–26. */
  padding?: number;
  /** Drop the outline — for a card that sits inside another bordered surface. */
  bordered?: boolean;
  /** The light sheet (Auto Close, order ticket). */
  light?: boolean;
  /** Absorbs the leftover height, per the §4 layout law. */
  fill?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SheetCard({
  children,
  borderRadius = radius.panel,
  padding = space.s18,
  bordered = true,
  light = false,
  fill = false,
  style,
  testID,
}: SheetCardProps) {
  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: light ? colors.sheet.bg : colors.surface,
          borderRadius,
          padding,
        },
        fill ? { flex: 1, minHeight: 0 } : null,
        bordered && !light ? border.card : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export interface BottomSheetProps {
  children?: React.ReactNode;
  /** The light sheet. Auto Close and the order ticket are the only two. */
  light?: boolean;
  /** §5: a full-bleed sheet is 30 30 0 0. */
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The full-bleed sheet: square at the bottom of the frame, rounded at the top, taking the
 * remaining height. Put it directly inside a `Screen` with `gutter="none"`.
 */
export function BottomSheet({
  children,
  light = false,
  borderRadius = radius.sheet,
  style,
  testID,
}: BottomSheetProps) {
  return (
    <View
      testID={testID}
      style={[
        {
          flex: 1,
          minHeight: 0,
          backgroundColor: light ? colors.sheet.bg : colors.surface,
          borderTopLeftRadius: borderRadius,
          borderTopRightRadius: borderRadius,
        },
        light ? null : border.card,
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * A consequence — "here is exactly what will and will not happen".
 *
 * screens.md screen 20 draws these under the kill switch, and the delegation screen reuses
 * the pattern for the same reason: both ask the user to authorise something irreversible,
 * and both owe them a list rather than a paragraph.
 *
 * The dot is `up` or `down` by MEANING, not by sentiment. "New orders — stopped immediately"
 * takes `down` because trading stops; "Open positions — left exactly as they are" takes `up`
 * because nothing is taken from you. Green and red mean profit and loss everywhere else in
 * the app, and this is the one place they are allowed to mean "this happens" / "this does
 * not" — which works only because the label always says which.
 */
export function ConsequenceCard({
  tone,
  label,
  detail,
  style,
  testID,
}: {
  tone: 'up' | 'down' | 'warn';
  label: string;
  detail: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const dot = tone === 'up' ? colors.up : tone === 'down' ? colors.down : colors.warn;
  return (
    <SheetCard testID={testID} borderRadius={radius.note} padding={space.s14} style={style}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.s10 }}>
        <View
          style={{
            width: CONSEQUENCE_DOT,
            height: CONSEQUENCE_DOT,
            borderRadius: radius.full,
            backgroundColor: dot,
            marginTop: space.s4,
          }}
        />
        <View style={{ flex: 1, gap: space.s4 }}>
          <Text variant="rowPrimary">{label}</Text>
          <Text variant="secondarySm">{detail}</Text>
        </View>
      </View>
    </SheetCard>
  );
}

/** 9pt — small enough to read as punctuation, not as a status light. */
const CONSEQUENCE_DOT = 9;
