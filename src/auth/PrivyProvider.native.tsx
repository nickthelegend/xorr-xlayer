/**
 * Privy — identity and the embedded wallet, in one object.
 *
 * The user logs in with a code sent to their email and gets a wallet they own — the only login built; passkeys
 * need Privy's dashboard and the app's associated domains first (PLAN.md 4.11, 8.9). There is no separate
 * account system to keep in sync with a wallet, which is what makes "your keys, your wallet"
 * true rather than a slogan: xorr never sees the private key, and the bot's authority over that
 * wallet is a separate on-chain permission the user signs and can revoke.
 */
import React from 'react';
import { PrivyProvider as Provider } from '@privy-io/expo';
// PrivyElements ships from the /ui subpath, not the package root.
import { PrivyElements } from '@privy-io/expo/ui';
import { colors } from '@/ui';

const APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID;

if (!APP_ID) {
  throw new Error(
    'EXPO_PUBLIC_PRIVY_APP_ID is required. The app has no offline login path by design — an ' +
      'unauthenticated build would talk to an executor that rejects it anyway.',
  );
}

export function AppPrivyProvider({ children }: { children: React.ReactNode }) {
  return (
    <Provider appId={APP_ID!} config={{ embedded: { ethereum: { createOnLogin: 'users-without-wallets' } } }}>
      {children}
      {/* Privy's own login sheet, themed to match the app's true-black surface. */}
      <PrivyElements config={{ appearance: { colorScheme: 'dark', accentColor: colors.ink } }} />
    </Provider>
  );
}

export const PRIVY_APP_ID = APP_ID;
export const SURFACE = colors.bg;
