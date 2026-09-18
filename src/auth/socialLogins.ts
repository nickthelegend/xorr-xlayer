/**
 * The ways into a wallet besides an email code (2026-09-16).
 *
 * Privy is the one identity here, whichever way someone arrives: the account it makes carries the embedded wallet, and
 * the executor knows a person by their Privy id — never by their email — so a Google or X account is as complete an
 * account as an emailed code makes. `twitter` is the id Privy has always used for X; the label is what people call it.
 *
 * Each has to be switched on for this app in Privy's own dashboard before it can be offered; one that is not says so
 * (`oauthFailure`) rather than failing silently.
 */
export type SocialProvider = 'google' | 'twitter';

export const SOCIAL_LOGINS: readonly { id: SocialProvider; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'twitter', label: 'X' },
];
