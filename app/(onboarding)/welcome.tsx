/**
 * Screen 1 — Splash. screens.md Group B.
 *
 * Lives at /welcome, NOT at the group index: both (onboarding) and (tabs) previously
 * declared an index route, so expo-router resolved "/" to whichever it found first and the
 * Home tab rendered the splash. The tabs group owns "/" now.
 *
 * Since 2026-09-16 it opens on xorr.finance's coin art (`CoinHero`: the film on the web, its still on a phone) under the
 * same XORR. wordmark, with the tagline as the one headline and the landing's white call to action, so the first
 * screen of the app and the first screen of the site read as one product. The card of pills and agent faces it
 * replaces said the same thing in smaller type.
 *
 * No balance appears here, invented or otherwise: there is no account yet to have one, and the app's own route sweep
 * asserts the prototype's figures are gone.
 */
import React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { brand } from '@/design/brand';
import { CoinHero } from '@/design/CoinHero';
import { Button, Fill, Press, Screen, signIn, Text, colors, size, space } from '@/ui';
import { Rise } from '@/ui/Rise';

const WORDMARK = require('../../assets/brand/xorr-wordmark.png');
/** The wordmark art is 833×166; drawn at the landing header's height. */
const WORDMARK_H = 18;
const WORDMARK_W = Math.round((WORDMARK_H * 833) / 166);

export default function Splash() {
  const router = useRouter();
  return (
    <Screen gutter="none">
      <Fill>
        <Rise index={0} style={{ flex: 1 }}>
          <CoinHero style={{ flex: 1 }} />
          <View style={{ position: 'absolute', top: space.s8, left: 0, right: 0, alignItems: 'center' }}>
            <Image
              source={WORDMARK}
              accessibilityLabel={brand.WORDMARK}
              style={{ width: WORDMARK_W, height: WORDMARK_H }}
              contentFit="contain"
            />
          </View>
        </Rise>
      </Fill>

      <View style={{ paddingHorizontal: space.gutter }}>
        <Rise index={1}>
          <Text variant="onboardingTitle" align="center">
            {brand.TAGLINE}
          </Text>
        </Rise>

        <Rise index={2} style={{ marginTop: space.s26 }}>
          <Button label="Get started" onPress={() => router.push('/goals')} />
          {/* A wallet that already exists goes straight to the email step, not through the questions a new one answers. */}
          <Button label="Sign in" variant="ghost" onPress={signIn} style={{ marginTop: space.s10 }} />
          {/*
            The two documents the sentence names, as links. It was plain text, so the first screen asked for agreement
            to documents it gave no way to read. Each link keeps a full-size touch area without growing the line.
          */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: space.s12 }}>
            <Text variant="footnote" color={colors.ink55}>
              {'By continuing you agree to the '}
            </Text>
            <Press
              onPress={() => router.push('/legal/terms')}
              accessibilityRole="link"
              accessibilityLabel="Read the Terms"
              hitHeight={size.hit}
            >
              <Text variant="footnote" color={colors.ink}>
                Terms
              </Text>
            </Press>
            <Text variant="footnote" color={colors.ink55}>
              {' and '}
            </Text>
            <Press
              onPress={() => router.push('/legal/privacy')}
              accessibilityRole="link"
              accessibilityLabel="Read the Privacy Policy"
              hitHeight={size.hit}
            >
              <Text variant="footnote" color={colors.ink}>
                Privacy Policy
              </Text>
            </Press>
            <Text variant="footnote" color={colors.ink55}>
              .
            </Text>
          </View>
        </Rise>
      </View>
    </Screen>
  );
}
