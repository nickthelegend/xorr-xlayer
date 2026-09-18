/**
 * Sparkline.tsx
 *
 * design.md §6: `90×30 SVG · stroke #fff · stroke-width 1.4 · stroke-linejoin round ·
 * no fill · opacity .9`. Sits between the symbol and the price in market rows.
 *
 * **Direction is carried by the adjacent change text, not the line colour.** A green
 * sparkline and a green change figure say the same thing twice, and a green sparkline on
 * a row whose change is red is a contradiction the eye catches before the numbers do. The
 * line is white; the sign lives next to it.
 *
 * The 90×30 is fixed by §6, so this chart doesn't measure — it is a glyph, not a plot.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { chart, colors } from '../tokens';

export interface SparklineProps {
  /** The series, in value space. Scaled to its own extent. */
  data: readonly number[];
  width?: number;
  height?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Sparkline({
  data,
  width = chart.spark.width,
  height = chart.spark.height,
  style,
  testID,
}: SparklineProps) {
  if (data.length < 2) {
    return <View testID={testID} style={[{ width, height }, style]} />;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  /* Half the stroke at the top and bottom, so a peak isn't shaved off. */
  const pad = chart.spark.strokeWidth / 2;
  const plotHeight = height - pad * 2;

  const d = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = pad + ((max - v) / span) * plotHeight;
      return `${i === 0 ? 'M' : 'L'} ${x},${y}`;
    })
    .join(' ');

  return (
    <View testID={testID} style={style}>
      <Svg width={width} height={height} opacity={chart.spark.opacity}>
        <Path
          d={d}
          fill="none"
          stroke={colors.ink}
          strokeWidth={chart.spark.strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}
