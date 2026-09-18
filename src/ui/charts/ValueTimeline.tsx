/**
 * ValueTimeline.tsx — the wallet's history, drawn as the things that were recorded and nothing else.
 *
 * Two series, drawn differently because they are true differently. The arithmetic is `timeline.ts`; this is the drawing.
 *
 *   **Net invested** — a step line from the recorded fills. Flat between two fills because it *was* flat between two
 *   fills, exactly, so joining those two points claims nothing. Every corner is a fill that happened.
 *
 *   **Observed value** — the recorded readings, as points, joined into a line only across stretches where readings were
 *   taken continuously. Where nothing was recorded for a while there is a visible **gap**, because a line across it
 *   would be a claim about time nobody looked at — and would be indistinguishable from a line across time somebody did.
 *
 * ## What this chart will not do
 *
 * It will not interpolate, smooth or curve-fit a value. It will not synthesise a point at the edge so a line reaches
 * the axis. It will not draw a single reading as a trend: one point has no direction, and inventing one is inventing
 * the only thing the reader came for — so with fewer than two recorded things the screen says what it has instead.
 *
 * And a wallet with nothing recorded gets **nothing**, never a flat line along zero. A flat line is a measurement; it
 * says "we watched, and it did not move". Drawing that for a wallet nobody ever recorded is the false negative this
 * whole product exists not to tell.
 *
 * ## The motion
 *
 * The same rule the allocation donut keeps: the chart is only ever **revealed**, left to right, over `duration.draw`.
 * No point moves to a new value, nothing grows into place, and no figure is animated between two numbers. Every point
 * is at its true height in the first frame it is visible. Under reduced motion it is simply drawn.
 */
import React, { useEffect, useRef } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, ClipPath, Defs, G, Path, Rect } from 'react-native-svg';
import { arrival, duration, useReducedMotion } from '../motion';
import { Text } from '../Text';
import { chart, colors, radius, space } from '../tokens';
import {
  recordedCount,
  timelineBounds,
  type InvestedStep,
  type TimelineObservation,
} from './timeline';

const AnimatedRect = Animated.createAnimatedComponent(Rect);

/** Room for a stroke or a dot at the very edge, so neither is clipped in half. */
const PAD = 6;
/** A recorded reading, drawn where it was taken. */
const DOT = 2.6;

