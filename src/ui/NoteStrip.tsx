/**
 * NoteStrip.tsx — agent commentary.
 *
 * design.md §5:
 *   display:flex · gap 10 · background #0C0C0D · radius 18 · padding 13
 *   [16–22 orb or dot, flex:none, margin-top 1] [11.5/1.5 ink45]
 *
 * Used wherever an agent explains itself. The dot colour encodes the event class:
 *   #2BD87A acted · #E8C64A adjusted risk · #FF453A blocked
 *
 * Those are the P&L colours doing P&L work — "acted" is a fill, "blocked" is a trade that
 * did not happen. They are not a severity scale and not decoration.
 *
 * copy.md: agent messages are first person and factual, and always state what the agent
 * did or will do. This component renders the sentence; it does not soften it.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { AssetMark } from './AgentOrb';
import type { FigureKind } from './mask';
import { Text } from './Text';
import { colors, radius, size, space, type Gradient } from './tokens';

/** What the agent did. Drives the dot colour. */
export type NoteKind = 'acted' | 'risk' | 'blocked';

/** §5 gives this one a 13px padding — between `s12` and `s14`, and deliberate. */
const NOTE_PADDING = 13;

/**
 * The classification colour for an event. Exported because the activity list and the inbox
 * draw the same three dots without the strip around them, and three screens agreeing on
 * what "risk" looks like should not depend on three screens remembering.
 */
export const noteDotColor: Readonly<Record<NoteKind, string>> = Object.freeze({
  acted: colors.up,
  risk: colors.warn,
  blocked: colors.down,
});

export interface NoteStripProps {
  children: React.ReactNode;
  /** The agent's gradient — renders a 22px orb as the leading mark. */
  gradient?: Gradient;
  /** Without a gradient, a 16px dot in the event-class colour. */
  kind?: NoteKind;
  /** §5: 16–22. */
  markSize?: number;
  /**
   * A sentence that carries the person's money — "Sold 0.5000 WETH for $1,200.00." — says which figure it is, and hides
   * it while balances are hidden (FEATURES.md #47). Unsaid, the sentence is words.
   */
  figure?: FigureKind;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function NoteStrip({
  children,
  gradient,
  kind = 'acted',
  markSize,
  figure,
  style,
  testID,
}: NoteStripProps) {
  const dotSize = markSize ?? (gradient ? size.noteOrb : size.noteDot);

  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: space.s10,
          backgroundColor: colors.surface,
          borderRadius: radius.note,
          padding: NOTE_PADDING,
        },
        style,
      ]}
    >
      {gradient ? (
        <AssetMark gradient={gradient} size={dotSize} style={{ marginTop: 1 }} />
      ) : (
        <View
          style={{
            width: dotSize,
            height: dotSize,
            borderRadius: radius.full,
            backgroundColor: noteDotColor[kind],
            marginTop: 1,
          }}
        />
      )}
      <Text variant="secondarySm" color={colors.ink55} style={{ flex: 1 }} figure={figure}>
        {children}
      </Text>
    </View>
  );
}
