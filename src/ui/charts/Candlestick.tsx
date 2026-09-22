/**
 * Candlestick.tsx — the centrepiece.
 *
 * design.md §6, per candle:
 *   Wick  width 1.6 · radius 2 · opacity .75–.8 · colour = body colour
 *   Body  full column width · radius 3 · candleUp / candleDown · box-shadow bloom
 *
 * Nothing here is hand-placed. The component takes OHLC in **price space** and a
 * `projection` — tight for the pro chart, wide for Auto Close — measures the box it was
 * given, and multiplies the projected percentages by that. Change the height and every
 * candle moves correctly; change the TP price and the wide projection re-brackets itself.
 *
 * The bloom is `0 0 10px rgba(22,192,96,.35)` up / `rgba(239,59,54,.32)` down. It is a
 * glow, not a shadow, and §3 says it is what makes the charts read as premium. In SVG
 * that is an `feDropShadow` with no offset and `stdDeviation` = blur / 2, which is the
 * CSS-to-SVG conversion for a blur radius.
 *
 * Motion (2026-09-12, motion.ts): with `drawIn`, the candles are REVEALED left to right when the
 * chart appears, the way the reference video's chart draws itself. Never grown from a baseline and
 * never interpolated — every candle is complete and in place from the first frame, only uncovered.
 * A live update still mutates the last candle in place.
 *
 * Marks (FEATURES.md #9): `marks` are the user's own fills, each a triangle at the centre of the candle it happened in
 * and at its price, on the same projection as the candles — so build that projection with their prices in it.
 *
 * A range switch (FEATURES.md #83): with a `seriesKey`, a new key crossfades the old candles into the new ones while
 * the box, the grid and the axis gutter hold still, and `pending` steps the candles back while the next ones load.
 * The axis labels and the last-price chip are prices, and a price never animates: they change with the answer, at once.
 */
import React, { useEffect } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { ClipPath, Defs, FeDropShadow, Filter, G, Line, Path, Rect } from 'react-native-svg';
import { arrival, timing, useReducedMotion } from '../motion';
import { Value } from '../Text';
import { type as typeScale } from '../type';
import { chart, colors, duration, radius, space } from '../tokens';
import { Press } from '../Press';
import { describeSeries } from './describeSeries';
import { describeMarks, markPath, type CandleMark } from './marks';
import { columns, useMeasuredBox } from './useMeasuredBox';
import { axisLabels, projectSeries, toPct, type Candle, type Projection } from './projection';
import { PENDING_OPACITY, sameItems, useSeriesLayers } from './useSeriesLayers';

/** CSS `blur(N)` in a box-shadow is twice the Gaussian σ. */
const BLUR_TO_STD_DEVIATION = 0.5;
const BLOOM_BLUR = 10;
const BLOOM_OPACITY_UP = 0.35;
const BLOOM_OPACITY_DOWN = 0.32;
/** Room for the glow to spill outside each candle's own bounds. */
const FILTER_MARGIN = '-50%';
const FILTER_SPAN = '200%';
/** The axis gutter on the right of the plot, from the prototype. */
const AXIS_WIDTH = chart.axisWidth;

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedG = Animated.createAnimatedComponent(G);

/** How far an unselected candle steps back. Enough to recede, not enough to vanish. */
const DIMMED = 0.35;
/** The last-price chip's own height, derived from its variant rather than measured. */
const CHIP_HEIGHT = typeScale.chip.lineHeight + space.s2 * 2;

/** One empty list, so a chart with no marks does not hand its layers a new array on every render. */
const NO_MARKS: readonly CandleMark[] = [];

