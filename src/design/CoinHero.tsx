/**
 * The welcome screen's hero: a coin marked with the app's own geometry leading a tokenized-share coin along a metal
 * ribbon (PLAN.md D23, 2026-09-20).
 *
 * It used to be the landing film's first frame — a SOL coin leading BTC — which put another chain's mark on the first
 * screen of a product that settles on X Layer and trades tokenized shares. The mark on the lead coin is the app's own
 * abstract hexagon-and-X, not any company's logo, and the coin behind it carries a candlestick: what this app is for.
 *
 * Cropped around the lead coin, and faded into the screen's black at the top and bottom so the wordmark and the
 * headline sit on the art rather than on a rectangle.
 */
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { colors } from '@/ui';
import { COIN_FOCUS, HeroFades } from './coinHeroParts';

const POSTER = require('../../assets/brand/coin-hero.webp');

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
