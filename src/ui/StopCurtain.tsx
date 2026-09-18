/**
 * StopCurtain.tsx — the moment the stop is pulled.
 *
 * The kill switch is the most consequential control in the app: it signs an on-chain revoke from the
 * person's own wallet, and after it every agent, strategy and stop-loss is inert. Until now it looked
 * like every other button finishing — the label changed, a badge went from green to red, and the
 * biggest thing this app can do passed with less ceremony than a segmented control.
 *
 * So it gets a screen of its own for the length of the transaction. A curtain comes down over
 * whatever you were reading, holds while the revoke is signed and confirmed, and then says — in
 * words, with a badge, and with a haptic the app uses for nothing else — that trading is stopped.
 *
 * ## What it is NOT
 *
 * It is not a progress animation standing in for a progress it does not have. `state` is the real
 * one: `signing` is a revoke actually in flight, and `stopped` only once `revoke()` has returned,
 * which it does only when the chain shows the policy revoked (`delegationChain.ts`). A failure takes
 * the curtain away again and the screen underneath says what went wrong, because a curtain that
 * stayed up over an error would be the app claiming a stop it did not make.
 *
 * It is also not dismissable while the transaction is in flight. There is nothing to go back to —
 * the signature is out — and a curtain a stray touch could clear would be a way to walk away from
 * this screen unsure whether trading stopped.
 *
 * ## The motion
 *
 * Three things move, one property each, and all three collapse to nothing under reduced motion,
 * where the curtain is simply there and the badge is simply drawn:
 *
 *   the blackout   opacity 0 → 1                         `enter`, arrival curve
 *   the curtain    translateY, its own height → 0        `enter`, arrival curve — it comes DOWN
 *   the badge      scale .94 → 1, once, when it confirms `slow` — the one fill-confirmation scale-in
 *                                                         animations.md sanctions
 *
 * The curtain is a red wash over a blackout rather than a red screen. This app is true black and a
 * full-bleed #EF3B36 reads as a crash; the wash is the same red the stop button wears, at the weight
 * the design gives a destructive surface.
 */
import React, { useEffect } from 'react';
import { ActivityIndicator, Modal, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Icon } from '@/design/Icon';
import { Button } from './Button';
import { killTap } from './haptics';
import { arrival, duration, timing, useReducedMotion } from './motion';
import { Text, Value } from './Text';
import { alpha, colors, radius, size, space } from './tokens';

/** How red the wash over the blackout is. The destructive surface's weight, not a full-bleed red screen. */
const WASH = 0.22;
/** The confirm badge's diameter, and where its scale-in starts. */
const BADGE = 76;
const BADGE_FROM = 0.94;

export type StopState = 'signing' | 'stopped';

/**
 * A transaction hash, short enough to read on one line and long enough to find.
 *
 * Both ends, never a prefix: the leading bytes of two hashes look alike, and a truncation someone cannot match against
 * an explorer is decoration shaped like proof. Anything already short is left exactly as it came.
 */
