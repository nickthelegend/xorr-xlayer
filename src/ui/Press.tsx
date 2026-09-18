/**
 * Press.tsx — the one press behaviour.
 *
 * animations.md: pressed state is `opacity → .85`, instant, native `Pressable` feedback —
 * not a transition. There is no hover state anywhere in this app: a hover style on a
 * touch surface fires on web and on a stylus and nowhere else, so it is a second visual
 * language only some users ever see.
 *
 * `android_ripple={null}` is deliberate. The Material ripple draws a coloured circle that
 * ignores the component's own radius and reads as a second selection signal — on a
 * trading surface a stray highlight is exactly the kind of ambiguity design.md rules out.
 */
import React from 'react';
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { size } from './tokens';

/** The pressed opacity. One value, everywhere. */
export const PRESSED_OPACITY = 0.85;

export interface PressProps extends Omit<PressableProps, 'style' | 'android_ripple'> {
  style?: StyleProp<ViewStyle>;
  /**
   * The control's rendered height. If it is under the 44pt minimum, the touch area is
   * grown symmetrically to reach it — the circle stays 26px, the target becomes 44.
   */
  hitHeight?: number;
  /** Same, for width. Used by the stepper circles and the switch. */
  hitWidth?: number;
}

/** Grow the touch area to `size.hit` without changing the drawn box. */
export function hitSlopFor(
  width?: number,
  height?: number,
): { top: number; bottom: number; left: number; right: number } {
  const v = height !== undefined && height < size.hit ? (size.hit - height) / 2 : 0;
  const h = width !== undefined && width < size.hit ? (size.hit - width) / 2 : 0;
  return { top: v, bottom: v, left: h, right: h };
}

export const Press = React.forwardRef<React.ComponentRef<typeof Pressable>, PressProps>(
  function Press({ style, hitHeight, hitWidth, hitSlop, disabled, ...rest }, ref) {
    return (
      <Pressable
        ref={ref}
        disabled={disabled}
        android_ripple={null}
        hitSlop={hitSlop ?? hitSlopFor(hitWidth, hitHeight)}
        style={({ pressed }) => [
          style,
          pressed && !disabled ? { opacity: PRESSED_OPACITY } : null,
        ]}
        {...rest}
      />
    );
  },
);
