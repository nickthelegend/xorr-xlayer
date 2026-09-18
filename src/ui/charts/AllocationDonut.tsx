/**
 * AllocationDonut.tsx — what the portfolio is made of, by sector.
 *
 * A ring of segments, one per sector, sized by what that sector is actually worth, with the total in the middle and a
 * legend under it. The arithmetic — grouping, shares, ordering, and the handling of an asset whose sector nothing
 * could tell us — is `allocation.ts`, kept separate and tested, because those are the parts that can be silently wrong.
 *
 * ## It draws what is known, and says what is not
 *
 * **Unclassified is a slice**, in the switch's off grey, sorted last and labelled as itself. It is never guessed from a
 * ticker and never dropped: dropping it would renormalise every other slice, so a portfolio half of which is
 * unclassified would draw as though the classified half were the whole thing — and still add to 100%. The chart would
 * look perfectly correct and be wrong by half.
 *
 * A portfolio with nothing in it draws no ring. An empty ring is a zero, and a portfolio nobody could price drawn as
 * nothing held is the false negative this screen exists not to tell.
 *
 * ## The colours
 *
 * From `allocationPalette`, which is the agent identity hues minus the yield green — green and red mean profit and loss,
 * and a sector drawn in `up` green reads as the sector that made money. A donut is the easiest place in an app to break
 * that rule by accident, because it wants eight distinct colours and two of the most distinct are spoken for.
 *
 * ## The motion
 *
 * It sweeps clockwise from twelve o'clock over `duration.draw`, the same beat `AreaChart` and `Candlestick` take to
 * reveal themselves, and by the same means: one shared value driving an `useAnimatedProps` on the stroke dash. The ring
 * is only ever REVEALED — no slice grows, shrinks or slides to a new size, and no value is interpolated. Every segment
 * is at its true angle from the first frame it is visible.
 *
 * It sweeps when the shape it is drawing changes, not on every render, so a screen re-reading the same portfolio does
 * not replay the reveal. Under reduced motion the ring is simply there.
 */
import React, { useEffect, useRef } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedProps,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, G } from 'react-native-svg';
import { arrival, duration, useReducedMotion } from '../motion';
import { Text, Value } from '../Text';
import { allocationPalette, allocationUnknown, colors, space } from '../tokens';
import { sliceArcs, type AllocationSlice } from './allocation';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Big enough to read eight segments apart, thin enough to stay a ring rather than a pie. */
const DIAMETER = 168;
const STROKE = 18;
/** A hair of a gap between segments, in fractions of the circle, so two neighbours do not read as one. */
const GAP = 0.004;

export interface AllocationDonutProps {
  /** The sectors, already grouped and shared out by `allocationBySector`. */
  slices: readonly AllocationSlice[];
  /** The figure in the middle, already formatted. */
  total: string;
  /** One word under it — what the figure is. */
  totalLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** The colour a slice takes: its place in the palette, or the not-known grey. */
export function sliceColor(slice: AllocationSlice, index: number): string {
  return slice.unclassified ? allocationUnknown : allocationPalette[index % allocationPalette.length]!;
}

export function AllocationDonut({ slices, total, totalLabel, style, testID }: AllocationDonutProps) {
  const reduced = useReducedMotion();
  const center = DIAMETER / 2;
  const radius = (DIAMETER - STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const arcs = sliceArcs(slices);

  /* 0 before the sweep, 1 with the whole ring drawn. */
  const sweep = useSharedValue(0);
  /* The shape last revealed: a re-read of the same portfolio is not a new chart. */
  const shape = slices.map((s) => `${s.sector}:${s.share.toFixed(6)}`).join('|');
  const swept = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (slices.length === 0 || swept.current === shape) return;
    swept.current = shape;
    sweep.set(0);
    sweep.set(withTiming(1, arrival(duration.draw, reduced)));
  }, [shape, slices.length, reduced, sweep]);

  return (
    <View testID={testID} style={[{ alignItems: 'center', gap: space.s16 }, style]}>
      <View style={{ width: DIAMETER, height: DIAMETER, alignItems: 'center', justifyContent: 'center' }}>
        {slices.length > 0 ? (
          <Svg
            width={DIAMETER}
            height={DIAMETER}
            style={{ position: 'absolute', left: 0, top: 0 }}
            /* One image to a screen reader; the legend below carries the same facts in words. */
            accessibilityRole="image"
            accessibilityLabel={slices
              .map((s) => `${s.sector} ${Math.round(s.share * 100)}%`)
              .join(', ')}
          >
            {/* From twelve o'clock: an SVG circle starts at three. */}
            <G rotation={-90} origin={`${center}, ${center}`}>
              <Circle cx={center} cy={center} r={radius} fill="none" stroke={colors.control} strokeWidth={STROKE} />
              {slices.map((slice, i) => (
                <Segment
                  key={slice.sector}
                  sweep={sweep}
                  start={arcs[i]!.start}
                  share={slice.share}
                  colour={sliceColor(slice, i)}
                  center={center}
                  radius={radius}
                  circumference={circumference}
                />
              ))}
            </G>
          </Svg>
        ) : null}

        <Value variant="amountMd" figure="own">
          {total}
        </Value>
        {totalLabel ? (
          <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s2 }}>
            {totalLabel}
          </Text>
        ) : null}
      </View>

      {slices.length > 0 ? (
        <View style={{ alignSelf: 'stretch', gap: space.s8 }}>
          {slices.map((slice, i) => (
            <LegendRow key={slice.sector} slice={slice} colour={sliceColor(slice, i)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * One segment, revealed as the sweep passes it.
 *
 * The visible length is how far the sweep has travelled INTO this segment, so the ring draws clockwise as one line
 * rather than every segment growing at once. `GAP` is taken off the end, never off the share the arithmetic produced:
 * the gap is a drawing detail and must not change what the chart says a sector is worth.
 */
function Segment({
  sweep,
  start,
  share,
  colour,
  center,
  radius,
  circumference,
}: {
  sweep: SharedValue<number>;
  start: number;
  share: number;
  colour: string;
  center: number;
  radius: number;
  circumference: number;
}) {
  const animated = useAnimatedProps(() => {
    const through = share <= 0 ? 1 : Math.min(1, Math.max(0, (sweep.get() - start) / share));
    const drawn = Math.max(0, share - GAP) * through * circumference;
    return { strokeDasharray: [drawn, circumference], strokeDashoffset: -start * circumference };
  });

  return (
    <AnimatedCircle
      cx={center}
      cy={center}
      r={radius}
      fill="none"
      stroke={colour}
      strokeWidth={STROKE}
      animatedProps={animated}
    />
  );
}

/** A sector, its share, and what is in it. */
function LegendRow({ slice, colour }: { slice: AllocationSlice; colour: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10 }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colour }} />
      <View style={{ flex: 1 }}>
        <Text variant="rowPrimary" numberOfLines={1}>
          {slice.sector}
        </Text>
        {/* The symbols, so a sector is never an unexplained word. Units, not money: this is what is held. */}
        <Text variant="footnote" color={colors.ink45} numberOfLines={1} figure="units">
          {slice.symbols.join(' · ')}
        </Text>
      </View>
      <Value variant="value" figure="own">
        {`${Math.round(slice.share * 100)}%`}
      </Value>
    </View>
  );
}
