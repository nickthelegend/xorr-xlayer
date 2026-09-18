/**
 * Three dots, while the agent is working.
 *
 * The chat previously said "Thinking…" in the header, twelve lines above where the answer was about
 * to appear — so the one place you were looking had no sign anything was happening. A model call
 * takes seconds and silence for seconds reads as a dropped message.
 *
 * In the agent's own colour, at the left margin where its reply will land, so the indicator is
 * literally standing in the answer's place.
 *
 * The dots pulse together rather than in sequence. A travelling wave down a row of dots is a
 * staggered reveal, which animations.md rules out for the same reason it rules them out in a list:
 * it dramatises arrival. Uniform breathing says "working" without performing it.
 */
import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { duration, timing, useReducedMotion } from '@/ui/motion';
import { space } from '@/ui';

const DOT = 6;
const DIM = 0.25;

export function Thinking({ color }: { color: string }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (reduced) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(withTiming(DIM, timing(duration.pulse, reduced)), -1, true);
  }, [reduced, opacity]);

  const anim = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      accessibilityLabel="Thinking"
      style={[{ flexDirection: 'row', gap: space.s6, alignSelf: 'flex-start' }, anim]}
    >
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: color }}
        />
      ))}
    </Animated.View>
  );
}
