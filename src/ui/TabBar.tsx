/**
 * TabBar.tsx — Home, Swap and Messages (2026-09-15).
 *
 * Rebuilt to the product owner's reference, a messenger's bar: one floating capsule, three glyphs. It replaced a solid
 * centre circle that opened the chat, between Home and a grid that opened a blank screen. The chat moved to where the
 * grid was, as Messages, and the centre became Swap.
 *
 * Glyphs only (2026-09-16). Three shapes this distinct read at a glance without their names under them, and the names
 * stay where they are needed — in each item's accessibility label.
 *
 * Home is the one place, and the only item that lights — white, on a raised pill. Swap and Messages are actions: Swap
 * raises the swap sheet from the bottom, and Messages the drawer of conversations with the agents, over whatever is on
 * screen. Messages carries how many of the agents' messages are new, as a messenger does; at zero nothing is drawn.
 *
 * The glyphs are drawn here, solid where the icon set is stroked, because a filled shape is what makes three items read
 * at a glance.
 *
 * Two things on the bar move, and neither of them while you are reading the screen.
 *
 * The bar itself goes down out of view while the Messages drawer is up, and comes back as it goes down — the drawer
 * takes the bar's place rather than covering it (animations.md, "The tab bar gives way to Messages").
 *
 * And the mark under Home — the raised pill that says which place you are in — grows into shape when you arrive there
 * and shrinks away when you leave (FEATURES.md #48). It used to appear and vanish between two frames, which on the one
 * control whose whole job is to answer navigation reads as a redraw rather than an answer. One property,
 * `transform: scale`, over the 150ms the segmented thumb takes, because selection must feel instant and 150 is the
 * floor. No slide and no travelling indicator: there is one place on this bar, and Swap and Messages are actions that
 * are never selected, so there is nothing for an indicator to travel between.
 *
 * The glyph's colour still snaps. It is the state, and it has to be right in the frame the tap lands — including under
 * reduced motion, where the mark is simply there or not and the colour carries the whole thing on its own.
 *
 * The bottom padding is the real inset, floored so a device that reports none still clears the edge.
 */
