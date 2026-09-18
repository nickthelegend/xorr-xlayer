/**
 * Back, or somewhere sensible when there is no back.
 *
 * Every screen called `router.back()` directly — 47 times across 33 files — and none of them asked
 * whether there was anything to go back TO. There often is not: a deep link, a refresh, a shared
 * URL, or simply opening the app on a route other than the tab shell all produce a history of one.
 * expo-router then logs
 *
 *   The action 'GO_BACK' was not handled by any navigator. Is there any screen to go back to?
 *
 * and does nothing. The user sits on the form they just submitted, with no acknowledgement and no
 * way out but the browser's own back button — which is also empty.
 *
 * React Navigation's warning says it is development-only, which is true of the LOG and not of the
 * behaviour: in production the same tap silently does nothing at all.
 *
 * ASK THE SCREEN'S OWN NAVIGATOR (2026-09-12). This used to ask `router.canGoBack()` and then call
 * `router.back()`. The first question is answered for the whole tree and the second action is sent
 * from the root — so with a coin opened as a sheet over the tab shell, "can go back" was true and the
 * GO_BACK still landed where no navigator took it: the back button on the price sheet did nothing,
 * twice, on a real simulator. The screen's own `navigation` object asks and acts on the navigator the
 * screen actually lives in, and bubbles to its parents from there.
 */
import { useCallback } from 'react';
import { useNavigation, useRouter } from 'expo-router';
import type { Href } from 'expo-router';

/**
 * @param fallback Where to go when there is no history. The tab shell by default, because that is
 *                 the one destination every screen can reach and nobody is stranded on.
 */
export function useGoBack(fallback: Href = '/'): () => void {
  const router = useRouter();
  const navigation = useNavigation();
  return useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
    else router.replace(fallback);
  }, [navigation, router, fallback]);
}
