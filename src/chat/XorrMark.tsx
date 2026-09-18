/**
 * xorr's mark as the room's avatar — the X and its green point, in plum on a pearl disc.
 *
 * Traced from `assets/brand/xorr-app-icon.png` (four bars meeting at a cross-shaped gap, a green dot
 * off the lower-right arm) into a 100-unit box. The icon is white on black and this room is light, so
 * the PNG itself would be a black square on a lavender ground.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, G, Polygon, RadialGradient, Stop } from 'react-native-svg';
import { chat, chatShadow } from './theme';

const BARS = [
  '19.5,25.5 30.1,25.5 47.8,43.3 47.8,48 41.9,48',
  '69.8,25.5 80.4,25.5 57.8,48 51.9,48 51.9,43.3',
  '41.9,51.9 47.8,51.9 47.8,56.5 30.6,73.1 20.3,73.1',
  '51.9,51.9 57.8,51.9 78.5,73.1 68.4,73.1 51.9,56.5',
] as const;

export function XorrMark({ size = 40, style }: { size?: number; style?: StyleProp<ViewStyle> }) {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const pearl = `mark-pearl-${uid}`;

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel="xorr"
      style={[{ width: size, height: size, borderRadius: size / 2, boxShadow: chatShadow }, style]}
    >
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id={pearl} cx="34%" cy="28%" r="80%">
            <Stop offset={0} stopColor="#FFFFFF" />
            <Stop offset={0.62} stopColor="#F1EDFB" />
            <Stop offset={1} stopColor="#DAD2F2" />
          </RadialGradient>
        </Defs>
        <Circle cx={50} cy={50} r={49} fill={`url(#${pearl})`} />
        <Circle cx={50} cy={50} r={48.5} stroke="#FFFFFF" strokeWidth={1.5} fill="none" />
        {/* The traced mark spans 19.5–85 by 25.5–73; at 0.6 this centres it on the disc. */}
        <G transform="translate(19.4 20.4) scale(0.6)">
          {BARS.map((points) => (
            <Polygon key={points} points={points} fill={chat.heading} />
          ))}
          <Circle cx={81.4} cy={68.3} r={3.9} fill={chat.brandGreen} />
        </G>
      </Svg>
    </View>
  );
}
