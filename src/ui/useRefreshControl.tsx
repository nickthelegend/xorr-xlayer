/**
 * Pull to refresh, on the lists that show something changing — and an honest account of whether it worked.
 *
 * Every list here reads once on mount and then sits there. The bot trades while nobody is looking
 * — that is the entire product — so a list of what it did is stale from the moment it renders, and
 * the only way to see anything new was to navigate away and come back. On a phone, pulling down is
 * the gesture people already try; it simply did nothing.
 *
 * A hook rather than a component because `RefreshControl` is a prop on the scrolling view, not a
 * wrapper around it, and because the spinner's own state has to outlive the fetch: `useAsync` sets
 * `loading` only while nothing is cached, so a refresh of a list that already has data never sets
 * it, and the control would snap back before the request finished.
 *
 * ## A failed refresh says so (FEATURES.md #38)
 *
 * This used to end every refresh identically: `.finally(() => setRefreshing(false))`. The spinner retracted whether the
 * read answered or threw, so **a refresh that failed was pixel-identical to one that succeeded**. The gesture people
 * use precisely when they suspect the screen is stale would quietly leave it stale and say it had worked.
 *
 * That is the worst shape a failure can take: not an error nobody can act on, but a success nobody can doubt.
 *
 * So the outcome is kept (`refreshOutcome.ts`, pure and tested) and a failure is reported in the list itself, above the
 * rows it failed to replace. A success still says nothing — content arriving is its own confirmation, and a banner on
 * every pull trains people to ignore the banner that matters.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { RefreshControl, type RefreshControlProps } from 'react-native';
import { errorText } from '@/data/apiError';
import { NoteStrip } from './NoteStrip';
import { isRefreshing, refreshMessage, refreshStep, REFRESH_IDLE } from './refreshOutcome';
import { Press } from './Press';
import { Text } from './Text';
import { colors, space } from './tokens';

/** A spinner that vanishes in 40ms reads as the gesture not having worked, so a refresh is never shorter than this. */
const MINIMUM_MS = 400;

export type Refresher = {
  /** For a scrolling view's `refreshControl` prop. */
  control: React.ReactElement<RefreshControlProps>;
  /**
   * What to draw above the rows when the last pull failed, or `null`. Rendered by the screen so it sits inside the
   * list, over the content it failed to replace, rather than floating somewhere the reader is not looking.
   */
  notice: React.ReactNode;
  /** Whether a read is in flight, for a screen that wants to say so itself. */
  refreshing: boolean;
};

export function useRefreshControl(reload: () => unknown): Refresher {
  const [state, setState] = useState(REFRESH_IDLE);

  const onRefresh = useCallback(() => {
    setState((s) => refreshStep(s, { type: 'started' }));
    /*
     * `reload` may be sync or a promise, and either may throw. Both outcomes are reported; the minimum is deliberate,
     * and applies to a failure too — a failure that flashes past is one nobody read.
     */
    void Promise.all([Promise.resolve().then(reload), new Promise((r) => setTimeout(r, MINIMUM_MS))]).then(
      () => setState((s) => refreshStep(s, { type: 'succeeded' })),
      (e: unknown) => setState((s) => refreshStep(s, { type: 'failed', message: errorText(e) })),
    );
  }, [reload]);

  const message = refreshMessage(state);

  const notice = useMemo(
    () =>
      message === undefined ? null : (
        <NoteStrip kind="blocked" style={{ marginBottom: space.s10 }}>
          {/* The server's own sentence, and a way to be rid of it — it does not leave on its own. */}
          {`Couldn’t refresh. ${message} What you’re seeing is the last answer.`}
        </NoteStrip>
      ),
    [message],
  );

  const control = useMemo(
    () => (
      <RefreshControl
        refreshing={isRefreshing(state)}
        onRefresh={onRefresh}
        // The app is true black; the platform default spinner is invisible on it.
        tintColor={colors.ink45}
        colors={[colors.ink45]}
        progressBackgroundColor={colors.surface}
      />
    ),
    [state, onRefresh],
  );

  return { control, notice, refreshing: isRefreshing(state) };
}

/**
 * A dismissable version of the notice, for a screen with room for one.
 *
 * Kept separate because most lists want the strip and nothing else; a screen that wants the reader to be able to clear
 * it composes this instead.
 */
export function RefreshFailure({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <NoteStrip kind="blocked" style={{ marginBottom: space.s10 }}>
      {`Couldn’t refresh. ${message} What you’re seeing is the last answer.`}
      <Press onPress={onDismiss} accessibilityRole="button" accessibilityLabel="Dismiss the refresh failure">
        <Text variant="footnote" color={colors.ink55}>
          {' Dismiss'}
        </Text>
      </Press>
    </NoteStrip>
  );
}
