/**
 * Progress.tsx — the onboarding progress header. screens.md screens 7/8/9.
 *
 * A back circle, a 4pt track, and an `n/total` counter. animations.md puts the track at
 * 250ms — the longest duration in the system — "so it reads as progress" rather than as a
 * value snapping into place.
 *
 * The width is driven from a `useSharedValue` seeded with the current step and advanced in
 * a `useEffect`. A `useDerivedValue` returning `withTiming` would start at 0 and animate up
 * on mount, which is an entrance animation, and animations.md has none.
 */
import React, { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { BackButton } from './IconButton';
import { Text } from './Text';
import { timing, useReducedMotion } from './motion';
import { colors, duration, space } from './tokens';

const TRACK = 4;

export interface ProgressProps {
  /** 1-based. `step === total` is a full bar. */
  step: number;
  total: number;
  onBack?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Progress({ step, total, onBack, style, testID }: ProgressProps) {
  const reduced = useReducedMotion();
  const target = total > 0 ? Math.max(0, Math.min(1, step / total)) : 0;
  const pct = useSharedValue(target);

  useEffect(() => {
    pct.value = withTiming(target, timing(duration.slow, reduced));
  }, [target, reduced, pct]);

  const bar = useAnimatedStyle(() => ({ width: `${pct.value * 100}%` }));

  return (
    <View
      testID={testID}
      style={[{ flexDirection: 'row', alignItems: 'center', gap: space.s14 }, style]}
    >
      <BackButton onPress={onBack} />
      <View
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: total, now: step }}
        style={{
          flex: 1,
          height: TRACK,
          borderRadius: TRACK / 2,
          backgroundColor: colors.control,
          overflow: 'hidden',
        }}
      >
        <Animated.View
          style={[
            { height: TRACK, borderRadius: TRACK / 2, backgroundColor: colors.ink },
            bar,
          ]}
        />
      </View>
      <Text variant="footnote" color={colors.ink55}>
        {step}/{total}
      </Text>
    </View>
  );
}
