/**
 * The room's centrepiece: one glass bubble, iridescent, lit from the top left.
 *
 * Drawn rather than an image, in a 100-unit box so every size is the same drawing: a body that runs
 * from rose through lavender into cyan, a rose bloom on the left, the selected agent's own colour
 * welling up from the lower right — so switching agent changes the light in the room without changing
 * the object — then a sheen, a bright rim and a curved highlight, and a soft floor shadow under it.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  FeGaussianBlur,
  Filter,
  LinearGradient,
  Path,
  RadialGradient,
  Stop,
} from 'react-native-svg';

export interface GlassOrbProps {
  size: number;
  /** The selected agent's colour, rising from the lower right. */
  tint: string;
  style?: StyleProp<ViewStyle>;
}

/** The floor shadow's height, as a fraction of the orb. */
const FLOOR = 0.12;

export function GlassOrb({ size, tint, style }: GlassOrbProps) {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const id = (name: string) => `glass-${name}-${uid}`;
  const url = (name: string) => `url(#${id(name)})`;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width: size, alignItems: 'center' }, style]}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          boxShadow: `0 ${Math.round(size * 0.1)}px ${Math.round(size * 0.26)}px rgba(150, 118, 226, 0.32)`,
        }}
      >
        <Svg width={size} height={size} viewBox="0 0 100 100">
          <Defs>
            <RadialGradient id={id('body')} cx="34%" cy="30%" r="78%">
              <Stop offset={0} stopColor="#FCE8F8" />
              <Stop offset={0.3} stopColor="#E7BDF2" />
              <Stop offset={0.58} stopColor="#BFA0F2" />
              <Stop offset={0.84} stopColor="#95B4F4" />
              <Stop offset={1} stopColor="#86DDF3" />
            </RadialGradient>
            <RadialGradient id={id('rose')} cx="18%" cy="46%" r="42%">
              <Stop offset={0} stopColor="#FF9AD9" stopOpacity={0.5} />
              <Stop offset={1} stopColor="#FF9AD9" stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id={id('tint')} cx="74%" cy="82%" r="52%">
              <Stop offset={0} stopColor={tint} stopOpacity={0.6} />
              <Stop offset={1} stopColor={tint} stopOpacity={0} />
            </RadialGradient>
            <LinearGradient id={id('sheen')} x1="0.1" y1="0" x2="0.7" y2="0.9">
              <Stop offset={0} stopColor="#FFFFFF" stopOpacity={0.5} />
              <Stop offset={0.5} stopColor="#FFFFFF" stopOpacity={0} />
            </LinearGradient>
            <RadialGradient id={id('rim')} cx="50%" cy="50%" r="50%">
              <Stop offset={0.78} stopColor="#FFFFFF" stopOpacity={0} />
              <Stop offset={0.95} stopColor="#FFFFFF" stopOpacity={0.4} />
              <Stop offset={1} stopColor="#FFFFFF" stopOpacity={0.9} />
            </RadialGradient>
            <Filter id={id('soft')} x="-50%" y="-50%" width="200%" height="200%">
              <FeGaussianBlur stdDeviation={1.2} />
            </Filter>
          </Defs>

          <Circle cx={50} cy={50} r={49} fill={url('body')} />
          <Circle cx={50} cy={50} r={49} fill={url('rose')} />
          <Circle cx={50} cy={50} r={49} fill={url('tint')} />
          <Circle cx={50} cy={50} r={49} fill={url('sheen')} />
          <Circle cx={50} cy={50} r={49} fill={url('rim')} />

          {/* The curved highlight across the top left, its bright point, and the faint one it throws back. */}
          <Path
            d="M19 38 C 21 25, 32 15, 47 13"
            stroke="#FFFFFF"
            strokeOpacity={0.9}
            strokeWidth={3.2}
            strokeLinecap="round"
            fill="none"
            filter={url('soft')}
          />
          <Ellipse
            cx={27}
            cy={25}
            rx={4.2}
            ry={2.4}
            fill="#FFFFFF"
            opacity={0.95}
            transform="rotate(-38 27 25)"
            filter={url('soft')}
          />
          <Path
            d="M70 86 C 80 80, 87 70, 89 58"
            stroke="#FFFFFF"
            strokeOpacity={0.45}
            strokeWidth={1.6}
            strokeLinecap="round"
            fill="none"
            filter={url('soft')}
          />
        </Svg>
      </View>

      <Svg width={size} height={size * FLOOR} viewBox="0 0 100 12" style={{ marginTop: size * 0.03 }}>
        <Defs>
          <RadialGradient id={id('floor')} cx="50%" cy="50%" r="50%">
            <Stop offset={0} stopColor="#8E74D6" stopOpacity={0.26} />
            <Stop offset={1} stopColor="#8E74D6" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Ellipse cx={50} cy={6} rx={34} ry={5} fill={url('floor')} />
      </Svg>
    </View>
  );
}
