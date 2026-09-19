/**
 * The web half of `CoinHero`: the same still the native build shows.
 *
 * This played the landing's coin film, which opens on a SOL coin — another chain's mark on the first screen of a
 * product that settles on X Layer (PLAN.md D23). The art that replaced it is a still, so both halves now draw the
 * same thing and there is nothing to autoplay, nothing for a reduced-motion setting to suppress, and no video to
 * download before the first screen can be read.
 */
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { colors } from '@/ui';
import { COIN_FOCUS, HeroFades } from './coinHeroParts';

const POSTER = require('../../assets/brand/coin-hero.webp');
/** An alpha mask, not a colour: opaque in the middle, clear at the very edges. */
const SIDE_FADE = 'linear-gradient(to right, transparent 0%, #000 9%, #000 91%, transparent 100%)';

export function CoinHero({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.frame, style]} accessible={false}>
      {/* The mask is a web-only CSS property, which the Image style type does not carry — hence the cast. */}
      <Image
        source={POSTER}
        style={[StyleSheet.absoluteFill, { maskImage: SIDE_FADE, WebkitMaskImage: SIDE_FADE } as object]}
        contentFit="cover"
        contentPosition={COIN_FOCUS}
      />
      <HeroFades />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: colors.bg },
});
