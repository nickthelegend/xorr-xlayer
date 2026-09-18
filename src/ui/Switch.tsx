/**
 * Switch.tsx — the toggle, and the row that is allowed to contain one.
 *
 * design.md §5:
 *   track 50×30 (alerts 48×29) · radius 15 · padding 2
 *   knob  26×26 white · shadow 0 1px 3px rgba(0,0,0,.4)
 *   on #2BD87A · off #2A2B2E · translateX(0 → 19–21) · transition transform .18s, background .18s
 *
 * Two properties move here — the knob's `transform` and the track's `background` — but
 * they are two elements, one property each, both on the same 180ms clock. Under reduced
 * motion both land instantly; the knob's position alone still says which state it is in.
 *
 * §5 also says: **always paired with a caption line that changes with state.** A bare
 * label is not enough on a screen where the toggle authorises autonomous spending. That
 * is what `SwitchRow` enforces — the caption is required, and it is a function of `on`.
 *
 * A flip ticks on the phone (FEATURES.md #23, `haptics.ts`).
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Press } from './Press';
import { Text } from './Text';
import { selectionTick } from './haptics';
import { duration, timing, useReducedMotion } from './motion';
import { colors, divider, radius, shadow, size, space } from './tokens';

export interface SwitchProps {
  on: boolean;
  onChange: (on: boolean) => void;
  /** The alerts list runs a slightly tighter 48×29 track. */
  compact?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Switch({
  on,
  onChange,
  compact = false,
  disabled = false,
  accessibilityLabel,
  style,
  testID,
}: SwitchProps) {
  const reduced = useReducedMotion();

  const trackW = compact ? size.switchWSm : size.switchW;
  const trackH = compact ? size.switchHSm : size.switchH;
  const knob = compact ? size.switchKnobSm : size.switchKnob;
  const travel = compact ? size.switchTravelSm : size.switchTravel;

  /* Seeded with the current state, then driven from an effect. Returning `withTiming`
     out of a `useDerivedValue` starts the shared value at 0 and animates it to the
     current state on mount — an entrance animation on a control that is simply already
     on, which animations.md rules out. Seeding means a switch that mounts on is on. */
  const progress = useSharedValue(on ? 1 : 0);
  React.useEffect(() => {
    progress.value = withTiming(on ? 1 : 0, timing(duration.base, reduced));
  }, [on, reduced, progress]);

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [colors.switchOff, colors.up],
    ),
  }));

  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * travel }],
  }));

  return (
    <Press
      testID={testID}
      onPress={() => {
        selectionTick();
        onChange(!on);
      }}
      disabled={disabled}
      hitHeight={trackH}
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled }}
      accessibilityLabel={accessibilityLabel}
      style={style}
    >
      <Animated.View
        style={[
          {
            width: trackW,
            height: trackH,
            borderRadius: trackH / 2,
            padding: size.switchPad,
            opacity: disabled ? 0.4 : 1,
          },
          trackStyle,
        ]}
      >
        <Animated.View
          style={[
            {
              width: knob,
              height: knob,
              borderRadius: radius.full,
              backgroundColor: colors.ink,
              boxShadow: shadow.switchKnob,
            },
            knobStyle,
          ]}
        />
      </Animated.View>
    </Press>
  );
}

export interface SwitchRowProps {
  label: string;
  /**
   * Required, and a function of the state. §5: a switch is always paired with a caption
   * line that changes with it — "Executes inside your limits without asking" versus
   * "Every trade waits for your approval".
   */
  caption: (on: boolean) => string;
  on: boolean;
  onChange: (on: boolean) => void;
  compact?: boolean;
  disabled?: boolean;
  height?: number;
  divider?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SwitchRow({
  label,
  caption,
  on,
  onChange,
  compact = false,
  disabled = false,
  height = size.row,
  divider: showDivider = true,
  style,
  testID,
}: SwitchRowProps) {
  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.s12,
          minHeight: height,
        },
        showDivider ? divider : null,
        style,
      ]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="bodyLg" color={colors.ink}>
          {label}
        </Text>
        <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s2 }}>
          {caption(on)}
        </Text>
      </View>
      <Switch
        on={on}
        onChange={onChange}
        compact={compact}
        disabled={disabled}
        accessibilityLabel={label}
      />
    </View>
  );
}
