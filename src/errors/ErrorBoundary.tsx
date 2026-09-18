/**
 * One screen failing must not take the app down.
 *
 * Lives in `src/errors/`, not `src/app/`. expo-router scans for routes by directory name and
 * treated `src/app/ErrorBoundary.tsx` as a route file — it has no default export, so the router
 * refused to build its tree at all and EVERY route in the app became "Unmatched Route". A
 * directory called `app` anywhere in the source tree is a trap.
 *
 * React unmounts the whole tree when a render throws, so a single bad value anywhere — a null
 * where a number was expected, a malformed row from an endpoint — replaced the entire app with a
 * blank screen. On a trading app that is the worst possible failure mode: the user cannot see
 * their balance, cannot reach the safety screen, and cannot stop the bot.
 *
 * So the boundary wraps each screen rather than the app. The tab bar keeps working, the kill
 * switch stays reachable, and the failure is confined to the one thing that broke.
 *
 * It shows the error rather than a friendly nothing. This codebase's standing position is that a
 * server which hides its errors is worse than one that fails, and the same is true here — a person
 * who can read "Cannot read properties of null" can tell us what happened; a person looking at
 * "Something went wrong" cannot.
 */
import React from 'react';
import { ScrollView } from 'react-native';
import { Button, Screen, SheetCard, Text, colors, radius, space } from '@/ui';

/**
 * The shape expo-router hands a layout's `ErrorBoundary` export.
 *
 * Exporting this from a `_layout.tsx` scopes the boundary to that segment — which is the
 * whole point: a failing tab screen keeps the tab bar, so the user can still reach Safety
 * and stop the bot. A boundary at the root would catch the same error and take the
 * navigation down with it.
 */
export function ScreenError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <Screen style={{ justifyContent: 'center' }}>
      <SheetCard borderRadius={radius.panel} padding={space.s18} style={{ gap: space.s10 }}>
        <Text variant="cardTitleLg" color={colors.down}>
          This screen could not render.
        </Text>
        <Text variant="body" color={colors.ink45}>
          The rest of the app is unaffected — your balance, your permission and the stop
          button all still work.
        </Text>
        <ScrollView style={{ maxHeight: 140 }}>
          {/*
            The real message, not a friendly nothing.
            This codebase's standing position is that a server which hides its errors is
            worse than one that fails, and it applies here too: someone who can read "Cannot
            read properties of null" can tell us what happened, and someone looking at
            "Something went wrong" cannot.
          */}
          <Text variant="footnote" color={colors.ink32} selectable>
            {error.message}
          </Text>
        </ScrollView>
        <Button
          label="Try again"
          height={44}
          style={{ marginTop: space.s4 }}
          onPress={retry} testID="boundary-retry" />
      </SheetCard>
    </Screen>
  );
}
