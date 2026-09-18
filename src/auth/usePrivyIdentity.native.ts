/**
 * Who is signed in, as Privy knows them — the email the account was made with, and what to call them when there is
 * none: a Google account's email, or an X handle (2026-09-16).
 *
 * Split by platform like `useAuth`: the Expo SDK and the web SDK shape their user differently. Only
 * the email is read here. The wallet address comes from the executor, which is the authority on
 * which wallet the app is actually using.
 */
import { usePrivy } from '@privy-io/expo';

/** The one field of a linked account this reads. The Expo SDK types the list loosely. */
type LinkedAccount = { type?: string; address?: string; email?: string; username?: string };

export function usePrivyIdentity(): { email: string | null; name: string | null } {
  const { user } = usePrivy();
  const accounts = (user as { linked_accounts?: LinkedAccount[] } | null)?.linked_accounts ?? [];
  const email = accounts.find((a) => a.type === 'email')?.address ?? null;
  const google = accounts.find((a) => a.type === 'google_oauth');
  const x = accounts.find((a) => a.type === 'twitter_oauth');
  // `name` is whatever this account can be called; `email` stays strictly an email, since screens say "email".
  return { email, name: email ?? google?.email ?? (x?.username ? `@${x.username}` : null) };
}