export interface ValueTimelineProps {
  /** The net-invested steps, from `netInvestedSteps`. */
  steps: readonly InvestedStep[];
  /** Observations grouped into continuously-recorded runs, from `observedRuns`. */
  runs: readonly (readonly TimelineObservation[])[];
  height?: number;
  /** Measured width. Nothing is drawn until the box is known. */
  width: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Where a moment and an amount land in the box. */
function projector(bounds: { minAt: number; maxAt: number; minUsd: number; maxUsd: number }, w: number, h: number) {
  const spanT = bounds.maxAt - bounds.minAt;
  const spanV = bounds.maxUsd - bounds.minUsd;
  const plotW = Math.max(0, w - PAD * 2);
  const plotH = Math.max(0, h - PAD * 2);
  return {
    // A single moment, or a series that all happened at once, sits in the middle rather than at an arbitrary edge.
    x: (at: number) => (spanT <= 0 ? PAD + plotW / 2 : PAD + ((at - bounds.minAt) / spanT) * plotW),
    // A flat series sits on the centre line: there is no top or bottom to put it at when nothing varied.
    y: (usd: number) => (spanV <= 0 ? PAD + plotH / 2 : PAD + (1 - (usd - bounds.minUsd) / spanV) * plotH),
  };
}

/** The step path: across at the height it held, then up or down exactly where the next fill was recorded. */
function stepPath(steps: readonly InvestedStep[], px: (at: number) => number, py: (usd: number) => number): string {
  if (steps.length === 0) return '';
  const parts: string[] = [`M ${px(steps[0]!.at)},${py(steps[0]!.netInvestedUsd)}`];
  for (let i = 1; i < steps.length; i += 1) {
    const previous = steps[i - 1]!;
    const step = steps[i]!;
    parts.push(`L ${px(step.at)},${py(previous.netInvestedUsd)}`);
    parts.push(`L ${px(step.at)},${py(step.netInvestedUsd)}`);
  }
  return parts.join(' ');
}

/** One continuously-recorded run, joined reading to reading. A run of one draws no line — its dot stands alone. */
function runPath(run: readonly TimelineObservation[], px: (at: number) => number, py: (usd: number) => number): string {
  if (run.length < 2) return '';
  return run.map((p, i) => `${i === 0 ? 'M' : 'L'} ${px(p.at)},${py(p.totalUsd)}`).join(' ');
}

export function ValueTimeline({ steps, runs, width, height = 150, style, testID }: ValueTimelineProps) {
  const reduced = useReducedMotion();
  const bounds = timelineBounds(steps, runs);
  const count = recordedCount(steps, runs);

  /* 0 before the reveal, 1 with the whole width shown. */
  const reveal = useSharedValue(0);
  const shape = `${count}:${bounds?.minAt ?? 0}:${bounds?.maxAt ?? 0}:${width}`;
  const revealed = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (width <= 0 || count < 2 || revealed.current === shape) return;
    revealed.current = shape;
    reveal.set(0);
    reveal.set(withTiming(1, arrival(duration.draw, reduced)));
  }, [shape, width, count, reduced, reveal]);

  // Held to 0–1 the way AreaChart holds its clip: a first frame stamped before the timing began eases to a negative width.
  const clip = useAnimatedProps(() => ({ width: Math.min(1, Math.max(0, reveal.get())) * width }));

  if (width <= 0 || bounds === undefined || count < 2) return <View testID={testID} style={[{ height }, style]} />;

  const { x, y } = projector(bounds, width, height);
  const invested = stepPath(steps, x, y);

  return (
    <View testID={testID} style={[{ width, height }, style]}>
      <Svg width={width} height={height}>
        <Defs>
          <ClipPath id="timeline-reveal">
            <AnimatedRect x={0} y={0} height={height} animatedProps={clip} />
          </ClipPath>
        </Defs>
        <G clipPath="url(#timeline-reveal)">
          {/* Every recorded reading, where it was taken — the line between them is secondary to the points themselves. */}
          {runs.map((run, i) => (
            <React.Fragment key={`run-${i}`}>
              {run.length > 1 ? (
                <Path
                  d={runPath(run, x, y)}
                  fill="none"
                  stroke={colors.ink}
                  strokeWidth={chart.spark.strokeWidth}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ) : null}
              {run.map((p) => (
                <Circle key={p.at} cx={x(p.at)} cy={y(p.totalUsd)} r={DOT} fill={colors.ink} />
              ))}
            </React.Fragment>
          ))}

          {/* What was put in: a step, dimmer than the value it is there to be read against. */}
          {invested ? (
            <Path
              d={invested}
              fill="none"
              stroke={colors.ink45}
              strokeWidth={chart.spark.strokeWidth}
              strokeLinejoin="miter"
              strokeLinecap="butt"
            />
          ) : null}
          {steps.map((s) => (
            <Circle key={`step-${s.at}`} cx={x(s.at)} cy={y(s.netInvestedUsd)} r={DOT} fill={colors.ink45} />
          ))}
        </G>
      </Svg>
    </View>
  );
}

/**
 * What the screen shows instead of a chart, when there is not enough recorded to draw one.
 *
 * Two different facts with two different sentences. Nothing recorded is not the same as one thing recorded, and neither
 * is "the portfolio was flat" — which is what a line along zero would have said about both.
 */
export function TimelineNotYet({ count, style }: { count: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        {
          paddingVertical: space.s20,
          paddingHorizontal: space.s16,
          borderRadius: radius.panel,
          backgroundColor: colors.surfaceAlt,
        },
        style,
      ]}
    >
      <Text variant="body" color={colors.ink55}>
        {count === 0
          ? 'Nothing has been recorded yet, so there is no history to draw.'
          : 'One reading so far. A single point has no direction, so there is no line to draw until there is a second.'}
      </Text>
    </View>
  );
}
