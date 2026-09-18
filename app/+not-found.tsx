/**
 * The app's own answer to a URL that does not exist.
 *
 * Without this file expo-router ships its DEVELOPMENT fallback to production, and that is what the
 * public build was serving: an unstyled "Unmatched Route — Page could not be found", the full
 * mistyped URL echoed back to the reader, and a **Sitemap** link that enumerates every route in
 * the app — including `_dev/*`, which the router otherwise sends home. Three problems in one
 * screen a stranger reaches by fat-fingering an address.
 *
 * The URL is deliberately NOT repeated here. Reflecting whatever was in the address bar back onto
 * the page is a habit worth not having, and a person who mistyped a URL already knows what they
 * typed; what they need is a way back.
 */
import React from 'react';
import { View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { Button, Fill, HeaderBar, Screen, Text, colors, space } from '@/ui';

export default function NotFound() {
  const path = usePathname();

  return (
    <Screen>
      <HeaderBar
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        title={<Text variant="screenTitle">Not found</Text>}
      />

      <Fill style={{ justifyContent: 'center', gap: space.s12 }}>
        <Text variant="onboardingTitle" align="center">
          There is nothing here
        </Text>
        <Text variant="body" color={colors.ink55} align="center">
          {/*
            Naming the segment is useful — "no screen called /widgets" tells someone which part of
            a bookmark went stale — and it is not the same as echoing the whole address back.
          */}
          {path && path !== '/'
            ? `No screen is registered at ${path}. It may have been a stale link.`
            : 'That address does not match any screen in this app.'}
        </Text>

        <View style={{ marginTop: space.s16, gap: space.s10 }}>
          <Button label="Go to your wallet" onPress={() => router.replace('/')} testID="notfound-home" />
          <Button
            label="Everything this app can show you"
            variant="ghost"
            onPress={() => router.replace('/explore')}
            testID="notfound-explore"
          />
        </View>
      </Fill>
    </Screen>
  );
}