export interface CandlestickProps {
  series: readonly Candle[];
  /** Tight (pro chart) or wide (Auto Close). Build it with `tightProjection` / `wideProjection`. */
  projection: Projection;
  /** Plot height. The width comes from the layout. */
  height: number;
  /** Draw the derived price axis down the right-hand gutter. */
  showAxis?: boolean;
  /**
   * Horizontal rules behind the candles, at the same 25% intervals the area chart uses.
   * screens.md asks for them on the pro chart; design.md §6 does not put them in the candle
   * recipe, so they are opt-in rather than the default.
   */
  grid?: boolean;
  /** Formats an axis price. Defaults to `12.3K`. */
  formatAxis?: (price: number) => string;
  /** The dashed last-price rule and its chip. Pass the already-formatted label. */
  lastPrice?: { value: number; label: string };
  /** The chip sits on the left when a TP chip already occupies the right edge. */
  lastPriceSide?: 'left' | 'right';
  /** Renders in the light sheet: the rule and chip invert. */
  light?: boolean;
  /**
   * Which bar the user has tapped, if any — and how to tell the screen it changed.
   *
   * The chart was read-only: you could see the shape and never the open, high, low or close
   * of a single candle, even though the data was already loaded. Selecting dims the rest, so
   * the chosen bar is unmistakable, and the screen shows its numbers.
   *
   * Omit `onSelect` and the chart stays inert — no touch targets, no dimming.
   */
  selected?: number | null;
  onSelect?: (index: number | null) => void;
  /**
   * Reveal the candles left to right when the chart appears — and, without a `seriesKey`, again when the series
   * changes.
   */
  drawIn?: boolean;
  /**
   * The user's fills, each in the candle it happened in (`candleMarks`). Pass their prices to `tightProjection` too,
   * so a fill priced outside every candle is still in frame.
   */
  marks?: readonly CandleMark[];
  /**
   * What the series answers, such as a symbol and a range. A new key crossfades the old candles into the new ones;
   * the same key with new values changes in place. Without one, a new series is simply drawn, as it always was.
   */
  seriesKey?: string;
  /** The candles are the last answer, kept while the next ones load: stepped back, and none can be chosen. */
  pending?: boolean;
  /**
   * What a screen reader hears when the chart is one picture — that is, when no candle can be chosen. Defaults to the
   * move over its range. With `onSelect` every candle is its own button, and the chart does not fold them into an image.
   */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** What one layer draws. */
interface Drawn {
  series: readonly Candle[];
  projection: Projection;
  marks: readonly CandleMark[];
}

const sameCandle = (a: Candle, b: Candle) =>
  a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;
const sameMark = (a: CandleMark, b: CandleMark) => a.index === b.index && a.price === b.price && a.side === b.side;

function sameDrawn(a: Drawn, b: Drawn): boolean {
  return (
    a.projection.hi === b.projection.hi &&
    a.projection.lo === b.projection.lo &&
    sameItems(a.series, b.series, sameCandle) &&
    sameItems(a.marks, b.marks, sameMark)
  );
}

export function Candlestick({
  series,
  projection,
  height,
  showAxis = false,
  grid = false,
  formatAxis,
  lastPrice,
  lastPriceSide = 'right',
  light = false,
  selected = null,
  onSelect,
  drawIn = false,
  marks,
  seriesKey,
  pending = false,
  accessibilityLabel,
  style,
  testID,
}: CandlestickProps) {
  const [box, onLayout] = useMeasuredBox();
  /* Filter ids share a namespace across every SVG on screen, so two charts on one screen
     would otherwise fight over `candle-bloom-up`. */
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const bloomUp = `candle-up-${uid}`;
  const bloomDown = `candle-down-${uid}`;
  const clipId = `candle-reveal-${uid}`;

  /* What is on screen, and what is leaving it — see AreaChart, which does the same for a line. */
  const layers = useSeriesLayers<Drawn>(seriesKey ?? '', { series, projection, marks: marks ?? NO_MARKS }, sameDrawn);

  /*
   * The reveal: a clip whose width runs 0 → the full box. Without a `seriesKey` it restarts when the series changes;
   * with one it runs once, and a later series crossfades in instead.
   */
  const reduced = useReducedMotion();
  /*
   * Android draws the candles at once, and unclipped. react-native-svg there caches a clip's shape the first time it is
   * used, and a new width on the rect inside a <ClipPath> never clears that cache: the rect is never drawn itself, so
   * its invalidate returns early. The clip kept the width it mounted with, 0 from a first render that had measured no
   * box, and on an Android 15 emulator the asset screen showed its last-price rule and no candles (2026-09-15). The clip
   * exists only for the reveal; web and iOS reveal as before.
   */
  const revealing = drawIn && Platform.OS !== 'android';
  const reveal = useSharedValue(revealing ? 0 : 1);
  const measured = box.width > 0;
  const revealFor =
    seriesKey === undefined
      ? `${series.length}:${series[0]?.close ?? ''}:${series[series.length - 1]?.close ?? ''}`
      : series.length > 0;
  useEffect(() => {
    if (!revealing || !measured) return;
    reveal.value = 0;
    reveal.value = withTiming(1, arrival(duration.draw, reduced));
  }, [revealing, measured, revealFor, reduced, reveal]);
  const revealWidth = box.width;
  /*
   * Held to 0–1. On the web a timing's first frame can be stamped a moment before the timing started, and eased there
   * the progress reads just below zero: the web sweep at 2fa214a logged `<rect> attribute width: A negative value is
   * not valid` (-26.857 across a 362px chart, -0.074 of it) on the asset screen.
   */
  const clipProps = useAnimatedProps(() => ({ width: Math.min(1, Math.max(0, reveal.value)) * revealWidth }));

  /* The crossfade, on the interaction scale: a range switch answers a tap. Instant under reduced motion. */
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

  /* With no data there is nothing to project. Drawing an axis anyway would put a price
     scale on the screen that no price produced — on a trading surface an invented axis is
     worse than an empty box. */
  const hasData = series.length > 0;
  const plotWidth = Math.max(0, box.width - (showAxis ? AXIS_WIDTH : 0));
  /** Everything except the chosen candle steps back, so the selection is unmistakable. */
  const dimmed = (i: number) => selected !== null && selected !== i;
  const { columnWidth, xOf } = columns(plotWidth, series.length, chart.candle.gap);
  const pxOf = (pct: number) => (pct / 100) * height;

  const lastTop = lastPrice ? pxOf(toPct(projection, lastPrice.value)) : 0;
  const ruleInk = light ? chart.candle.markInkSheet : chart.candle.markInk;
  const wickOpacity = light ? chart.candle.wickOpacitySheet : chart.candle.wickOpacity;
  /* The last price belongs to the candles in front, so it steps back with them while they wait. Not animated. */
  const lastOpacity = pending ? PENDING_OPACITY : 1;

  const drawLayer = (slot: 0 | 1) => {
    const layer = layers.slots[slot];
    if (layer === null || layer.series.length === 0) return null;
    /* A selection is an index into the series in front; a series on its way out is drawn whole. */
    const inFront = slot === layers.front;
    const cols = columns(plotWidth, layer.series.length, chart.candle.gap);
    return (
      <>
        {projectSeries(layer.projection, layer.series).map((g, i) => {
          const colour = g.up ? colors.candleUp : colors.candleDown;
          const x = cols.xOf(i);
          const centre = x + cols.columnWidth / 2;

          return (
            <G key={i} opacity={inFront && dimmed(i) ? DIMMED : 1}>
              <Rect
                x={centre - chart.candle.wickWidth / 2}
                y={pxOf(g.wickTopPct)}
                width={chart.candle.wickWidth}
                height={Math.max(0, pxOf(g.wickHeightPct))}
                rx={chart.candle.wickRadius}
                fill={colour}
                opacity={wickOpacity}
              />
              <Rect
                x={x}
                y={pxOf(g.bodyTopPct)}
                width={cols.columnWidth}
                height={pxOf(g.bodyHeightPct)}
                rx={chart.candle.bodyRadius}
                fill={colour}
                filter={g.up ? `url(#${bloomUp})` : `url(#${bloomDown})`}
              />
            </G>
          );
        })}
        {/* In ink with a keyline, never a candle's green or red: a buy is not a profit. The triangle's direction is the side. */}
        {layer.marks.map((m, i) =>
          m.index < layer.series.length ? (
            <Path
              key={`mark-${i}`}
              d={markPath(cols.xOf(m.index) + cols.columnWidth / 2, pxOf(toPct(layer.projection, m.price)), m.side)}
              fill={light ? colors.sheet.ink : colors.ink}
              stroke={light ? colors.sheet.bg : colors.bg}
              strokeWidth={chart.candle.markStroke}
              strokeLinejoin="round"
            />
          ) : null,
        )}
      </>
    );
  };

  /* The move from the window's first open to its last close — the same span the line and the change chip measure. */
  const summary = [
    accessibilityLabel ?? describeSeries(hasData ? [series[0]!.open, ...series.map((c) => c.close)] : []),
    describeMarks(marks ?? NO_MARKS),
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View
      testID={testID}
      style={[{ height }, style]}
      onLayout={onLayout}
      accessible={!onSelect}
      accessibilityRole={onSelect ? undefined : 'image'}
      accessibilityLabel={onSelect ? undefined : summary}
    >
      {/*
        The touch layer sits ABOVE the SVG rather than inside it: react-native-svg's press
        handling differs between native and web, and a chart the user cannot tap on the web
        demo is a chart with no readout. One transparent target per column, sized and placed
        from the same `columns()` geometry the candles use, so they cannot drift apart.
      */}
      {box.width > 0 && hasData && (
        <>
          <Svg width={box.width} height={height}>
            <Defs>
              <Filter
                id={bloomUp}
                x={FILTER_MARGIN}
                y={FILTER_MARGIN}
                width={FILTER_SPAN}
                height={FILTER_SPAN}
              >
                <FeDropShadow
                  dx={0}
                  dy={0}
                  stdDeviation={BLOOM_BLUR * BLUR_TO_STD_DEVIATION}
                  floodColor={colors.candleUp}
                  floodOpacity={BLOOM_OPACITY_UP}
                />
              </Filter>
              <Filter
                id={bloomDown}
                x={FILTER_MARGIN}
                y={FILTER_MARGIN}
                width={FILTER_SPAN}
                height={FILTER_SPAN}
              >
                <FeDropShadow
                  dx={0}
                  dy={0}
                  stdDeviation={BLOOM_BLUR * BLUR_TO_STD_DEVIATION}
                  floodColor={colors.candleDown}
                  floodOpacity={BLOOM_OPACITY_DOWN}
                />
              </Filter>
              {revealing ? (
                <ClipPath id={clipId}>
                  <AnimatedRect x={0} y={0} height={height} animatedProps={clipProps} />
                </ClipPath>
              ) : null}
            </Defs>

            {grid
              ? chart.area.gridAt.map((t) => (
                  <Line
                    key={`grid-${t}`}
                    x1={0}
                    x2={plotWidth}
                    y1={height * t}
                    y2={height * t}
                    stroke={light ? colors.sheet.tick : chart.area.gridColor}
                    strokeWidth={1}
                  />
                ))
              : null}

            <G clipPath={revealing ? `url(#${clipId})` : undefined}>
              <AnimatedG animatedProps={slot0}>{drawLayer(0)}</AnimatedG>
              <AnimatedG animatedProps={slot1}>{drawLayer(1)}</AnimatedG>
            </G>

            {lastPrice && (
              <Line
                x1={0}
                y1={lastTop}
                x2={plotWidth}
                y2={lastTop}
                stroke={ruleInk}
                strokeWidth={chart.candle.markStroke}
                strokeDasharray={[...chart.candle.markDash]}
                opacity={lastOpacity}
              />
            )}
          </Svg>

          {onSelect && box.width > 0 && hasData && !pending ? (
            <View style={[StyleSheet.absoluteFill, hitLayer.passThrough]}>
              {series.map((_, i) => (
                <Press
                  key={`hit-${i}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Candle ${i + 1} of ${series.length}`}
                  accessibilityState={{ selected: selected === i }}
                  onPress={() => onSelect(selected === i ? null : i)}
                  style={{
                    position: 'absolute',
                    top: 0,
                    height,
                    left: xOf(i),
                    width: columnWidth + chart.candle.gap,
                  }}
                />
              ))}
            </View>
          ) : null}

          {showAxis && (
            <View
              style={{
                position: 'absolute',
                right: 0,
                top: 0,
                bottom: 0,
                width: AXIS_WIDTH,
                justifyContent: 'space-between',
                paddingLeft: space.s8,
                pointerEvents: 'none',
              }}
            >
              {/* Keyed by index, not by the label: a flat series projects every tick to
                  the same price, so the five labels are the same string. */}
              {axisLabels(projection, formatAxis).map((label, i) => (
                <Value
                  key={i}
                  variant="chipSm"
                  color={light ? colors.sheet.dim : colors.ink30}
                >
                  {label}
                </Value>
              ))}
            </View>
          )}

          {lastPrice && (
            <View
              style={{
                position: 'absolute',
                /* Centre the chip on the rule. The offset is half the chip's own height,
                   computed from its variant — nothing is measured and nothing is guessed. */
                top: lastTop - CHIP_HEIGHT / 2,
                left: lastPriceSide === 'left' ? space.s16 : undefined,
                right: lastPriceSide === 'right' ? 0 : undefined,
                backgroundColor: light ? colors.sheet.ink : colors.ink,
                borderRadius: light ? radius.square : radius.glyph,
                paddingVertical: space.s2,
                paddingHorizontal: space.s6,
                opacity: lastOpacity,
                pointerEvents: 'none',
              }}
            >
              <Value variant="chip" color={light ? colors.sheet.bg : colors.bg}>
                {lastPrice.label}
              </Value>
            </View>
          )}
        </>
      )}
    </View>
  );
}

/**
 * `box-none` through `StyleSheet.create`: react-native-web only honours it compiled. Inline, it is emitted as CSS,
 * where `box-none` is not a value, and silently dropped — the layer then took every touch between the candles.
 */
const hitLayer = StyleSheet.create({ passThrough: { pointerEvents: 'box-none' } });
