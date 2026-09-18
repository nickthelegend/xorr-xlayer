/**
 * The landing page's coin art, as the welcome screen's hero (2026-09-16).
 *
 * xorr.finance opens on a SOL coin leading BTC, ETH, tokenized stocks and USDC along a metal ribbon; the app's first
 * screen shows the same art so the two read as one product. On a phone it is the still: the app has no video module,
 * and adding one would mean a new native build for a background. The web build plays the film (`CoinHero.web.tsx`).
 *
 * Cropped around the SOL coin, and faded into the screen's black at the top and bottom so the wordmark and the
 * headline sit on the art rather than on a rectangle.
 */
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { colors } from '@/ui';
import { COIN_FOCUS, HeroFades } from './coinHeroParts';

const POSTER = require('../../assets/landing/hero-poster.webp');

export function CoinHero({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.frame, style]} accessible={false}>
      <Image source={POSTER} style={StyleSheet.absoluteFill} contentFit="cover" contentPosition={COIN_FOCUS} />
      <HeroFades />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: colors.bg },
});
