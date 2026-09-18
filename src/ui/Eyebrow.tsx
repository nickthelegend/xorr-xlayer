/**
 * Eyebrow.tsx — the small caps label above a value.
 *
 * design.md §2: `10–11px · 600 · letter-spacing .12em · uppercase`, in `ink32`.
 * §7: `ink28`/`ink30`/`ink32` are for decorative labels only — never put a value or an
 * action in one. An eyebrow names the value below it; it is never the value.
 *
 * The tracking is the point of this role: at 10–11px, .12em is what keeps uppercase
 * legible. `type.ts` has already converted it to absolute points (11 × .12 = 1.32).
 */
import React from 'react';
import { type StyleProp, type TextStyle } from 'react-native';
import { Text } from './Text';
import { colors } from './tokens';

export interface EyebrowProps {
  children: React.ReactNode;
  /** 11 (default) or 10 for a tighter tile. */
  small?: boolean;
  color?: string;
  /** On the light sheet the ramp flips to `sheetMuted`. */
  light?: boolean;
  align?: TextStyle['textAlign'];
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

export function Eyebrow({
  children,
  small = false,
  color,
  light = false,
  align,
  numberOfLines,
  style,
  testID,
}: EyebrowProps) {
  return (
    <Text
      testID={testID}
      variant={small ? 'eyebrowSm' : 'eyebrow'}
      color={color ?? (light ? colors.sheet.muted : undefined)}
      align={align}
      numberOfLines={numberOfLines}
      style={style}
    >
      {children}
    </Text>
  );
}
