/**
 * VolumeBars.tsx
 *
 * design.md §6:
 *   Row under the candles · height 42 · align-items:flex-end · gap 6, matching the candle
 *   gutter · bars flex:1 · radius 2px 2px 0 0 · fill rgba(22,192,96,.5) / rgba(239,59,54,.5)
 *   following that candle's direction.
 *
 * "matching the candle gutter" is the whole point: the volume bar under candle *n* must
 * sit exactly under candle *n*, so this takes the same gap token and the same column
 * arithmetic as `Candlestick`. Pass the same `paddingRight` (the axis gutter) if the
 * chart above has an axis.
 *
 * Bars are scaled against the largest volume in the window, not against an absolute — a
 * volume row is a shape, not a quantity the user reads off.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { chart } from '../tokens';
import { columns, useMeasuredBox } from './useMeasuredBox';
import type { Candle } from './projection';

export interface VolumeBarsProps {
  series: readonly Candle[];
  /** §6: 42. */
  height?: number;
  /** Reserve the same right-hand axis gutter the candle chart above is using. */
  axisWidth?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function VolumeBars({
  series,
  height = chart.volume.height,
  axisWidth = 0,
  style,
  testID,
}: VolumeBarsProps) {
  const [box, onLayout] = useMeasuredBox();
  const plotWidth = Math.max(0, box.width - axisWidth);
  const { columnWidth, xOf } = columns(plotWidth, series.length, chart.volume.gap);

  const peak = series.reduce((max, c) => Math.max(max, c.volume ?? 0), 0);

  return (
    <View testID={testID} style={[{ height }, style]} onLayout={onLayout}>
      {box.width > 0 && (
        <Svg width={box.width} height={height}>
          {series.map((c, i) => {
            const fraction = peak > 0 ? (c.volume ?? 0) / peak : 0;
            const barHeight = fraction * height;
            if (barHeight <= 0) return null;

            const x = xOf(i);
            const y = height - barHeight;
            const r = Math.min(chart.volume.radius, columnWidth / 2, barHeight);

            return (
              <Path
                key={i}
                /* Radius on the top corners only — the bar grows from the baseline. */
                d={
                  `M ${x} ${height}` +
                  ` V ${y + r}` +
                  ` A ${r} ${r} 0 0 1 ${x + r} ${y}` +
                  ` H ${x + columnWidth - r}` +
                  ` A ${r} ${r} 0 0 1 ${x + columnWidth} ${y + r}` +
                  ` V ${height} Z`
                }
                fill={c.close >= c.open ? chart.volume.upFill : chart.volume.downFill}
              />
            );
          })}
        </Svg>
      )}
    </View>
  );
}