import React, { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import { arrival, duration, timing, useReducedMotion } from './motion';
import { Press } from './Press';
import { Text } from './Text';
import { colors, space } from './tokens';

/** The places on the bar. One: Swap and Messages are actions, and are never selected. */
export type TabKey = 'home';

export const TAB_ORDER: readonly TabKey[] = ['home'];

const BAR_H = 60;
const ITEM_H = 50;
/** Where the mark under the open place starts and ends: nothing, to itself. */
const MARK_FROM = 0;
const GLYPH = 26;
const STROKE = 2.1;
const BADGE_H = 17;

/** The house, solid, with its door cut out. */
function HomeGlyph({ color }: { color: string }) {
  return (
    <Svg width={GLYPH} height={GLYPH} viewBox="0 0 24 24">
      <Path
        d="M3 10.5 L12 3.5 L21 10.5 V20 a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z M9.75 21v-5.25h4.5V21Z"
        fill={color}
        fillRule="evenodd"
        stroke={color}
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

const stroked = (color: string) =>
  ({ stroke: color, strokeWidth: STROKE, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' }) as const;

/** Two arrows passing each other: one token for another. */
function SwapGlyph({ color }: { color: string }) {
  return (
    <Svg width={GLYPH} height={GLYPH} viewBox="0 0 24 24">
      <Path d="M8 19V5M8 5 4.5 8.5M8 5l3.5 3.5" {...stroked(color)} />
      <Path d="M16 5v14m0 0-3.5-3.5M16 19l3.5-3.5" {...stroked(color)} />
    </Svg>
  );
}

/**
 * A chat bubble with the agents' face in it.
 *
 * The two dots and the smile are the same face the roster and the proposal cards draw: it is the agents you are talking
 * to, not a support inbox.
 */
function ChatGlyph({ color }: { color: string }) {
  return (
    <Svg width={GLYPH} height={GLYPH} viewBox="0 0 24 24">
      <Path
        d="M21 11.5c0 4.14-4.03 7.5-9 7.5a10.5 10.5 0 0 1-2.6-.32L4.5 20.5l1.2-3.2A7.02 7.02 0 0 1 3 11.5C3 7.36 7.03 4 12 4s9 3.36 9 7.5Z"
        {...stroked(color)}
      />
      <Circle cx={9.2} cy={11.2} r={1.2} fill={color} />
      <Circle cx={14.8} cy={11.2} r={1.2} fill={color} />
      <Path d="M9.3 14.2a3.4 3.4 0 0 0 5.4 0" {...stroked(color)} />
    </Svg>
  );
}

export interface TabBarProps {
  /** The open place, or null when the screen is not Home. The layout decides; the bar draws it. */
  active: TabKey | null;
  onHome: () => void;
  /** Raises the swap sheet. */
  onSwap: () => void;
  /** Raises the Messages drawer. */
  onMessages: () => void;
  /** The agents' messages that are new. Nothing is drawn at zero. */
  unread?: number;
  /** The Messages drawer is up: the bar goes down out of its way, and comes back when this turns false. */
  hidden?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function TabBar({ active, onHome, onSwap, onMessages, unread = 0, hidden = false, style, testID }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const home = active === 'home';

  /** The bar's whole height, padding and inset included: how far it moves to be entirely below the screen. */
  const travel = space.s6 + BAR_H + Math.max(insets.bottom, space.s12);
  const y = useSharedValue(hidden ? travel : 0);
  useEffect(() => {
    // The drawer's own curves, so the two move as one: down on its rise, back on its fall; instant under reduced motion.
    y.value = withTiming(hidden ? travel : 0, hidden ? arrival(duration.enter, reduced) : timing(duration.slow, reduced));
  }, [hidden, travel, reduced, y]);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));

  return (
    <Animated.View
      testID={testID}
      // Out of view is out of reach: no taps, and nothing for a screen reader to land on behind the drawer.
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      style={[
        {
          paddingHorizontal: space.s16,
          paddingTop: space.s6,
          paddingBottom: Math.max(insets.bottom, space.s12),
          backgroundColor: colors.bg,
          pointerEvents: hidden ? 'none' : 'auto',
        },
        style,
        slide,
      ]}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          height: BAR_H,
          paddingHorizontal: space.s6,
          borderRadius: BAR_H / 2,
          backgroundColor: colors.surfaceAlt,
          borderWidth: 1,
          borderColor: colors.ghostBorder,
        }}
      >
        <Item label="Home" place selected={home} onPress={onHome} reduced={reduced}>
          <HomeGlyph color={home ? colors.ink : colors.ink55} />
        </Item>
        <Item label="Swap" onPress={onSwap}>
          <SwapGlyph color={colors.ink55} />
        </Item>
        <Item label="Messages" onPress={onMessages} badge={unread > 0 ? (unread > 9 ? '9+' : String(unread)) : undefined}>
          <ChatGlyph color={colors.ink55} />
        </Item>
      </View>
    </Animated.View>
  );
}

function Item({
  label,
  place = false,
  selected = false,
  badge,
  reduced = false,
  onPress,
  children,
}: {
  /** Not drawn: the name a screen reader says for the glyph. */
  label: string;
  /** A place is a tab and can be the selected one; an action is a button. */
  place?: boolean;
  selected?: boolean;
  badge?: string;
  /** The OS setting, from the bar: the mark is simply there or not, with no growth. */
  reduced?: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  /* The mark under the selected place. Drawn always and scaled to nothing when it is not this item's turn. */
  const mark = useSharedValue(selected ? 1 : MARK_FROM);
  useEffect(() => {
    mark.value = withTiming(selected ? 1 : MARK_FROM, timing(duration.fast, reduced));
  }, [selected, reduced, mark]);
  const grows = useAnimatedStyle(() => ({ transform: [{ scale: mark.value }] }));

  return (
    <Press
      onPress={onPress}
      accessibilityRole={place ? 'tab' : 'button'}
      accessibilityState={place ? { selected } : undefined}
      /*
       * `aria-selected` IS valid on `role="tab"` — and React Native Web still does not emit it,
       * so the bar announced its tab with no current one. Added explicitly.
       */
      aria-selected={place ? selected : undefined}
      accessibilityLabel={badge ? `${label}, ${badge} new` : label}
      hitHeight={ITEM_H}
      style={{
        flex: 1,
        height: ITEM_H,
        borderRadius: ITEM_H / 2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {place ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
              borderRadius: ITEM_H / 2,
              backgroundColor: colors.control,
            },
            grows,
          ]}
        />
      ) : null}
      <View>
        {children}
        {badge ? (
          <View
            style={{
              position: 'absolute',
              top: -5,
              left: GLYPH - 8,
              minWidth: BADGE_H,
              height: BADGE_H,
              paddingHorizontal: space.s4,
              borderRadius: BADGE_H / 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.ink,
              borderWidth: 2,
              borderColor: colors.surfaceAlt,
            }}
          >
            <Text variant="tagSm" color={colors.bg}>
              {badge}
            </Text>
          </View>
        ) : null}
      </View>
    </Press>
  );
}
