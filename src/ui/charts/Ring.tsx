/**
 * Ring.tsx — a share of a whole, as a thin ring with its figure inside (FEATURES.md #34).
 *
 * Safety draws two: today's cap used, and the permission's time left. A glyph beside the words rather than a plot, so it
 * keeps one size and measures nothing, the way `Sparkline` keeps §6's 90×30.
 *
 * A share that is not known draws no ring at all — not an empty one. An empty ring is a zero, and a spend nobody measured
 * drawn as nothing spent is the false negative the screen it sits on exists not to tell. The figure then stands alone,
 * or is a dash when it is unknown too.
 *
 * White on the control track, never green or red: a cap used is not a profit or a loss. It does not move — nothing in
 * animations.md sanctions it, and the figure inside must not.
 */
import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { Text } from '../Text';
import { colors, space } from '../tokens';

/** The ring's diameter and its stroke: thin enough to read as a line, not a dial. */
const DIAMETER = 56;
const STROKE = 3;

export interface RingProps {
  /** How much of the whole, 0 to 1 (drawn clamped). Undefined when it is not known: then there is no ring. */
  fraction: number | undefined;
  /** The figure inside — "29%", "5d" — or an em dash. */
  value: string;
  /** One short label under it. */
  label: string;
  /** What a screen reader hears. Defaults to the label and the figure. */
  accessibilityLabel?: string;
  testID?: string;
}

/** The arc from twelve o'clock, clockwise, through `share` of the circle. */
function arcPath(center: number, r: number, share: number): string {
  const angle = share * 2 * Math.PI;
  const x = center + r * Math.sin(angle);
  const y = center - r * Math.cos(angle);
  return `M ${center} ${center - r} A ${r} ${r} 0 ${share > 0.5 ? 1 : 0} 1 ${x} ${y}`;
}

export function Ring({ fraction, value, label, accessibilityLabel, testID }: RingProps) {
  const share =
    typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : undefined;
  const center = DIAMETER / 2;
  const r = (DIAMETER - STROKE) / 2;

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? `${label}, ${value}`}
      style={{ alignItems: 'center', gap: space.s8 }}
    >
      <View style={{ width: DIAMETER, height: DIAMETER, alignItems: 'center', justifyContent: 'center' }}>
        {share !== undefined ? (
          <Svg width={DIAMETER} height={DIAMETER} style={{ position: 'absolute', left: 0, top: 0 }}>
            <Circle cx={center} cy={center} r={r} fill="none" stroke={colors.control} strokeWidth={STROKE} />
            {share >= 1 ? (
              <Circle cx={center} cy={center} r={r} fill="none" stroke={colors.ink} strokeWidth={STROKE} />
            ) : share > 0 ? (
              <Path
                d={arcPath(center, r, share)}
                fill="none"
                stroke={colors.ink}
                strokeWidth={STROKE}
                strokeLinecap="round"
              />
            ) : null}
          </Svg>
        ) : null}
        <Text variant="rowPrimary">{value}</Text>
      </View>
      <Text variant="footnote" color={colors.ink55}>
        {label}
      </Text>
    </View>
  );
}
