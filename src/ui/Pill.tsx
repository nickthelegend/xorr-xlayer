/**
 * Pill.tsx — filter / segment chip.
 *
 * design.md §5: `height 34 · padding 0 14 · radius 20 · 13/600`.
 * Selected `#fff` on `#0B0B0B`; unselected `#141516` on `ink50`.
 *
 * Selection is white-on-dark. It is never green — on a trading surface a second meaning
 * for green is a bug, and the pill row sits directly above a price column.
 *
 * `PillRow` exists because the market tabs shipped broken once: the pills shrank to fit
 * the row and truncated their labels. Pills never shrink — the row scrolls.
 */
import React from 'react';
import { Platform, ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { Press } from './Press';
import { Text } from './Text';
import { selectionTick } from './haptics';
import { border, colors, radius, size, space } from './tokens';

export interface PillProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  /** On the light sheet the unselected fill is `sheetFill` rather than `surfaceAlt`. */
  light?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** screens.md screen 7: 40pt tall. Taller than a filter pill because it is an answer. */
const CHOICE_H = 40;

export function Pill({
  label,
  selected,
  onPress,
  light = false,
  disabled = false,
  style,
  testID,
}: PillProps) {
  const isSelected = selected ?? false;
  const bg = isSelected
    ? light
      ? colors.sheet.ink
      : colors.ink
    : light
      ? colors.sheet.fill
      : colors.surfaceAlt;

  const fg = isSelected
    ? light
      ? colors.sheet.bg
      : colors.sheet.ink
    : light
      ? colors.sheet.muted
      : colors.ink50;

  return (
    <Press
      testID={testID}
      /*
       * A filter pill that becomes the selection ticks on the phone (FEATURES.md #23). An action pill — `$100`, `Max`,
       * passing no `selected` — selects nothing, so it does not; nor does pressing the one already selected.
       */
      onPress={
        onPress && selected === false
          ? () => {
              selectionTick();
              onPress();
            }
          : onPress
      }
      disabled={disabled || !onPress}
      hitHeight={size.pillH}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      /*
       * See `Segmented.tsx`: React Native Web drops `accessibilityState.selected`, so the line
       * above reaches the DOM as nothing and this control announces no state at all. The web
       * attribute valid for a button role is added alongside it; native keeps reading the line
       * above.
       *
       * `selected` deliberately, NOT `isSelected`. A Pill is used two ways: as one option in a
       * filter row, which has a state worth announcing, and as a plain action — the `$100` / `$500`
       * / `Max` chips on the order ticket pass no `selected` at all and simply set an amount.
       * Defaulting to `false` here put `aria-pressed="false"` on those, which tells a screen reader
       * "toggle button, not pressed" about a button that is not a toggle. Undefined omits the
       * attribute, so only the callers that mean it get it.
       */
      aria-pressed={selected}
      style={[
        {
          flexGrow: 0,
          flexShrink: 0,
          height: size.pillH,
          paddingHorizontal: size.pillPadX,
          borderRadius: radius.card,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: bg,
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      <Text variant="control" color={fg} numberOfLines={1}>
        {label}
      </Text>
    </Press>
  );
}

export interface PillRowProps {
  children: React.ReactNode;
  /** Horizontal padding inside the scroll area, for a row that bleeds past the gutter. */
  contentPadding?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * A horizontally scrolling row of pills. `flex: none` per pill, no scroll indicator.
 * Use this rather than a wrapping flex row wherever the set can outgrow the width.
 */
export function PillRow({ children, contentPadding = 0, style, testID }: PillRowProps) {
  return (
    <ScrollView
      testID={testID}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[{ flexGrow: 0, flexShrink: 0 }, style]}
      contentContainerStyle={{
        flexDirection: 'row',
        gap: space.s8,
        paddingHorizontal: contentPadding,
      }}
    >
      {children}
    </ScrollView>
  );
}

/** A non-scrolling, wrapping set — the onboarding goal chips, which are a closed list. */
export function PillWrap({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s8 }, style]}>
      {children}
    </View>
  );
}

/**
 * The screen 7 goal chip. screens.md: "wrapping chip row (gap 9, chips 40 tall, radius 22)".
 *
 * It is not a `Pill` with a different height. A `Pill` is a filter — one of a set, in a row
 * that scrolls, showing which slice you are looking at. A `ChoiceChip` is an answer the user
 * gives, several at a time, in a row that wraps. Selection therefore reads harder (solid
 * white, not a grey step up) and the unselected state carries a border so an unanswered
 * question still looks like it is waiting for one.
 */
export function ChoiceChip({
  label,
  selected,
  onPress,
  disabled = false,
  style,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <Press
      testID={testID}
      onPress={onPress}
      disabled={disabled || !onPress}
      hitHeight={CHOICE_H}
      // iOS has no checkbox trait — RN maps `checkbox` to `UIAccessibilityTraitNone`, so the
      // chip drops out of the accessibility tree entirely and VoiceOver cannot say which goals
      // are picked. `button` + `selected` is the idiomatic iOS pair and announces the state.
      // Android and web do have a real checkbox, and `checked` is the right word there.
      accessibilityRole={Platform.OS === 'ios' ? 'button' : 'checkbox'}
      accessibilityState={
        Platform.OS === 'ios' ? { selected, disabled } : { checked: selected, disabled }
      }
      accessibilityLabel={label}
      style={[
        {
          height: CHOICE_H,
          paddingHorizontal: space.s16,
          borderRadius: radius.panel,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: selected ? colors.ink : colors.bubble,
          opacity: disabled ? 0.4 : 1,
        },
        selected ? null : border.input,
        style,
      ]}
    >
      <Text variant="control" color={selected ? colors.sheet.ink : colors.ink70} numberOfLines={1}>
        {label}
      </Text>
    </Press>
  );
}
