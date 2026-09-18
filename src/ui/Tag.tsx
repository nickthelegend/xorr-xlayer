/**
 * Tag.tsx — badge, chip, delta.
 *
 * design.md §2: `9.5–10px · 700 · letter-spacing .09em · uppercase`. Nothing below 9.5px.
 *
 * `tone` is the only way this component goes green or red, and both of those tones mean
 * P&L. `PERPETUAL`, `NO EXPIRY`, `MACRO`, `ON-CHAIN` are `neutral` or a custom pair taken
 * from the instrument's own colour — they are categories, not outcomes.
 *
 * §7: both P&L colours are paired with a sign or an explicit word, so the information
 * survives colour blindness. Pass "+0.44%" or "up 2.4% today", never a bare "2.4%".
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Text, type PriceTone } from './Text';
import { colors, radius, space } from './tokens';

export type TagTone = 'neutral' | 'up' | 'down' | 'warn' | 'solidUp' | 'solidDown';

const TONES: Readonly<Record<TagTone, { bg: string; fg: string }>> = Object.freeze({
  neutral: { bg: colors.neutralBg, fg: colors.ink50 },
  up: { bg: colors.upBg, fg: colors.up },
  down: { bg: colors.downBg, fg: colors.down },
  warn: { bg: colors.warnBg, fg: colors.warn },
  /** A filled chip on a chart edge — the TP / SL markers. */
  solidUp: { bg: colors.candleUp, fg: colors.ink },
  solidDown: { bg: colors.candleDown, fg: colors.ink },
});

export interface TagProps {
  label: string;
  tone?: TagTone;
  /** An instrument's own colour pair, e.g. gold's `PERPETUAL`. Overrides `tone`. */
  colors?: { bg: string; fg: string };
  /** 10 (default) or 9.5. */
  small?: boolean;
  /** Sentence-case rather than the uppercase the role normally forces — the delta chips
   *  read "up 2.4% today", which is a sentence, not a label. */
  sentence?: boolean;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Tag({
  label,
  tone = 'neutral',
  colors: override,
  small = false,
  sentence = false,
  radius: r = radius.square,
  style,
  testID,
}: TagProps) {
  const skin = override ?? TONES[tone];

  return (
    <View
      testID={testID}
      style={[
        {
          alignSelf: 'flex-start',
          paddingVertical: space.s4,
          paddingHorizontal: space.s8,
          borderRadius: r,
          backgroundColor: skin.bg,
        },
        style,
      ]}
    >
      <Text
        variant={small ? 'tagSm' : 'tag'}
        color={skin.fg}
        numberOfLines={1}
        style={sentence ? { textTransform: 'none', letterSpacing: 0 } : undefined}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * The delta chip that sits under a hero balance: a pill-radius `Tag` in sentence case.
 * Always carries a sign or the word "up"/"down" — never a bare number.
 */
export function DeltaChip({
  label,
  tone,
  style,
  testID,
}: {
  label: string;
  /**
   * `neutral` is not a third colour so much as the ABSENCE of a claim: a portfolio that has
   * moved by nothing has neither gained nor lost, and a "+$0.00" chip in profit-green reads
   * as a win that did not happen. Derive it with `pnlTone` rather than by hand.
   */
  tone: PriceTone;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const bg = tone === 'up' ? colors.upBg : tone === 'down' ? colors.downBg : colors.neutralBg;
  const fg = tone === 'up' ? colors.up : tone === 'down' ? colors.down : colors.ink55;
  return (
    <View
      testID={testID}
      style={[
        {
          alignSelf: 'flex-start',
          paddingVertical: space.s2,
          paddingHorizontal: space.s8,
          borderRadius: radius.card,
          backgroundColor: bg,
        },
        style,
      ]}
    >
      <Text variant="chipDelta" color={fg} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}
