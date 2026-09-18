/**
 * RadioCard.tsx — an exclusive choice with consequences.
 *
 * design.md §3 lists "radio cards" among the 22–26 radii; screens 9 and 21 both draw them:
 * `surface`, radius 22, padding 16, a 20pt radio, a title and a detail line, and an optional
 * right-aligned tag chip. Selected swaps the hairline card border for `selectedBorder` and
 * fills the radio with a 6pt white ring.
 *
 * A `Pill` says which slice of a list you are looking at. A `RadioCard` says which of several
 * things is about to happen to your money — so it is a card with room to explain itself,
 * and the whole card is the target rather than a small circle beside it.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Press } from './Press';
import { Tag } from './Tag';
import { Text } from './Text';
import { border, colors, radius, space } from './tokens';

/** 20pt radio; a 6pt white ring reads as filled at that diameter without a second view. */
const RADIO = 20;
const RADIO_FILL = 6;
const RADIO_RING = 1.5;

export interface RadioCardProps {
  title: string;
  detail?: string;
  /** A short right-aligned qualifier — "Free", "Instant", "On-chain". */
  tag?: string;
  selected: boolean;
  onPress?: () => void;
  /** Hides the radio itself where the card's border already carries the selection. */
  showRadio?: boolean;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function RadioCard({
  title,
  detail,
  tag,
  selected,
  onPress,
  showRadio = true,
  children,
  style,
  testID,
}: RadioCardProps) {
  return (
    <Press
      testID={testID}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      /*
       * See `Segmented.tsx`: React Native Web drops `accessibilityState.selected`, so the line
       * above reaches the DOM as nothing and this control announces no state at all. The web
       * attribute valid for THIS role is added alongside it; native keeps reading the line above.
       */
      aria-checked={selected}
      accessibilityLabel={detail ? `${title}, ${detail}` : title}
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: radius.panel,
          padding: space.s16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.s14,
        },
        selected ? border.selected : border.card,
        style,
      ]}
    >
      {showRadio ? (
        <View
          style={{
            width: RADIO,
            height: RADIO,
            borderRadius: radius.full,
            borderWidth: selected ? RADIO_FILL : RADIO_RING,
            borderColor: selected ? colors.ink : colors.radioBorder,
          }}
        />
      ) : null}
      <View style={{ flex: 1, gap: space.s2 }}>
        <Text variant="rowPrimary">{title}</Text>
        {detail ? (
          <Text variant="secondarySm" numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
        {children}
      </View>
      {tag ? <Tag label={tag} small colors={{ bg: colors.surfaceAlt, fg: colors.ink55 }} /> : null}
    </Press>
  );
}
