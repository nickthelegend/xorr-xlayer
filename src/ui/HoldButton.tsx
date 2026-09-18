/**
 * HoldButton.tsx — the stop, which asks to be held (FEATURES.md #3).
 *
 * design.md §5's destructive button — #EF3B36 under white, on the pill radius — filling from the left while a finger
 * stays on it, and committing at 600 ms with one heavy tap. Lifted sooner, the fill runs back and nothing is sent. Why a
 * hold, and why only where one is possible, is `holdToCommit.ts`; this file is the gesture and the drawing.
 *
 * The fill is the hold's clock drawn, so it is linear and reaches the end at the moment the commit happens (motion.ts,
 * HOLD). Under reduced motion it is simply full while the press is down, and the press is still held for the commit.
 * The label never moves.
 *
 * Only the stop asks for a hold. Resume, Reconnect and a grant stay `Button` taps.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Press } from './Press';
import { Text } from './Text';
import { heavyTap } from './haptics';
import { HOLD_IDLE, holdRemaining, holdStep, type HoldEvent, type HoldState } from './holdToCommit';
import { duration, holdFill, timing, useReducedMotion } from './motion';
import { alpha, colors, radius, size, space } from './tokens';

/** The fill: the button's own red, deepened, so the white label keeps its contrast as the fill passes under it. */
const FILL = alpha(colors.bg, 0.24);

export interface HoldButtonProps {
  label: string;
  /**
   * Runs when the hold completes, or on the one activation a screen reader, a key or a switch makes. May return a
   * promise; nothing commits again until it settles.
   */
  onCommit: () => void | Promise<unknown>;
  /** What a screen reader says after the label: the gesture, e.g. "Hold to stop". */
  accessibilityHint?: string;
  /** In flight: presses are refused and a spinner shows. */
  loading?: boolean;
  disabled?: boolean;
  /** §5: 52–56. The stop is the tall one. */
  height?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Whether a screen reader is on, where that can be known.
 *
 * On the web it cannot: react-native-web answers `true` for every visitor. Believing it would turn every click into a
 * commit and leave the hold nowhere a mouse is. There the press says instead — a key never starts a hold
 * (`pressedByKey`), and an assistive click arrives with no press before it, which commits (`holdToCommit.ts`).
 */
function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let alive = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
      if (alive) setOn(enabled);
    });
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}

/** A press made with Enter or Space: react-native-web passes the key event as the press's own. */
function pressedByKey(event: GestureResponderEvent): boolean {
  return typeof (event.nativeEvent as unknown as { key?: unknown }).key === 'string';
}

export function HoldButton({
  label,
  onCommit,
  accessibilityHint,
  loading = false,
  disabled = false,
  height = size.buttonLg,
  style,
  testID,
}: HoldButtonProps) {
  const reduced = useReducedMotion();
  const screenReader = useScreenReader();
  const off = disabled || loading;
  const fill = useSharedValue(0);
  const machine = useRef<HoldState>(HOLD_IDLE);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The handler and the motion setting as of the latest render, for a timer an earlier render armed.
  const latest = useRef({ onCommit, reduced });
  useEffect(() => {
    latest.current = { onCommit, reduced };
  }, [onCommit, reduced]);

  const send = useCallback(
    function send(event: HoldEvent): void {
      const before = machine.current;
      const { state, commit } = holdStep(before, event);
      machine.current = state;
      const stillness = latest.current.reduced;

      if (state.phase === 'holding') {
        if (before.phase !== 'holding') fill.value = withTiming(1, holdFill(stillness));
        // Armed as the hold begins, and again when the timer fired a moment early.
        if ((before.phase !== 'holding' || event.type === 'elapsed') && 'at' in event) {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => send({ type: 'elapsed', at: Date.now() }), holdRemaining(state, event.at));
        }
      } else if (before.phase === 'holding') {
        clearTimeout(timer.current);
        // Let go too soon, or switched off: the fill runs back, and nothing was sent.
        if (state.phase === 'idle') fill.value = withTiming(0, timing(duration.fast, stillness));
      }

      if (!commit) return;
      heavyTap();
      const result = latest.current.onCommit();
      void Promise.resolve(result).finally(() => {
        machine.current = holdStep(machine.current, { type: 'settled' }).state;
        fill.value = withTiming(0, timing(duration.fast, latest.current.reduced));
      });
    },
    [fill],
  );

  // Switched off mid-hold, the hold ends. And a timer outliving the button commits nothing.
  useEffect(() => {
    if (off) send({ type: 'cancel' });
  }, [off, send]);
  useEffect(() => {
    const pending = timer;
    return () => clearTimeout(pending.current);
  }, []);

  const fillStyle = useAnimatedStyle(() => ({ width: `${fill.value * 100}%` }));
  const ink = disabled ? colors.ink35 : colors.ink;

  return (
    <Press
      testID={testID}
      disabled={off}
      onPressIn={(event) => send({ type: 'down', at: Date.now(), hold: !screenReader && !pressedByKey(event) })}
      onPressOut={() => send({ type: 'up', at: Date.now() })}
      onPress={() => send({ type: 'activate', at: Date.now() })}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: off, busy: loading }}
      style={[
        {
          height,
          borderRadius: radius.sheet,
          overflow: 'hidden',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: space.s8,
          paddingHorizontal: space.s20,
          backgroundColor: disabled ? colors.control : colors.candleDown,
        },
        style,
      ]}
    >
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, pointerEvents: 'none' }}>
        <Animated.View style={[{ height: '100%', backgroundColor: FILL }, fillStyle]} />
      </View>
      {loading ? <ActivityIndicator size="small" color={ink} /> : null}
      <Text variant="button" color={ink} numberOfLines={1}>
        {label}
      </Text>
    </Press>
  );
}
