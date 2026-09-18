/**
 * RollingNumber.tsx — a figure whose digits rise into place, and roll over when it changes.
 *
 * The reference video's balances arrive with their digits sliding up. This does that WITHOUT counting:
 * each digit rises into the slot it keeps, already showing its true value, so no frame ever displays a
 * number the wallet or the market did not produce — the price rule, kept. The row is clipped to its own
 * box, which is what makes a rise read as a roll.
 *
 * Every character rises, the sign and separators with the digits, in one quick left-to-right ripple.
 * Moving only the digits was tried first and looked broken on a real device: for the moment before
 * the digits started, the line read "$ ," — punctuation waiting alone for a number.
 *
 * One clock drives the ripple (2026-09-12). Each character used to carry its own staggered
 * `FadeInDown`, chosen per render from a ref that flipped after the first commit, so the next render
 * handed the same mounted characters `entering={undefined}`. A character still waiting out its stagger
 * could be left where its animation starts — below the clip, invisible, still taking its width: the
 * Aave sheet read "$12" for a price of $126.48. A shared value runs on the UI thread and no render can
 * interrupt it, and a character that mounts after the ripple — a wider figure — reads a finished clock
 * and is simply there.
 *
 * ## The roll-over, `roll` (2026-09-17)
 *
 * Without it a figure rolls ONCE, as it mounts, and every later value snaps into place. That is right
 * for a live price — animations.md's first rule, "never animate a price", exists because a market
 * quote that moves on screen implies a move the market did not make, and a quote ticking every few
 * seconds would turn a quiet market into a flickering one. It is the wrong answer for the person's own
 * money: a balance changes because something *happened* — a fill landed, a position moved — and the
 * change arriving with no motion at all is the one event on the screen that goes unannounced.
 *
 * So `roll` is opt-in, and it is for a balance or a P&L figure. Only the characters that actually
 * changed move: each is replaced by the one that follows it, the old character leaving the clip as the
 * new one enters it, in the direction the figure moved — up when the number rose, down when it fell.
 *
 * **It still never counts.** Every frame shows a character from the figure that was on screen or a
 * character from the figure that replaced it, and nothing in between: two real values, handed over.
 * There is no interpolated 4,9xx on the way from $4,862.18 to $4,901.02.
 *
 * Masked, it does not roll. While balances are hidden (FEATURES.md #47) the figure is masked whole
 * before it is split, and the mask is what rolls in on mount; rolling one dot into another dot would be
 * movement that says nothing. Masked a character at a time, no character would hold a dollar figure to
 * mask — and a figure in units would mask the digits of a percentage one by one. Like `Price`, it is
 * the person's own money unless it says otherwise: a live price says `figure="market"`.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { maskFigure, maskMode, spokenFigure } from './mask';
import { easeOut, timing, useReducedMotion } from './motion';
import { rollDirection } from './rollOver';
import { Price, useBalancesHidden, type PriceProps } from './Text';
import { type as typeScale } from './type';
import { duration } from './tokens';

/** Between one character starting and the next — a left-to-right ripple across the figure. */
const DIGIT_STAGGER = 28;
/** How far below its slot a character starts — the rise `FadeInDown` makes, so it matches `<Rise>`. */
const RISE = 25;

export interface RollingNumberProps extends Omit<PriceProps, 'children'> {
  /** The formatted figure — exactly the string `<Price>` would take. */
  value: string;
  /** Hold the roll this long first, in ms, so it lands with the section around it. */
  delay?: number;
  /**
   * Roll each changed character over when the figure changes, in the direction it moved.
   *
   * For the person's own money, where a change is an event. Off by default, and never for a market
   * price: animations.md's first rule is that a quote snaps.
   */
  roll?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
}

