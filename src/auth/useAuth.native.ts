/**
 * The app's view of who is signed in and which wallet signs.
 *
 * Wraps Privy so the rest of the app never imports its SDK directly — the same reason every
 * screen goes through a repository rather than calling fetch.
 */
import { useCallback, useMemo, useState } from 'react';
import { usePrivy, useEmbeddedEthereumWallet, useLoginWithEmail, useLoginWithOAuth } from '@privy-io/expo';
import { alreadyHasWallet } from './alreadyHasWallet';
import type { SocialProvider } from './socialLogins';

export type AuthState = {
  ready: boolean;
  authenticated: boolean;
  userId?: string;
  /** The embedded wallet address — the `owner` in the on-chain delegation policy. */
  address?: string;
  email?: string;
};

export function useAuth(): AuthState & {
  logout: () => Promise<void>;
  createWallet: () => Promise<string | undefined>;
} {
  const { user, isReady, logout } = usePrivy();
  const { wallets, create } = useEmbeddedEthereumWallet();

  const address = wallets?.[0]?.address;
  const email = user?.linked_accounts?.find((a) => a.type === 'email') as
    | { address?: string }
    | undefined;

  const createWallet = useCallback(async () => {
    if (address) return address;
    try {
      // create() resolves to a provider, not a wallet record — the address lands in `wallets` on
      // the next render, so the caller reads it from there.
      await create();
    } catch (e) {
      // A returning user already has one and `wallets` has not caught up yet. See
      // alreadyHasWallet — that is the postcondition, not a failure. Everything else rethrows.
      if (!alreadyHasWallet(e)) throw e;
    }
    return undefined;
  }, [address, create]);

  return useMemo(
    () => ({
      ready: isReady,
      authenticated: !!user,
      userId: user?.id,
      address,
      email: email?.address,
      logout,
      createWallet,
    }),
    [isReady, user, address, email?.address, logout, createWallet],
  );
}

/** Email OTP login — the flow the onboarding screen drives. */
export function useEmailLogin() {
  const { sendCode, loginWithCode, state } = useLoginWithEmail();
  return { sendCode, loginWithCode, state };
}

/**
 * Google or X (2026-09-16): Privy's own OAuth flow opens the browser, and the account that comes back carries the same
 * embedded wallet an emailed code would have made — the executor knows a person by their Privy id, never by an email.
 *
 * Each method has to be switched on for this app in Privy's dashboard; one that is not says so (`oauthFailure`).
 */
export function useSocialLogin(): { login: (provider: SocialProvider) => Promise<void>; busy: boolean } {
  const { login } = useLoginWithOAuth();
  const [busy, setBusy] = useState(false);
  const start = useCallback(
    async (provider: SocialProvider) => {
      setBusy(true);
      try {
        await login({ provider });
      } finally {
        setBusy(false);
      }
    },
    [login],
  );
  return { login: start, busy };
}

/**
 * Bringing a wallet of your own — web only, so this answers with nothing here.
 *
 * The Expo SDK has no connector for a wallet living in another app: reaching one means WalletConnect or a deep link into
 * it, neither of which this build carries. A button that cannot finish is worse than no button, so the screen shows it
 * only where there is something behind it (`useAuth.web.ts`).
 */
export function useWalletLogin(): { login?: () => void } {
  return {};
}

