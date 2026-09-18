/**
 * Keypad.tsx — the 3×4 numeric keypad. screens.md screens 14 and the DCA setup.
 *
 * "56pt rows, 24pt glyphs, hover `#F2F2F5`" — keys 1-9, ".", 0, "⌫". The press state is the
 * key's own background rather than an opacity fade: at 24pt a glyph dimming to 85% is hard
 * to see, and on a keypad the user needs to know which key registered.
 *
 * The keypad does not hold the amount and does not know the rules. `keypadPress` in
 * state/derived.ts owns those (max 7 characters, one decimal point, backspace pops, a
 * leading zero is replaced) so the two screens that use a keypad cannot disagree about them.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Press } from './Press';
import { Text } from './Text';
import { familyFor } from './fonts';
import { colors, radius } from './tokens';

/** The layout, in reading order. `⌫` is U+232B, not a bare "x". */
export const KEYPAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'] as const;

export type KeypadKey = (typeof KEYPAD_KEYS)[number];

const ROW_H = 56;
const GLYPH = 24;

export interface KeypadProps {
  onPress: (key: KeypadKey) => void;
  /** On the white sheet. */
  light?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Keypad({ onPress, light = false, style, testID }: KeypadProps) {
  const ink = light ? colors.sheet.ink : colors.ink;
  const pressBg = light ? colors.sheet.fill : colors.surfaceAlt;

  return (
    <View testID={testID} style={[{ flexDirection: 'row', flexWrap: 'wrap' }, style]}>
      {KEYPAD_KEYS.map((k) => (
        <Key key={k} glyph={k} ink={ink} pressBg={pressBg} onPress={() => onPress(k)} />
      ))}
    </View>
  );
}

function Key({
  glyph,
  ink,
  pressBg,
  onPress,
}: {
  glyph: KeypadKey;
  ink: string;
  pressBg: string;
  onPress: () => void;
}) {
  const [pressed, setPressed] = React.useState(false);

  return (
    <Press
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityRole="button"
      accessibilityLabel={glyph === '⌫' ? 'Delete' : glyph}
      style={{
        width: '33.333%',
        height: ROW_H,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.tileSm,
        backgroundColor: pressed ? pressBg : 'transparent',
      }}
    >
      <Text
        style={{
          fontFamily: familyFor('500'),
          fontWeight: '500',
          fontSize: GLYPH,
          lineHeight: GLYPH * 1.2,
          color: ink,
        }}
      >
        {glyph}
      </Text>
    </Press>
  );
}
