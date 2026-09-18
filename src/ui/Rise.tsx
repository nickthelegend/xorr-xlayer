/**
 * Rise.tsx — how a section arrives.
 *
 * Wrap a block in `<Rise index={n}>` and it fades up into place `n` beats after the screen appears,
 * the way the reference video's sheets fill in from the top down. Screens never touch reanimated's
 * entrance builders themselves: this is the one place arrival motion is made, so it is the one place
 * that has to honour reduced motion — and does.
 *
 * Drawn from a timing (`riseTo` in motion.ts) rather than an `entering` builder, so the web arrives on
 * the same ease-out curve as the phone; motion.ts says why the builder could not.
 */
import React, { useEffect } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { riseTo, useReducedMotion } from './motion';

/** How far a section travels as it arrives: the 25pt reanimated's FadeInDown travelled, so nothing looks different. */
const RISE_FROM = 25;

export interface RiseProps {
  /** Its place in the arrival order — 0 arrives first. */
  index?: number;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function Rise({ index = 0, children, style }: RiseProps) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = riseTo(index, reduced);
  }, [index, reduced, progress]);

  const arriving = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * RISE_FROM }],
  }));

  return <Animated.View style={[style, arriving]}>{children}</Animated.View>;
}
