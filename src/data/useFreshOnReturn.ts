/**
 * Read a screen's numbers again when someone comes back to it (FEATURES.md #27).
 *
 * Coming back is two events: the screen regaining focus — a pushed screen closed over it, a tab switched back to — and
 * the app returning to the foreground while the screen is in view. Each asks every read passed in to refresh itself, and
 * each read decides by `shouldReread` (`reread.ts`): not while it is already reading, and not within fifteen seconds of
 * its last answer.
 *
 * The screen keeps what it shows while it reads — no placeholder, no skeleton — because a refresh does not change the
 * question, so `loading` never turns on. See `refreshIfStale` in `useAsync.ts`.
 *
 * Opt-in, a screen at a time, rather than the default for every `useAsync`: not every read is a read. The chat's opening
 * line GENERATES a proposal (`POST /proposals/generate`), and the two backtest screens post a replay for the executor to
 * compute. A return must repeat neither.
 *
 * On web `AppState` is react-native-web's, which listens for the document's `visibilitychange`: a browser tab brought back
 * to the front is the app returning to the foreground.
 */
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { AsyncState } from './useAsync';

export function useFreshOnReturn(...reads: Pick<AsyncState<unknown>, 'refreshIfStale'>[]): void {
  // The reads as of the latest render, for listeners subscribed once per focus.
  const latest = useRef(reads);
  useEffect(() => {
    latest.current = reads;
  });

  useFocusEffect(
    useCallback(() => {
      const refresh = () => {
        for (const read of latest.current) read.refreshIfStale();
      };
      // Focus is itself a return.
      refresh();
      // Only while this screen is in view: blur removes the listener, so a screen underneath waits for its own focus.
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') refresh();
      });
      // react-native-web hands back nothing where there is no document to listen to.
      return () => subscription?.remove();
    }, []),
  );
}
