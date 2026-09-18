/**
 * KillSwitchChip.tsx — whether the agents can trade, said in one chip.
 *
 * A dot and a word. What it may say, and the one rule it keeps — **armed only when the chain itself said live** — are
 * `src/state/killSwitch.ts`, kept pure and tested, because this is the most dangerous label in the app to get wrong.
 *
 * ## The colours
 *
 * Green here is sanctioned and is the app's one exception to "green and red are P&L only": `design-system.test.ts`
 * already carves it out for the kill-switch status, which reports whether agents are trading rather than whether
 * anything made money. It is used for exactly one state — armed — because that is the state it is an exception for.
 *
 * Not-knowing takes `warn`, never the grey of a settled "off". A grey dot reads as *resolved and harmless*, and a chip
 * that quietly rounds "could not ask" down to "stopped" fails in the reassuring direction — telling someone the agents
 * are off when they may be trading.
 *
 * ## It does not animate
 *
 * `animations.md` bans a pulsing status dot outright: "a pulsing dot on a bottom tab is a distraction the user can't
 * dismiss." That reasoning holds here. The chip changes when the chain's answer changes, and a state that is genuinely
 * in motion — a revoke going through — has its own screen for it (`StopCurtain`).
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { killSwitchChip, type ChainStandingKind } from '@/state/killSwitch';
import { Text } from './Text';
import { colors, radius, space } from './tokens';

/** The dot. 7pt — screens.md gives this one exactly, and the Safety chip already uses it. */
const DOT = 7;

export interface KillSwitchChipProps {
  /** The chain's answer, or undefined while the read is out. */
  standing: ChainStandingKind | undefined;
  /** The read came back unable to answer. Outranks `standing`: a stale answer shown as current is the bug this avoids. */
  failed?: boolean;
  /** Show the sentence under the chip. Off where the chip sits in a row with no room for it. */
  detail?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function KillSwitchChip({ standing, failed = false, detail = false, style, testID }: KillSwitchChipProps) {
  const chip = killSwitchChip(standing, failed);
  /*
   * Green only for armed — the one state the P&L-colour exception exists for. Amber for the two that do not know, so
   * they cannot be mistaken for a settled, harmless "off". Grey for the three that are genuinely, knowably off.
   */
  const tone = chip.armed ? colors.up : chip.unknown ? colors.warn : colors.ink30;

  return (
    <View testID={testID} style={style}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.s8,
          alignSelf: 'flex-start',
          backgroundColor: colors.surfaceAlt,
          borderRadius: radius.card,
          paddingHorizontal: space.s12,
          paddingVertical: space.s6,
        }}
      >
        <View style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: tone }} />
        {/* The whole chip is one thing to a screen reader, and it hears the sentence rather than the word alone. */}
        <Text variant="tag" color={colors.ink} accessibilityLabel={chip.detail}>
          {chip.label.toUpperCase()}
        </Text>
      </View>
      {detail ? (
        <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s6 }}>
          {chip.detail}
        </Text>
      ) : null}
    </View>
  );
}
