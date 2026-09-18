/**
 * The web half of `CoinHero`: the landing's coin film itself, muted and looping.
 *
 * A browser that refuses autoplay, or a person who asked for reduced motion, gets the film's own first frame as the
 * poster, so nothing jumps and nothing moves that should not. The shared parts come from `coinHeroParts`, never from
 * `./CoinHero`, which on the web is this file.
 */
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Asset } from 'expo-asset';
import { colors, useReducedMotion } from '@/ui';
import { COIN_FOCUS, HeroFades } from './coinHeroParts';

const POSTER = Asset.fromModule(require('../../assets/landing/hero-poster.webp')).uri;
const WEBM = Asset.fromModule(require('../../assets/landing/hero.webm')).uri;
const MP4 = Asset.fromModule(require('../../assets/landing/hero.mp4')).uri;
/** An alpha mask, not a colour: opaque in the middle, clear at the very edges. */
const SIDE_FADE = 'linear-gradient(to right, transparent 0%, #000 9%, #000 91%, transparent 100%)';

export function CoinHero({ style }: { style?: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  return (
    <View style={[styles.frame, style]} accessible={false}>
      <video
        key={reduced ? 'still' : 'film'}
        autoPlay={!reduced}
        muted
        loop
        playsInline
        preload="auto"
        poster={POSTER}
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: `${COIN_FOCUS.left} ${COIN_FOCUS.top}`,
          // On a desktop browser the app is a column on a black page: the film's sides sink into it, as on the landing.
          maskImage: SIDE_FADE,
          WebkitMaskImage: SIDE_FADE,
        }}
      >
        <source src={WEBM} type="video/webm" />
        <source src={MP4} type="video/mp4" />
      </video>
      <HeroFades />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: colors.bg },
});
