/**
 * FillReceipt.tsx — what a confirmed fill leaves behind.
 *
 * A fill used to end with a signature in a card and nothing else. The signature proves *a* transaction happened; it
 * does not say where it happened, and where is the part that decides what the signature even means. A `jupiter-route`
 * fill and a `venue-vault` fill produce equally valid signatures for two different events, and the app was showing
 * them identically.
 *
 * So the receipt says all three: **the venue**, the signature, and the slot it landed in.
 *
 * ## Nothing here is ever stood in for
 *
 * Each of the three is drawn only from a real recorded value. A missing slot draws no slot; an unrecognised venue is
 * printed verbatim rather than given a friendly name this build cannot justify; a run that reached no venue at all
 * says so in words, because "blocked before it reached a venue" and "we could not read the venue" are different facts
 * and a blank space says neither. The naming rules, including the one forbidding a vault settlement from being called
 * a Jupiter swap, are `fillVenue.ts` and are tested there.
 *
 * ## The motion
 *
 * It arrives once, when the fill does — opacity and a short rise on the arrival curve over `duration.enter`, the same
 * beat `<Rise>` gives a section. A receipt is the one thing on the screen that was not there a moment ago, so it is
 * the one thing entitled to an entrance; everything around it is already composed and does not move.
 *
 * It animates on the **signature it is given**, not on mount: re-reading a run that filled last week must not replay
 * its arrival. A receipt that was already there when the screen opened is simply there.
 *
 * Under reduced motion it is drawn in place, with every word and figure identical.
 */
import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { shortSignature, slotLabel, venueNaming } from './fillVenue';
import { arrival, duration, useReducedMotion } from './motion';
import { SheetCard } from './SheetCard';
import { Text, Value } from './Text';
import { colors, radius, space } from './tokens';

/** How far the receipt rises into place. The 25pt `<Rise>` travels, so an arrival looks like every other arrival. */
const RISE = 25;

export interface FillReceiptProps {
  /** The settling transaction, as the executor recorded it. Without one there is no receipt to draw. */
  signature: string;
  /** The venue that filled it (`strategy_runs.venue`). Null for a run that never reached one. */
  venue?: string | null;
  /** The slot it landed in, where the executor kept it. Absent draws no slot rather than a zero. */
  slot?: number | null;
  /**
   * Play the arrival. Off for a receipt that was already on screen when it opened — a fill from last week did not just
   * happen, and animating it in would say that it did.
   */
  animate?: boolean;
  testID?: string;
}

export function FillReceipt({ signature, venue, slot, animate = true, testID }: FillReceiptProps) {
  const reduced = useReducedMotion();
  const naming = venueNaming(venue);
  const slotShown = slotLabel(slot);

  /* 0 before it arrives, 1 in place. Seeded at 1 when there is no arrival to play. */
  const landed = useSharedValue(animate ? 0 : 1);
  /* The signature this receipt last arrived for: a different fill is a new arrival, the same one is not. */
  const arrivedFor = useRef<string | undefined>(animate ? undefined : signature);

  useEffect(() => {
    if (!animate || arrivedFor.current === signature) return;
    arrivedFor.current = signature;
    landed.set(0);
    landed.set(withTiming(1, arrival(duration.enter, reduced)));
  }, [signature, animate, reduced, landed]);

  const arriving = useAnimatedStyle(() => ({
    opacity: landed.get(),
    transform: [{ translateY: (1 - landed.get()) * RISE }],
  }));

  return (
    <Animated.View testID={testID} style={arriving}>
      <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
        <Text variant="footnote" color={colors.ink55}>
          FILLED AT
        </Text>

        {/*
          The venue, first and unhidden. It is the field that says what the signature below it means, and it was the
          one the old receipt left out entirely.
        */}
        {naming ? (
          <>
            <Text variant="rowPrimary" style={{ marginTop: space.s4 }}>
              {naming.label}
            </Text>
            {naming.detail ? (
              <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s4 }}>
                {naming.detail}
              </Text>
            ) : (
              /* An identifier this build cannot interpret. Shown as recorded, and said to be unrecognised. */
              <Text variant="secondarySm" color={colors.ink45} style={{ marginTop: space.s4 }}>
                This build does not recognise that venue, so it is shown exactly as the executor recorded it.
              </Text>
            )}
          </>
        ) : (
          <Text variant="secondarySm" color={colors.ink45} style={{ marginTop: space.s4 }}>
            No venue was recorded for this fill.
          </Text>
        )}

        <View style={{ height: 1, backgroundColor: colors.cardBorder, marginVertical: space.s12 }} />

        <Text variant="footnote" color={colors.ink55}>
          TRANSACTION
        </Text>
        {/* In full — this is the thing a reader takes to an explorer, and a truncation would cost them that. */}
        <Text variant="footnoteSm" color={colors.ink65} style={{ marginTop: space.s4 }}>
          {signature}
        </Text>

        {slotShown ? (
          <>
            <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s12 }}>
              SLOT
            </Text>
            <Value variant="footnoteSm" color={colors.ink65} style={{ marginTop: space.s4 }}>
              {slotShown}
            </Value>
          </>
        ) : null}
      </SheetCard>
    </Animated.View>
  );
}

export { shortSignature, slotLabel, venueNaming };
