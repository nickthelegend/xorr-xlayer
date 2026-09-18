/**
 * AreaChart.tsx — the equity curve.
 *
 * design.md §6:
 *   Gradient fill polygon (stop-opacity .26–.3 → 0) under a stroke-width 2,
 *   stroke-linejoin/linecap round polyline. Grid lines rgba(255,255,255,.06) at 25%
 *   intervals, behind the fill. End dot r=3.2.
 *
 * §6 writes this as `viewBox="0 0 360 110" preserveAspectRatio="none"` because the
 * prototype was HTML. That is kept as *values* but not as geometry: a non-uniform scale
 * stretches the 2px stroke to a different thickness horizontally and vertically, and
 * turns the r=3.2 end dot into an ellipse. This measures its box and draws in real
 * points instead, so the stroke is 2 in both axes and the dot is round. Every coordinate
 * is still derived — from the data and the measured size, never placed (line.ts).
 *
 * To a screen reader the chart is one image with a sentence: which way the series went, and by how much
 * (`describeSeries`, FEATURES.md #74). A screen that knows the units passes its own `accessibilityLabel`.
 *
 * Three things a screen can turn on, each off unless asked, so a chart that does not ask draws as it always did:
 *
 *   The scrub (FEATURES.md #45). With `formatValue`, a finger dragged across the chart gets a hairline, a dot on the
 *   line and a label with the value and, given `times`, the moment it was read. Lifting the finger clears it. The
 *   drag begins only once it is plainly sideways, so the screen still scrolls when a thumb starts on the chart. The
 *   label is the person's own money unless `figure` says otherwise, so a wallet's line hides its values while balances
 *   are hidden (FEATURES.md #47) and a price's line says `figure="market"`.
 *
 *   Marks (FEATURES.md #9). `marks` are the user's own fills, each drawn at its place along the line and its price,
 *   on the line's own projection. With `formatValue` as well, a tap on a mark names it (FEATURES.md #77): bought or
 *   sold, at what price, when it settled, and the venue that filled it — as recorded, never inferred. The label
 *   appears where the mark already is; nothing moves into place.
 *
 *   A range switch (FEATURES.md #83). With a `seriesKey`, a new key crossfades the old line into the new one while
 *   the box and the grid hold still, and `pending` steps the line back while the next series loads.
 */
import React, { useEffect, useState } from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, ClipPath, Defs, G, LinearGradient, Line, Path, Rect, Stop } from 'react-native-svg';
import { selectionTick } from '../haptics';
import type { FigureKind } from '../mask';
import { arrival, timing, useReducedMotion } from '../motion';
import { Text, Value } from '../Text';
import { chart, colors, duration, radius, size, space } from '../tokens';
import { describeSeries } from './describeSeries';
import { lineFrame, linePaths, lineX, lineY, nearestIndex, nearestMark } from './line';
import { MARK_RADIUS, describeMarks, markDetail, markPath, sameFill, type LineMark } from './marks';
import { labelAnchor, scrubTime, scrubber } from './scrub';
import { useMeasuredBox } from './useMeasuredBox';
import { PENDING_OPACITY, sameItems, useSeriesLayers } from './useSeriesLayers';

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedG = Animated.createAnimatedComponent(G);

/**
 * How far a finger travels sideways before a drag is a scrub, and up or down before it is a scroll instead. Whichever
 * it crosses first decides, so a thumb that means to scroll the screen past the chart still scrolls it.
 */
const SCRUB_SLOP = 8;

/** The two slots a series can be drawn in — see useSeriesLayers. */
const SLOTS = [0, 1] as const;

/** One empty list, so a chart with no marks does not hand its layers a new array on every render. */
const NO_MARKS: readonly LineMark[] = [];

