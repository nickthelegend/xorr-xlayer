/**
 * Privy on web.
 *
 * `@privy-io/expo` is a native-only SDK — it reads the app's bundle identifier and throws on
 * react-native-web. The web SDK is a separate package, so the provider is platform-split rather
 * than forced into one implementation. Metro picks `.web.tsx` for web and `.native.tsx` for
 * iOS/Android automatically; nothing else in the app knows the difference.
 */
import React from 'react';
import { PrivyProvider as WebProvider } from '@privy-io/react-auth';
import { activeChain, supportedChains } from '@/chain';
import { colors } from '@/ui';

const APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID;

if (!APP_ID) {
  throw new Error('EXPO_PUBLIC_PRIVY_APP_ID is required — the app has no offline login path.');
}

export function AppPrivyProvider({ children }: { children: React.ReactNode }) {
  return (
    <WebProvider
      appId={APP_ID!}
      config={{
        // A wallet is created on login for anyone who does not already have one, which is what
        // makes "sign in and you own a wallet" a single step rather than two.
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        // The same ways in as the onboarding screen offers (`src/auth/socialLogins.ts`); each is switched on per app in
        // Privy's dashboard, and one that is not simply does not appear here.
        loginMethods: ['email', 'google', 'twitter', 'github', 'wallet'],
        // Follows EXPO_PUBLIC_XORR_CHAIN — see src/chain.ts for what hardcoding this cost.
        defaultChain: activeChain,
        supportedChains,
        appearance: {
          theme: 'dark',
          accentColor: colors.ink,
          showWalletLoginFirst: false,
          /*
           * "Continue with a wallet" (P4.10, D17): OKX Wallet first — it is the wallet X Layer's own users hold — then
           * whatever the browser has injected, then Privy's defaults. `okx_wallet` is Privy's own id for it
           * (`WalletListEntry` in @privy-io/react-auth). EVM only: the app signs on X Layer, nothing else.
           *
           * Coinbase Wallet is NOT offered. Its SDK says so itself on every load — "The configured chains are not
           * supported by Coinbase Smart Wallet: 196, 196, 1952" — so the entry was an offer this app cannot honour on
           * the only chains it signs on, and the SDK's cross-origin probe put a failed HEAD request in the network
           * tab of every screen on the way.
           */
          walletList: ['okx_wallet', 'detected_ethereum_wallets', 'metamask', 'rainbow', 'wallet_connect'],
          walletChainType: 'ethereum-only',
        },
      }}
    >
      {children}
    </WebProvider>
  );
}

export const PRIVY_APP_ID = APP_ID;
export const SURFACE = colors.bg;
