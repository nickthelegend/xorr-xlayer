/**
 * The development-only screens, sealed off from a shipped build.
 *
 * `app/_dev/` holds the design-system gallery, the edge-case gallery, the fidelity sheet and a
 * screen whose entire purpose is to throw during render. All four were plain routes with no guard,
 * so they shipped: `/_dev/ui` rendered every primitive in the design system over invented amounts
 * — "$66,560.18", repeated down the page — and `/_dev/boom` offered a button labelled "Throw during
 * render". Anyone who guessed the path, or read the bundle, had them.
 *
 * The leading underscore is not a guard. expo-router only treats `_layout` specially; every other
 * `_`-prefixed file is an ordinary route, which is why these were reachable in the browser.
 *
 * A layout is the right place for it rather than four copies of the same check: it covers the
 * screens that are here and the ones somebody adds later without thinking about it. `__DEV__` is
 * compiled to a constant, so in a production bundle the redirect is unconditional and the gallery
 * below it is dead code the minifier can drop.
 */
import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { colors } from '@/ui';

export default function DevLayout() {
  // Home, not a 404: these paths are not a mistake the user made, and there is nothing to explain.
  if (!__DEV__) return <Redirect href="/" />;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
  );
}

/** A gallery that throws must not take the app with it — same reasoning as every other segment. */
export { ScreenError as ErrorBoundary } from '@/errors/ErrorBoundary';