export interface AreaChartProps {
  /** The series, in value space. Scaled to its own min/max unless bounds are given. */
  data: readonly number[];
  /** The line and fill colour. P&L green for a winning curve; the instrument's own
   *  colour on a contract screen, where the line is identity, not outcome. */
  color?: string;
  height: number;
  /** Fix the vertical scale — otherwise the extent of the series and its marks is used. */
  bounds?: { min: number; max: number };
  /** Grid lines at 25% intervals, behind the fill. */
  grid?: boolean;
  /** The dot on the last point. */
  endDot?: boolean;
  /** Room on every side so a stroke, a dot or a mark at the edge isn't clipped in half. */
  inset?: number;
  /**
   * Draw the line and its fill left to right when the chart appears — and, without a `seriesKey`, again when the
   * series changes. The shape is only revealed, never interpolated — every point is where the data puts it from the
   * first frame. Instant under reduced motion.
   */
  drawIn?: boolean;
  /** When each point was read, in ms since the epoch: one per point, oldest first. The scrub's label names it. */
  times?: readonly number[];
  /**
   * How a value reads — and the switch for the scrub (FEATURES.md #45).
   *
   * Off without it, because the chart has no units of its own: a balance, a price and a normalised return draw the
   * same line, so a screen that wants the crosshair has to say what a number on it means.
   */
  formatValue?: (value: number) => string;
  /** What the scrub's value is while balances are hidden: the person's own unless said — a price's line is `market`. */
  figure?: FigureKind;
  /** The user's fills, placed on this line (`lineMarks`). They belong to the series and fade with it. */
  marks?: readonly LineMark[];
  /**
   * What the series answers, such as a symbol and a range. A new key crossfades the old line into the new one; the
   * same key with new values changes in place. Without one, a new series is simply drawn, as it always was.
   */
  seriesKey?: string;
  /** The series is the last answer, kept while the next one loads: drawn stepped back, and not scrubbable. */
  pending?: boolean;
  /** What a screen reader hears. Defaults to the series' direction and size of move over its range. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** What one layer draws. */
interface Drawn {
  data: readonly number[];
  marks: readonly LineMark[];
  color: string;
  bounds?: { min: number; max: number };
}

const sameMark = (a: LineMark, b: LineMark) =>
  a.position === b.position && a.price === b.price && a.side === b.side && a.venue === b.venue && a.id === b.id;

function sameDrawn(a: Drawn, b: Drawn): boolean {
  return (
    a.color === b.color &&
    a.bounds?.min === b.bounds?.min &&
    a.bounds?.max === b.bounds?.max &&
    sameItems(a.data, b.data) &&
    sameItems(a.marks, b.marks, sameMark)
  );
}

export function AreaChart({
  data,
  color = colors.up,
  height,
  bounds,
  grid = false,
  endDot = false,
  inset,
  drawIn = false,
  times,
  formatValue,
  figure = 'own',
  marks,
  seriesKey,
  pending = false,
  accessibilityLabel,
  style,
  testID,
}: AreaChartProps) {
  const [box, onLayout] = useMeasuredBox();
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradientId = `area-${uid}`;
  const clipId = `reveal-${uid}`;

  /*
   * What is on screen, and what is leaving it. With no `seriesKey` the key never changes, so the front slot follows
   * `data` in place and nothing fades — the charts that do not ask for a crossfade never get one.
   */
  const layers = useSeriesLayers<Drawn>(
    seriesKey ?? '',
    { data, marks: marks ?? NO_MARKS, color, bounds },
    sameDrawn,
  );
  const shown = layers.slots[layers.front]!;

  /*
   * The reveal: a clip whose width runs 0 → the full box. Without a `seriesKey` it restarts whenever the series
   * changes, so a new timeframe draws in the way the first one did. With one it runs once, when there is first
   * something to show: a later series crossfades in instead, and redrawing it from the left as well would read as
   * the chart reloading.
   */
  const reduced = useReducedMotion();
  // Android draws the line at once and unclipped, as Candlestick explains: there a clip keeps the shape it first drew with.
  const revealing = drawIn && Platform.OS !== 'android';
  const reveal = useSharedValue(revealing ? 0 : 1);
  const measured = box.width > 0;
  const revealFor =
    seriesKey === undefined ? `${data.length}:${data[0] ?? ''}:${data[data.length - 1] ?? ''}` : data.length > 0;
  useEffect(() => {
    if (!revealing || !measured) return;
    reveal.value = 0;
    reveal.value = withTiming(1, arrival(duration.draw, reduced));
  }, [revealing, measured, revealFor, reduced, reveal]);
  const width = box.width;
  // Held to 0–1, as Candlestick's is: a first frame stamped before its timing began eases to a negative width on the web.
  const clipProps = useAnimatedProps(() => ({ width: Math.min(1, Math.max(0, reveal.value)) * width }));

  /*
   * The crossfade. The front slot rises to full strength (or to the pending step), the other falls away, on the
   * interaction scale: a range switch answers a tap on a pill. Under reduced motion the new line is simply there.
   */
  const fade0 = useSharedValue(1);
  const fade1 = useSharedValue(0);
  const { front, generation } = layers;
  useEffect(() => {
    const cfg = timing(duration.slow, reduced);
    const lit = pending ? PENDING_OPACITY : 1;
    fade0.value = withTiming(front === 0 ? lit : 0, cfg);
    fade1.value = withTiming(front === 1 ? lit : 0, cfg);
  }, [front, generation, pending, reduced, fade0, fade1]);
  const slot0 = useAnimatedProps(() => ({ opacity: fade0.value }));
  const slot1 = useAnimatedProps(() => ({ opacity: fade1.value }));

  /* Half the stroke, plus the dot's radius when there is one — the smallest inset that
     guarantees nothing is clipped. It applies on both axes: a round linecap at the last
     point loses half of itself at the right edge, and the end dot loses more than half.
     A chart that scrubs keeps room for the scrub's ringed dot, and one given marks for them. */
  const pad =
    inset ??
    Math.max(
      endDot ? chart.area.endDotRadius : chart.area.strokeWidth / 2,
      formatValue ? chart.area.endDotRadius + chart.area.strokeWidth / 2 : 0,
      marks !== undefined ? MARK_RADIUS : 0,
    );
  const frameOf = (layer: Drawn) =>
    lineFrame(layer.data, { width: box.width, height }, pad, layer.bounds, layer.marks.map((m) => m.price));
  const frame = frameOf(shown);

  /*
   * The scrub, on the JS thread. A move asks the projection for the nearest point and sets it as state, which React
   * ignores when it has not changed — so a line of a dozen points renders a dozen times across the whole drag, not
   * once a frame. The readout is text, and text on this app is never an animated value.
   */
  const [scrubbed, setScrubbed] = useState<number | null>(null);
  // The drag's memory, made once: which point it is on and when the phone last ticked (scrub.ts says why not a ref).
  const [drag] = useState(() => scrubber({ point: setScrubbed, tick: selectionTick }));
  const scrubbable = formatValue !== undefined && !pending && measured && shown.data.length > 0;
  const follow = (x: number) => {
    const index = nearestIndex(frame, x);
    if (index !== null) drag.move(index);
  };

  /*
   * The mark a tap picked, and the series it was picked on. Kept as the fill itself rather than an index, and shown
   * only while that same series is up and still holds it: a new range drops the label instead of carrying it across.
   */
  const [picked, setPicked] = useState<{ key: string; mark: LineMark } | null>(null);
  const inspectable = formatValue !== undefined && !pending && measured && shown.marks.length > 0;
  const pick = (x: number, y: number) => {
    // Half the minimum hit target: a mark is smaller than a finger, and the reach is what makes it tappable.
    const index = nearestMark(frame, shown.marks, x, y, size.hit / 2);
    setPicked(index === null ? null : { key: seriesKey ?? '', mark: shown.marks[index]! });
  };

  const pan =
    formatValue === undefined
      ? undefined
      : Gesture.Pan()
          .runOnJS(true)
          .enabled(scrubbable)
          .activeOffsetX([-SCRUB_SLOP, SCRUB_SLOP])
          .failOffsetY([-SCRUB_SLOP, SCRUB_SLOP])
          .shouldCancelWhenOutside(false)
          .onStart((e) => {
            setPicked(null);
            follow(e.x);
          })
          .onUpdate((e) => follow(e.x))
          .onFinalize(() => drag.end());
  const tap = Gesture.Tap()
    .runOnJS(true)
    .enabled(inspectable)
    .maxDistance(SCRUB_SLOP)
    .onEnd((e, success) => {
      if (success) pick(e.x, e.y);
    });
  // Whichever the finger means first: a still tap inspects a mark, a sideways drag scrubs.
  const scrub = pan === undefined ? undefined : Gesture.Race(pan, tap);

  const point = scrubbable && scrubbed !== null && scrubbed < shown.data.length ? scrubbed : null;
  const pointX = point === null ? 0 : lineX(frame, point);
  const pointY = point === null ? 0 : lineY(frame, shown.data[point]!);
  /* The moment is named only when the screen said when each of these points was read. */
  const pointAt =
    point !== null && times !== undefined && times.length === shown.data.length ? times[point] : undefined;
  const timeSpan = times !== undefined && times.length > 1 ? times[times.length - 1]! - times[0]! : 0;

  /* The picked mark, while the scrub is not showing a point and the series it was picked on is still the one shown. */
  const inspected =
    inspectable && point === null && picked !== null && picked.key === (seriesKey ?? '')
      ? shown.marks.find((m) => sameFill(m, picked.mark))
      : undefined;
  const inspectedX = inspected === undefined ? 0 : lineX(frame, inspected.position);
  const inspectedY = inspected === undefined ? 0 : lineY(frame, inspected.price);
  const detail = inspected === undefined ? undefined : markDetail(inspected);

  const drawable = measured && layers.slots.some((layer) => layer !== null && layer.data.length > 0);

  const drawLayer = (slot: 0 | 1) => {
    const layer = layers.slots[slot];
    if (layer === null || layer.data.length === 0) return null;
    const f = frameOf(layer);
    const { line, area } = linePaths(f, layer.data);
    const last = layer.data.length - 1;
    /*
     * One reading is a point, and is drawn whether or not this chart asked for an end dot.
     *
     * `linePaths` gives a lone reading no line and no area, deliberately — a line needs two observations, and one is a
     * fact without a direction. Without this the chart would then draw nothing at all, which is what a chart with NO
     * readings looks like: the same "nothing" versus "not yet" conflation the rest of this app exists to avoid.
     */
    const lone = layer.data.length === 1;
    return (
      <>
        <Path d={area} fill={`url(#${gradientId}-${slot})`} />
        <Path
          d={line}
          fill="none"
          stroke={layer.color}
          strokeWidth={chart.area.strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {endDot || lone ? (
          <Circle
            cx={lineX(f, last)}
            cy={lineY(f, layer.data[last]!)}
            r={chart.area.endDotRadius}
            fill={layer.color}
          />
        ) : null}
        {/* In ink with a black keyline, not green or red: a buy is not a profit. The triangle's direction is the side. */}
        {layer.marks.map((m, i) => (
          <Path
            key={`mark-${i}`}
            d={markPath(lineX(f, m.position), lineY(f, m.price), m.side)}
            fill={colors.ink}
            stroke={colors.bg}
            strokeWidth={chart.candle.markStroke}
            strokeLinejoin="round"
          />
        ))}
      </>
    );
  };

  const summary = [accessibilityLabel ?? describeSeries(data), describeMarks(marks ?? NO_MARKS)]
    .filter(Boolean)
    .join(', ');

  const body = (
    <View
      testID={testID}
      style={[{ height }, style]}
      onLayout={onLayout}
      accessible
      accessibilityRole="image"
      accessibilityLabel={summary}
    >
      {drawable && (
        <Svg width={box.width} height={height}>
          <Defs>
            {/* One gradient per slot: the line leaving can be red while the one arriving is green. */}
            {SLOTS.map((slot) => {
              const layer = layers.slots[slot];
              return layer === null ? null : (
                <LinearGradient key={slot} id={`${gradientId}-${slot}`} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset={0} stopColor={layer.color} stopOpacity={chart.area.fillOpacityTop} />
                  <Stop offset={1} stopColor={layer.color} stopOpacity={chart.area.fillOpacityBottom} />
                </LinearGradient>
              );
            })}
            {revealing ? (
              <ClipPath id={clipId}>
                <AnimatedRect x={0} y={0} height={height} animatedProps={clipProps} />
              </ClipPath>
            ) : null}
          </Defs>

          {grid &&
            chart.area.gridAt.map((t) => (
              <Line
                key={t}
                x1={0}
                y1={t * height}
                x2={box.width}
                y2={t * height}
                stroke={chart.area.gridColor}
                strokeWidth={1}
              />
            ))}

          <G clipPath={revealing ? `url(#${clipId})` : undefined}>
            <AnimatedG animatedProps={slot0}>{drawLayer(0)}</AnimatedG>
            <AnimatedG animatedProps={slot1}>{drawLayer(1)}</AnimatedG>
          </G>

          {point !== null ? (
            <>
              <Line
                x1={pointX}
                y1={0}
                x2={pointX}
                y2={height}
                stroke={colors.ink40}
                strokeWidth={chart.candle.markStroke}
              />
              <Circle
                cx={pointX}
                cy={pointY}
                r={chart.area.endDotRadius}
                fill={shown.color}
                stroke={colors.bg}
                strokeWidth={chart.area.strokeWidth}
              />
            </>
          ) : null}

          {/* A ring around the inspected mark, drawn where the mark already is. */}
          {inspected !== undefined ? (
            <Circle
              cx={inspectedX}
              cy={inspectedY}
              r={MARK_RADIUS + chart.area.strokeWidth}
              fill="none"
              stroke={colors.ink}
              strokeWidth={chart.candle.markStroke}
            />
          ) : null}
        </Svg>
      )}

      {inspected !== undefined && detail !== undefined && formatValue !== undefined ? (
        <View
          testID={testID === undefined ? undefined : `${testID}-mark`}
          style={{
            position: 'absolute',
            ...labelAnchor(inspectedX, inspectedY, { width: box.width, height }, space.s8),
            paddingVertical: space.s4,
            paddingHorizontal: space.s8,
            gap: space.s2,
            borderRadius: radius.glyph,
            backgroundColor: colors.surfaceAlt,
            pointerEvents: 'none',
          }}
        >
          <Value variant="chip" color={colors.ink} figure={figure}>
            {`${detail.action} at ${formatValue(inspected.price)}`}
          </Value>
          <Text variant="footnoteSm" color={colors.ink55}>
            {scrubTime(inspected.at, timeSpan)}
          </Text>
          <Text variant="footnoteSm" color={colors.ink55}>
            {detail.venue}
          </Text>
        </View>
      ) : null}

      {point !== null && formatValue !== undefined ? (
        <View
          style={{
            position: 'absolute',
            ...labelAnchor(pointX, pointY, { width: box.width, height }, space.s8),
            paddingVertical: space.s4,
            paddingHorizontal: space.s8,
            gap: space.s2,
            borderRadius: radius.glyph,
            backgroundColor: colors.surfaceAlt,
            pointerEvents: 'none',
          }}
        >
          <Value variant="chip" color={colors.ink} figure={figure}>
            {formatValue(shown.data[point]!)}
          </Value>
          {pointAt !== undefined ? (
            <Text variant="footnoteSm" color={colors.ink55}>
              {scrubTime(pointAt, timeSpan)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  /*
   * `pan-y` on the web: the browser keeps a vertical drag for scrolling the page, and a sideways one comes to the
   * scrub. Without it a phone browser could not scroll past a chart it had to start the scroll on.
   */
  return scrub === undefined ? (
    body
  ) : (
    <GestureDetector gesture={scrub} touchAction="pan-y">
      {body}
    </GestureDetector>
  );
}
