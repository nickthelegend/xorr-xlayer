/**
 * ReservesHistoryChart.tsx — how an xStock's backing has moved.
 *
 * Two things make this chart honest rather than merely accurate.
 *
 * The scale is anchored to 1.0 (`reservesScale.ts`) instead of the series' own extent, so a token
 * that has sat a hair above fully backed draws as a flat line rather than a mountain range.
 *
 * The count is printed under it. A line from two readings and a line from two hundred look the
 * same, and a reader who assumes months of history from a two-point line has been misled by the
 * shape rather than by any number. Nothing is interpolated, so gaps stay gaps.
 */
import React from 'react';
import { View } from 'react-native';
import Svg, { Path, Line as SvgLine } from 'react-native-svg';
import { Text } from '../Text';
import { colors, space } from '../tokens';
import { lineFrame, lineX, lineY } from './line';
import { reservesBounds, seriesReadiness, FULLY_BACKED } from './reservesScale';
import { provenance, type ReservesHistory } from '../../data/reservesHistory';

export function ReservesHistoryChart({
  history,
  width = 280,
  height = 96,
}: {
  /** `undefined` while loading, `null` where it could not be read. */
  history?: ReservesHistory | null;
  width?: number;
  height?: number;
}) {
  if (history === undefined) {
    return (
      <Text variant="footnoteSm" color={colors.ink50}>
        Reading attestation history…
      </Text>
    );
  }
  if (history === null) {
    return (
      <Text variant="footnoteSm" color={colors.ink30}>
        Attestation history could not be loaded.
      </Text>
    );
  }

  const ratios = history.points.map((p) => p.ratio);
  const readiness = seriesReadiness(history.observations);
  const note = provenance(history);

  // One point is not a trend, and none is not an error. Both say so instead of drawing a line.
  if (readiness !== 'drawable') {
    return (
      <View style={{ gap: space.s4 }}>
        <Text variant="footnoteSm" color={colors.ink30}>
          {note}
        </Text>
        {readiness === 'single' ? (
          <Text variant="footnoteSm" color={colors.ink50}>
            {`Latest ${ratios[0]!.toFixed(4)}x`}
          </Text>
        ) : null}
      </View>
    );
  }

  const pad = 6;
  const frame = lineFrame(ratios, { width, height }, pad, reservesBounds(ratios));
  const path = ratios
    .map((r, i) => `${i === 0 ? 'M' : 'L'}${lineX(frame, i).toFixed(2)},${lineY(frame, r).toFixed(2)}`)
    .join(' ');
  const backedY = lineY(frame, FULLY_BACKED);
  const everShort = ratios.some((r) => r < FULLY_BACKED);

  return (
    <View style={{ gap: space.s6 }}>
      <Svg width={width} height={height}>
        {/* The only reference a reader needs: fully backed. */}
        <SvgLine
          x1={pad}
          y1={backedY}
          x2={width - pad}
          y2={backedY}
          stroke={colors.ink30}
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <Path
          d={path}
          stroke={everShort ? colors.warn : colors.up}
          strokeWidth={1.4}
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>
      <Text variant="footnoteSm" color={colors.ink30}>
        {`${note} Dashed line is 1:1.`}
      </Text>
    </View>
  );
}
