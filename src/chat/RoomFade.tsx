/**
 * RoomFade.tsx — one room dissolving into the other.
 *
 * The drawer draws from a palette that is swapped in place (`applyChatTheme`) and everything inside is keyed by the
 * room, so a change used to land whole between two frames: the ground, every card, every word and the handle, all at
 * once. On the brightest change the app can make — a lavender room to true black or back — that is a flash, and on a
 * phone that switches itself at dusk it is a flash nobody asked for.
 *
 * So the room being LEFT stays for a moment, painted over the one that has ARRIVED, and fades out. What dissolves is its
 * ground: the new room is already fully drawn underneath, so the fade reveals rather than assembles. Nothing is
 * half-built at any point — both rooms are complete, and one of them is simply becoming transparent.
 *
 * 250ms, the interaction scale, because the change answers a tap. It is the same 250 whether the phone changed its own
 * appearance or a finger did: a dissolve slower than that reads as the app catching up rather than answering.
 *
 * Under reduced motion there is no fade — the room changes, which is the whole of the information.
 *
 * It takes no touches and no screen-reader focus. For the quarter-second it is up it is a pane of colour, not a surface.
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { duration, timing, useReducedMotion } from '@/ui';
import { groundOf, type ChatThemeName } from './theme';

export function RoomFade({ room }: { room: ChatThemeName }) {
  const reduced = useReducedMotion();
  /** The room being left behind, kept only for as long as it takes to disappear. */
  const [leaving, setLeaving] = useState<ChatThemeName>();
  const seen = useRef(room);
  const held = useSharedValue(0);

  useEffect(() => {
    if (seen.current === room) return;
    const was = seen.current;
    seen.current = room;
    if (reduced) return;
    setLeaving(was);
    held.set(1);
    held.set(withTiming(0, timing(duration.slow, reduced)));
  }, [room, reduced, held]);

  const fading = useAnimatedStyle(() => ({ opacity: held.get() }));

  if (leaving === undefined) return null;

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, fading]}
    >
      <LinearGradient colors={[...groundOf(leaving)]} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}
