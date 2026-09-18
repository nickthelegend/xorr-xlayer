/**
 * CloseResult.tsx — what a close realised, once it has.
 *
 * Closing said "Sold 0.0412 WETH for $104.20" and stopped there, leaving the one thing the person wants to know — *did
 * I make anything* — to be worked out against a cost basis they cannot see. This says it.
 *
 * The arithmetic, and the four cases where it refuses to say anything at all, are `src/state/profitClose.ts`.
 *
 * ## Why this is not a celebration
 *
 * `docs/IDEAS-100.md` rejected confetti on a first fill, and was right to. A trading app that throws a party when a
 * number goes up has taken a side on the user's behalf, and it will look grotesque on the day the same person closes at
 * a loss — which the same component has to render, with the same weight.
 *
 * So the moment is one 250ms scale-in, once, on arrival: the single fill-confirmation animation `animations.md`
 * sanctions, and the same one `FillReceipt` uses. A gain gets the P&L green it has earned — this is a realised profit,
 * which is the one thing that colour is *for*. A loss gets the red. A close that came out level gets neither.
 *
 * And a close whose gain cannot be honestly worked out gets **no figure, no colour and no motion** — just the sentence
 * saying which part is missing. A moment that celebrates is worth nothing unless it is capable of staying silent.
 */
import React, { useEffect, useRef } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { profitClose, UNMEASURED_REASON, type CloseOutcome } from '@/state/profitClose';
import { money, percent } from './format';
import { duration, timing, useReducedMotion } from './motion';
import { Price, Text } from './Text';
import { colors, radius, space } from './tokens';

/** Where the arrival starts. The same scale-in the filled-order card takes. */
const FROM = 0.96;

export interface CloseResultProps {
  /** What the executor answered, plus the position's own cost basis. */
  outcome: CloseOutcome;
  /** The symbol sold, for the sentence above the figure. */
  symbol: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function CloseResult({ outcome, symbol, style, testID }: CloseResultProps) {
  const reduced = useReducedMotion();
  const result = profitClose(outcome);

  /* 0 before it arrives, 1 in place. Keyed to the close, so a re-render does not replay it. */
  const landed = useSharedValue(0);
  const key = `${symbol}:${outcome.units}:${outcome.proceedsUsd}:${result.kind}`;
  const arrived = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (arrived.current === key) return;
    arrived.current = key;
    landed.set(0);
    landed.set(withTiming(1, timing(duration.slow, reduced)));
  }, [key, reduced, landed]);

  const arriving = useAnimatedStyle(() => ({
    opacity: landed.get(),
    transform: [{ scale: FROM + landed.get() * (1 - FROM) }],
  }));

  const measured = result.kind === 'profit' || result.kind === 'loss' || result.kind === 'flat';
  /* Green for a realised gain — the one thing this colour is for. Red for a realised loss. Neither for level. */
  const tone = result.kind === 'profit' ? 'up' : result.kind === 'loss' ? 'down' : 'neutral';

  return (
    <Animated.View
      testID={testID}
      style={[
        {
          padding: space.s14,
          borderRadius: radius.panel,
          backgroundColor: colors.surfaceAlt,
          borderWidth: 1,
          borderColor: colors.cardBorder,
        },
        style,
        arriving,
      ]}
    >
      <Text variant="footnote" color={colors.ink55}>
        {measured ? 'REALISED ON THIS SALE' : 'SOLD'}
      </Text>

      {measured ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.s8, marginTop: space.s4 }}>
            <Price variant="amountMd" tone={tone} figure="own">
              {money(result.realisedUsd, { signed: true })}
            </Price>
            {result.kind === 'profit' || result.kind === 'loss' ? (
              <Price variant="secondary" tone={tone} figure="own">
                {percent(result.pct)}
              </Price>
            ) : null}
          </View>
          <Text variant="footnote" color={colors.ink45} style={{ marginTop: space.s6 }} figure="own">
            {`Against what these ${symbol} units cost.`}
          </Text>
        </>
      ) : (
        /* No figure, no colour, no claim — only which part is missing. The sale still happened. */
        <Text variant="body" color={colors.ink55} style={{ marginTop: space.s4 }}>
          {UNMEASURED_REASON[result.why]}
        </Text>
      )}
    </Animated.View>
  );
}
