/**
 * Ruler.tsx — the TP / SL scrub track.
 *
 * design.md §6:
 *   height 22 · repeating-linear-gradient(90deg, #E4E4E9 0 1px, transparent 1px 9px)
 *   background-size 100% 12px, vertically centred · marker width 2, full height,
 *   TP green / SL red.
 *
 * The CSS repeats a 1px tick every 9px across whatever width it lands in. Here the tick
 * count comes from the measured width for the same reason — a fixed count would stretch
 * or bunch the ticks on a different screen.
 *
 * animations.md: the TP/SL markers are **not animated**. They jump to the new projected
 * price. A slide would imply the *price* moved rather than the user's setting.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { chart, colors } from '../tokens';
import { useMeasuredBox } from './useMeasuredBox';

export interface RulerProps {
  /** Marker position, 0–1 across the track. state.md derives it as `20 + tp*22` / `80 + sl*22`. */
  position: number;
  /** Which side of the trade this track sets. The only reason it is green or red. */
  tone: 'tp' | 'sl';
  height?: number;
  /** On black rather than in the light sheet — the ticks take the dark hairline. */
  dark?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Ruler({
  position,
  tone,
  height = chart.ruler.height,
  dark = false,
  style,
  testID,
}: RulerProps) {
  const [box, onLayout] = useMeasuredBox();

  const tickCount =
    box.width > 0 ? Math.ceil(box.width / chart.ruler.tickPitch) : 0;
  const tickTop = (height - chart.ruler.tickHeight) / 2;
  const clamped = Math.min(1, Math.max(0, position));
  const markerX = clamped * (box.width - chart.ruler.markerWidth);

  return (
    <View testID={testID} style={[{ height }, style]} onLayout={onLayout}>
      {box.width > 0 && (
        <Svg width={box.width} height={height}>
          {Array.from({ length: tickCount }, (_, i) => (
            <Rect
              key={i}
              x={i * chart.ruler.tickPitch}
              y={tickTop}
              width={chart.ruler.tickWidth}
              height={chart.ruler.tickHeight}
              fill={dark ? colors.hairlineStrong : colors.sheet.tick}
            />
          ))}
          <Rect
            x={markerX}
            y={0}
            width={chart.ruler.markerWidth}
            height={height}
            fill={tone === 'tp' ? colors.candleUp : colors.candleDown}
          />
        </Svg>
      )}
    </View>
  );
}