function shortSignature(hash: string): string {
  return hash.length <= 8 + 6 + 1 ? hash : `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

export interface StopCurtainProps {
  /**
   * The real state of the revoke, or undefined for no curtain.
   *
   * `signing`: the transaction is out and the chain has not confirmed it. `stopped`: `revoke()` has
   * returned, which happens only once the chain shows the policy revoked.
   */
  state?: StopState;
  /** Dismiss, offered only once it is stopped. */
  onDone: () => void;
  /** What stopped, in one line — e.g. how many agents and strategies were running. The screen knows; the curtain says. */
  detail?: string;
  /**
   * The revoke's own transaction, once the chain has confirmed it.
   *
   * Shown shortened under the badge, because "revoked on-chain" is a claim and this is the evidence for it — the one
   * thing on this screen someone can take away and check against a block explorer themselves. Absent until there is a
   * real hash: a placeholder here would be a fabricated receipt for the most consequential act in the app.
   */
  signature?: string;
  testID?: string;
}

export function StopCurtain({ state, onDone, detail, signature, testID }: StopCurtainProps) {
  const reduced = useReducedMotion();
  const { height } = useWindowDimensions();
  const open = state !== undefined;
  const stopped = state === 'stopped';

  /* 0 while the curtain is above the screen, 1 with it down. */
  const down = useSharedValue(0);
  /* 0 until the revoke is confirmed; the badge's one scale-in. */
  const confirmed = useSharedValue(0);

  useEffect(() => {
    down.set(withTiming(open ? 1 : 0, arrival(duration.enter, reduced)));
  }, [open, reduced, down]);

  useEffect(() => {
    if (!stopped) {
      confirmed.set(0);
      return;
    }
    confirmed.set(withTiming(1, timing(duration.slow, reduced)));
    // The one haptic the app keeps for this: a thud and a latch. Nothing else in the app says it.
    killTap();
  }, [stopped, reduced, confirmed]);

  const blackout = useAnimatedStyle(() => ({ opacity: down.get() }));
  const curtain = useAnimatedStyle(() => ({ transform: [{ translateY: (down.get() - 1) * height }] }));
  const badge = useAnimatedStyle(() => ({
    opacity: confirmed.get(),
    transform: [{ scale: BADGE_FROM + confirmed.get() * (1 - BADGE_FROM) }],
  }));

  if (!open) return null;

  return (
    <Modal
      visible
      transparent
      statusBarTranslucent
      // The curtain's own motion is the presentation; the platform's would play over it.
      animationType="none"
      // Android's back gesture while the signature is out must not clear it; once stopped, it is a way out.
      onRequestClose={stopped ? onDone : undefined}
    >
      <View
        testID={testID}
        accessibilityViewIsModal
        // Said, not only drawn: the whole point is that this is unmissable, and a screen reader hears it too.
        accessibilityLiveRegion="assertive"
        style={{ flex: 1 }}
      >
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }, blackout]} />
        <Animated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: alpha(colors.candleDown, WASH) }, curtain]}
        />

        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: space.gutter,
            gap: space.s16,
          }}
        >
          {stopped ? (
            <Animated.View
              style={[
                {
                  width: BADGE,
                  height: BADGE,
                  borderRadius: radius.full,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: colors.candleDown,
                },
                badge,
              ]}
            >
              <Icon name="check" size={34} color={colors.ink} />
            </Animated.View>
          ) : (
            <View style={{ width: BADGE, height: BADGE, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator size="large" color={colors.ink} />
            </View>
          )}

          <Text variant="titleLg" align="center">
            {stopped ? 'Trading stopped' : 'Stopping all trading'}
          </Text>
          <Text variant="body" color={colors.ink55} align="center" style={{ maxWidth: 300 }}>
            {stopped
              ? 'The permission is revoked on-chain. No agent, strategy or stop-loss can place an order. Your funds never left your wallet.'
              : 'Signing the revoke. It is stopped when the chain confirms it — not before.'}
          </Text>
          {detail ? (
            <Text variant="footnote" color={colors.ink45} align="center">
              {detail}
            </Text>
          ) : null}

          {/*
            The evidence, not another claim. `confirmStopped` has already seen this transaction revoke the policy, so by
            the time it is drawn it is a hash someone can paste into an explorer — which is the whole argument this app
            makes about itself.
          */}
          {stopped && signature ? (
            <View style={{ alignItems: 'center', gap: space.s4 }}>
              <Text variant="tagSm" color={colors.ink45}>
                CONFIRMED ON-CHAIN
              </Text>
              <Value variant="footnote" color={colors.ink55}>
                {shortSignature(signature)}
              </Value>
            </View>
          ) : null}

          {stopped ? (
            <Button
              label="Done"
              variant="primary"
              height={size.buttonLg}
              onPress={onDone}
              style={{ alignSelf: 'stretch', marginTop: space.s10 }}
            />
          ) : null}
        </View>
      </View>
    </Modal>
  );
}
