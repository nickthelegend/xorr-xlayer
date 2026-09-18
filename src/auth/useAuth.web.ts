/**
 * The web half of the auth surface. Same shape as useAuth.native.ts, so screens are identical
 * across platforms — see PrivyProvider.web.tsx for why the split exists.
 */
import { useCallback, useMemo, useState } from 'react';
import { usePrivy, useLogin, useLoginWithEmail, useLoginWithOAuth, useWallets, useCreateWallet } from '@privy-io/react-auth';
import type { SocialProvider } from './socialLogins';
import { pickEmbedded } from './embeddedWallet';
import { alreadyHasWallet } from './alreadyHasWallet';

export type AuthState = {
  ready: boolean;
  authenticated: boolean;
  userId?: string;
  address?: string;
  email?: string;
};

export function useAuth(): AuthState & {
  logout: () => Promise<void>;
  createWallet: () => Promise<string | undefined>;
} {
  const { ready, authenticated, user, logout } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet: create } = useCreateWallet();

  /*
   * The EMBEDDED wallet, not merely the first one Privy lists.
   *
   * This value is what gets registered with the executor and is named, in this file's own type,
   * as "the `owner` in the on-chain delegation policy". `useWallets()` includes injected browser
   * extensions, so on a browser with one installed this was somebody else's address.
   */
  const address = pickEmbedded(wallets)?.address;

  const createWallet = useCallback(async () => {
    if (address) return address;
    try {
      const w = await create();
      return w?.address;
    } catch (e) {
      // See alreadyHasWallet: right after login the SDK's wallet list is briefly empty, so a
      // returning user trips Privy's "one embedded wallet only" refusal on the happy path.
      if (!alreadyHasWallet(e)) throw e;
      return undefined;
    }
  }, [address, create]);

  return useMemo(
    () => ({
      ready,
      authenticated,
      userId: user?.id,
      address,
      email: user?.email?.address,
      logout,
      createWallet,
    }),
    [ready, authenticated, user, address, logout, createWallet],
  );
}

export function useEmailLogin() {
  const { sendCode, loginWithCode, state } = useLoginWithEmail();
  return { sendCode, loginWithCode, state };
}

/** Google or X on the web — the same accounts as native, through the web SDK's headless OAuth. See useAuth.native.ts. */
export function useSocialLogin(): { login: (provider: SocialProvider) => Promise<void>; busy: boolean } {
  const { initOAuth } = useLoginWithOAuth();
  const [busy, setBusy] = useState(false);
  const start = useCallback(
    async (provider: SocialProvider) => {
      setBusy(true);
      try {
        await initOAuth({ provider });
      } finally {
        setBusy(false);
      }
    },
    [initOAuth],
  );
  return { login: start, busy };
}

/**
 * Bringing a wallet of your own: Privy's modal, opened on its wallet list — MetaMask, Coinbase Wallet, Rainbow and the
 * rest of what the browser offers, plus WalletConnect. The wallet signs in; Privy still makes the embedded wallet this
 * app trades from, so the rest of onboarding is unchanged.
 */
export function useWalletLogin(): { login?: () => void } {
  const { login } = useLogin();
  return { login: () => login({ loginMethods: ['wallet'] }) };
}

