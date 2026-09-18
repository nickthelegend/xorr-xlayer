/**
 * What an empty list says, and where it sends you.
 *
 * Every list in this app can be empty, and an empty list is the first thing a new account sees on most
 * screens. "Nothing here yet." is true and it is a dead end: it tells someone the state of their account
 * and nothing about how to change it, on the one screen where changing it is the only thing worth doing.
 *
 * Each entry is a sentence and the single next action that would fill that list. Kept in one table rather
 * than written into each screen for three reasons:
 *
 *   - It can be audited. A list added to the app without an entry here is a list nobody wrote an exit for,
 *     and the test beside this file will say which.
 *   - The routes can be checked against `app/`. A CTA pointing at a screen that does not exist is a dead
 *     end with extra steps, and expo-router will not say so until someone taps it.
 *   - The wording stays one voice. Six screens each inventing "Nothing here" is how "Nothing running yet",
 *     "Nothing yet." and "No alerts yet." end up three sentences for one idea.
 *
 * `href` is a route, not a callback, because every next action in this app IS a screen. Where a list's only
 * honest next action is to read it again — a failed read is not an empty list — the screen uses `ErrorState`
 * instead, which is what a retry belongs to.
 *
 * The one import is a TYPE, so this file still loads on Node for its test: expo-router's runtime would not.
 */
import type { Href } from 'expo-router';

/** A list that can be empty, by the thing it lists rather than by the screen it is on. */
export type EmptyListKey =
  | 'positions'
  | 'walletTokens'
  | 'activity'
  | 'strategies'
  | 'watchlist'
  | 'schedule'
  | 'alerts'
  | 'limitOrders'
  | 'tradable'
  | 'approvals'
  | 'proposals'
  | 'realised';

export type EmptyListCopy = {
  /** What is true about the list, in one sentence. Never a guess at why. */
  text: string;
  /** The next action, as a verb. */
  actionLabel: string;
  /**
   * Where that action goes: a real route under `app/`, checked by the test beside this file.
   *
   * The string half of `Href` only — where expo-router's generated route types are present that is the union of
   * this app's actual paths, so a renamed screen fails the typecheck as well as the test.
   */
  href: Extract<Href, string>;
};

export const EMPTY_LISTS: Record<EmptyListKey, EmptyListCopy> = {
  /* The four the product is built around. */
  positions: {
    text: 'Nothing held yet.',
    actionLabel: 'Set up a recurring buy',
    href: '/strategy/dca',
  },
  activity: {
    text: 'Nothing yet.',
    actionLabel: 'Set up a recurring buy',
    href: '/strategy/dca',
  },
  strategies: {
    text: 'Nothing running yet.',
    actionLabel: 'Set up a recurring buy',
    href: '/strategy/dca',
  },
  /*
   * The watchlist is what the EXECUTOR can follow on this chain, not a list the user saved — so an empty one
   * is a statement about the network, and the action that changes it is changing networks, not adding a row.
   */
  watchlist: {
    text: 'Nothing to follow here yet.',
    actionLabel: 'See other networks',
    href: '/networks',
  },

  /* The rest, in the same shape. */
  walletTokens: {
    text: 'No tokens in this wallet yet.',
    actionLabel: 'Add funds',
    href: '/deposit',
  },
  schedule: {
    text: 'Nothing is scheduled.',
    actionLabel: 'Set up a recurring buy',
    href: '/strategy/dca',
  },
  alerts: {
    text: 'No alerts yet.',
    actionLabel: 'Set an alert',
    href: '/alerts/new',
  },
  limitOrders: {
    text: 'No limit orders yet.',
    actionLabel: 'Browse markets',
    href: '/tokens',
  },
  tradable: {
    text: 'Nothing can be traded here right now.',
    actionLabel: 'See other networks',
    href: '/networks',
  },
  approvals: {
    text: 'No approvable tokens on this chain.',
    actionLabel: 'See other networks',
    href: '/networks',
  },
  proposals: {
    text: 'Nothing is waiting on you.',
    actionLabel: 'See what agents did',
    href: '/activity',
  },
  /* Realised P&L is empty until something is sold, and selling is not something to push someone toward. */
  realised: {
    text: 'Nothing has been sold yet, so nothing is realised.',
    actionLabel: 'See what is held',
    href: '/portfolio',
  },
};

/** One list's empty state, as the props `EmptyState` takes. `onAction` is the screen's, since routing is. */
export function emptyList(key: EmptyListKey): EmptyListCopy {
  return EMPTY_LISTS[key];
}
