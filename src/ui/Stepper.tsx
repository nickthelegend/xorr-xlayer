/**
 * Stepper.tsx — − / value / +.
 *
 * design.md §5:
 *   [26px circle −] [value 14.5/700, min-width 70–88, centre] [26px circle +]
 *   gap 8–10 · circles #1B1C1E (dark) or #F2F2F5 (light sheet) · glyph 15px
 *
 * The fixed `min-width` on the value is mandatory: without it the row jitters left and
 * right as digits change, and the user reads the jitter as the number being unstable.
 * The value is tabular for the same reason.
 *
 * §7: hit targets are ≥44. The circles stay 26px and grow their *touch area* — a 44px
 * circle would break the row's proportions and read as a button rather than a nudge.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Press } from './Press';
import { Text, Value } from './Text';
import { colors, radius, size, space } from './tokens';

export interface StepperProps {
  /** Already formatted — state.md wants `toLocaleString('en-US')`, not `toFixed`. */
  value: string;
  onDecrement: () => void;
  onIncrement: () => void;
  /** At the bottom of the range. The glyph dims; the target stays. */
  canDecrement?: boolean;
  canIncrement?: boolean;
  /** §5: 70–88. */
  valueMinWidth?: number;
  /** Circle diameter. 26 on a dark row, 24 in a light sheet's tighter header. */
  circle?: number;
  light?: boolean;
  /** Renders the value inside a coloured chip — the TP/SL steppers on the Auto Close sheet. */
  chip?: { bg: string; fg: string };
  align?: 'center' | 'right';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Stepper({
  value,
  onDecrement,
  onIncrement,
  canDecrement = true,
  canIncrement = true,
  valueMinWidth = size.stepperValueMinW,
  circle = size.stepperCircle,
  light = false,
  chip,
  align = 'center',
  style,
  testID,
}: StepperProps) {
  return (
    <View
      testID={testID}
      style={[
        { flexDirection: 'row', alignItems: 'center', gap: light ? space.s8 : size.stepperGap },
        style,
      ]}
    >
      <StepperButton
        glyph="−"
        onPress={onDecrement}
        enabled={canDecrement}
        circle={circle}
        light={light}
        label="Decrease"
      />

      {chip ? (
        <View
          style={{
            minWidth: valueMinWidth,
            alignItems: 'center',
            backgroundColor: chip.bg,
            borderRadius: radius.tile,
            paddingVertical: space.s4,
            paddingHorizontal: space.s12,
          }}
        >
          <Value variant="chipLg" color={chip.fg}>
            {value}
          </Value>
        </View>
      ) : (
        <Value
          color={light ? colors.sheet.ink : colors.ink}
          align={align === 'right' ? 'right' : 'center'}
          style={{ minWidth: valueMinWidth }}
        >
          {value}
        </Value>
      )}

      <StepperButton
        glyph="+"
        onPress={onIncrement}
        enabled={canIncrement}
        circle={circle}
        light={light}
        label="Increase"
      />
    </View>
  );
}

/** Enough leading for a `+` / `−` to sit optically centred in the circle. */
const GLYPH_LEADING = 3;

function StepperButton({
  glyph,
  onPress,
  enabled,
  circle,
  light,
  label,
}: {
  glyph: string;
  onPress: () => void;
  enabled: boolean;
  circle: number;
  light: boolean;
  label: string;
}) {
  return (
    <Press
      onPress={onPress}
      disabled={!enabled}
      /* The drawn circle stays 26px; the target grows to 44 in both axes. */
      hitHeight={circle}
      hitWidth={circle}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        width: circle,
        height: circle,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: light ? colors.sheet.fill : colors.control,
      }}
    >
      <Text
        variant="sheetTitle"
        color={enabled ? (light ? colors.sheet.ink : colors.ink) : colors.ink32}
        /* §5 puts the glyph at 15px — between `cardTitle` and `sheetTitle`, so the size
           comes from `size.stepperGlyph` and the line box follows it. */
        style={{ fontSize: size.stepperGlyph, lineHeight: size.stepperGlyph + GLYPH_LEADING }}
      >
        {glyph}
      </Text>
    </Press>
  );
}