export function RollingNumber({ value, delay = 0, roll = false, containerStyle, ...price }: RollingNumberProps) {
  const reduced = useReducedMotion();
  const hidden = useBalancesHidden();
  const shown = maskFigure(value, maskMode(hidden, price.figure === undefined ? 'own' : price.figure));
  /* The ripple's length is set by the figure first shown; `slot` covers a wider one later. */
  const [last] = useState(() => Math.max(0, Array.from(shown).length - 1));
  const span = duration.enter + last * DIGIT_STAGGER;
  /* Milliseconds along the ripple. */
  const clock = useSharedValue(0);

  useEffect(() => {
    // Once, on mount. `ReduceMotion.System` asks the OS as it runs; `useReducedMotion` answers late.
    clock.set(
      withDelay(
        delay,
        withTiming(span, { duration: span, easing: Easing.linear, reduceMotion: ReduceMotion.System }),
        ReduceMotion.System,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // The setting answered after mount: land the figure now rather than finish the ripple.
    if (reduced) clock.set(span);
  }, [reduced, clock, span]);

  /*
   * Which way a roll-over turns, from the two figures themselves. A masked figure never rolls over —
   * one dot replacing another is movement with nothing behind it.
   *
   * Derived AS THE FIGURE ARRIVES rather than in an effect. A child's effects run before its parent's,
   * so a direction set in an effect here would reach `RollChar` one render after the character it
   * describes: every roll turned the way the PREVIOUS change went, which on alternating ticks is the
   * wrong way every time. Adjusting state during the render instead — React's own pattern for a value
   * derived from a changed prop — re-runs this component before its children commit, so the character
   * and the way it turns arrive together.
   */
  const rolling = roll && shown === value;
  const [seen, setSeen] = useState(value);
  const [direction, setDirection] = useState(1);
  if (seen !== value) {
    setSeen(value);
    setDirection(rollDirection(seen, value, direction));
  }

  /* How far a character travels to leave its slot: its own line, so it is gone as the next one lands. */
  const travel = typeScale[price.variant ?? 'rowPrimary'].lineHeight;

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={shown === value ? value : spokenFigure(shown)}
      style={[{ flexDirection: 'row', overflow: 'hidden' }, containerStyle]}
    >
      {Array.from(shown).map((ch, i) => (
        // Keyed by position: a ticking price changes a character in place instead of remounting it.
        <RollChar
          key={i}
          clock={clock}
          slot={Math.min(i, last)}
          price={price}
          roll={rolling}
          travel={travel}
          direction={direction}
        >
          {ch}
        </RollChar>
      ))}
    </View>
  );
}

function RollChar({
  clock,
  slot,
  price,
  roll,
  travel,
  direction,
  children,
}: {
  clock: SharedValue<number>;
  /** Where in the ripple this character starts. Past the first figure's width, the last slot. */
  slot: number;
  price: Omit<PriceProps, 'children'>;
  /** Hand this slot's character over to the next one rather than swapping it silently. */
  roll: boolean;
  /** A character's own line height: how far it travels out of the clip. */
  travel: number;
  /** +1 when the figure rose, −1 when it fell. */
  direction: number;
  children: string;
}) {
  const reduced = useReducedMotion();
  const rise = useAnimatedStyle(() => {
    const t = Math.min(1, Math.max(0, (clock.get() - slot * DIGIT_STAGGER) / duration.enter));
    const eased = easeOut(t);
    return { opacity: eased, transform: [{ translateY: (1 - eased) * RISE }] };
  });

  /*
   * The hand-over. `handed` is 1 when this slot holds one character and nothing is moving; a change
   * puts it back to 0 with the character it is replacing drawn over the slot, and the timing hands the
   * slot from one to the other. The direction is snapshotted into a shared value at the same moment, so
   * a second change arriving mid-roll cannot reverse one already in flight.
   */
  const handed = useSharedValue(1);
  const turn = useSharedValue(direction);
  const settled = useRef(children);
  const [leaving, setLeaving] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (settled.current === children) return;
    const was = settled.current;
    settled.current = children;
    if (!roll) return;
    setLeaving(was);
    turn.set(direction);
    handed.set(0);
    handed.set(withTiming(1, { ...timing(duration.base, reduced), reduceMotion: ReduceMotion.System }));
  }, [children, roll, direction, reduced, handed, turn]);

  const arriving = useAnimatedStyle(() => ({
    opacity: handed.get(),
    transform: [{ translateY: (1 - handed.get()) * travel * turn.get() }],
  }));
  const departing = useAnimatedStyle(() => ({
    opacity: 1 - handed.get(),
    transform: [{ translateY: -handed.get() * travel * turn.get() }],
  }));

  return (
    <Animated.View style={rise}>
      <Animated.View style={arriving}>
        {/* Masked with the whole figure already, if it is to be: one character on its own is never masked again. */}
        <Price {...price} figure={null} accessible={false}>
          {children}
        </Price>
      </Animated.View>
      {leaving === undefined ? null : (
        // The character on its way out, over the slot rather than beside it, so the row's width never moves.
        <Animated.View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[{ position: 'absolute', left: 0, top: 0 }, departing]}
        >
          <Price {...price} figure={null} accessible={false}>
            {leaving}
          </Price>
        </Animated.View>
      )}
    </Animated.View>
  );
}
