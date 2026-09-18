/**
 * The screen for the one condition the app will not keep running under.
 *
 * Why this and not a banner is argued in `chainMatch.ts`: a chain mismatch is the single failure where no
 * screen's numbers mean anything and the kill switch itself would be signed on the wrong chain. Everything
 * else in this app degrades and stays usable on purpose.
 *
 * What it has to do, in order:
 *
 *   1. **Say nothing has been sent.** That is the first question, and it is true — this renders before any
 *      screen is reached, so no button has been available to press.
 *   2. **Name both sides.** "Wrong network" is unactionable. The two chain keys are exactly what someone
 *      has to compare against their build and their deploy.
 *   3. **Give the fix.** Which is a real one: point the build at the executor for its chain, or the reverse.
 *      The two environment variables are named because they are what actually gets changed, and whoever is
 *      looking at this screen is the person who can change them.
 *   4. **Offer a recheck, not a dismissal.** The mismatch is resolved by a redeploy, not by a tap. A button
 *      that hid this would hide it over a live wallet.
 *
 * No `Screen` gutter games and no tab bar: there is nothing to navigate to.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { Button, Screen, SheetCard, Text, colors, radius, space } from '@/ui';
import type { ChainMatch } from './chainMatch';

type Mismatch = Extract<ChainMatch, { state: 'mismatch' }>;

export function ChainMismatchScreen({ mismatch, onRecheck }: { mismatch: Mismatch; onRecheck?: () => void }) {
  return (
    <Screen style={{ justifyContent: 'center' }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ justifyContent: 'center', flexGrow: 1 }}>
        <SheetCard borderRadius={radius.panel} padding={space.s18} style={{ gap: space.s12 }}>
          <Text variant="cardTitleLg" color={colors.down} accessibilityRole="header">
            {mismatch.headline}
          </Text>
          <Text variant="body" color={colors.ink45}>
            {mismatch.detail}
          </Text>

          {/*
            The two keys, side by side and selectable. This is the content of the screen: whoever can fix
            this needs to compare them against a build and a deployment, and reading them off a photo of a
            phone is how that actually happens.
          */}
          <View style={{ gap: space.s6, marginTop: space.s4 }}>
            <Side label="This app signs on" chain={mismatch.app} />
            <Side label="Its server is on" chain={mismatch.server} />
          </View>

          <Text variant="footnote" color={colors.ink55}>
            {/*
              Named variables, because the person reading this is the person who sets them. `src/chain.ts`
              reads the first and `server/src/evm/chains.ts` reads the second, and the two are meant to be
              the same name in the same environment.
            */}
            Point this build at the executor for its chain (EXPO_PUBLIC_API_URL), or set
            EXPO_PUBLIC_XORR_CHAIN to the chain that executor serves. The app and the executor read the same
            name from the same environment by design.
          </Text>

          {mismatch.realMoney ? (
            <Text variant="footnote" color={colors.down}>
              One of these chains is real money. Do not sign anything until they agree.
            </Text>
          ) : null}

          {/*
            A recheck, never a dismissal. What fixes this is a redeploy, and the check runs again on its own
            heartbeat anyway — this is for the person who has just changed it and does not want to wait.
          */}
          {onRecheck ? (
            <Button label="Check again" height={44} style={{ marginTop: space.s4 }} onPress={onRecheck} testID="chain-recheck" />
          ) : null}
        </SheetCard>
      </ScrollView>
    </Screen>
  );
}

function Side({ label, chain }: { label: string; chain: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.s10 }}>
      <Text variant="secondary" color={colors.ink55}>
        {label}
      </Text>
      <Text variant="secondary" color={colors.ink} selectable accessibilityLabel={`${label} ${chain}`}>
        {chain}
      </Text>
    </View>
  );
}
