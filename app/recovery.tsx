/**
 * Recovery — PLAN.md 10.8, 4.10; distilled 2026-09-14.
 *
 * The login is the recovery: the same email on any device reaches the same wallet, and xorr never holds its key. Where
 * a copy of the key can be had — Privy's export window on the web — the screen offers it; a phone says where to go.
 * It once told a user their wallet was shared with the executor, which was never true; it now says only what is.
 *
 * "Done" on Safety and Settings means a recovery step was taken here: the key's export window was opened and closed,
 * or the person said they can open the email this wallet signs in with. It was set by "Got it", so reading this
 * screen was reported, on two other screens, as a backup that never happened.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  Button,
  Eyebrow,
  Fill,
  Screen,
  SheetCard,
  SignInButton,
  Text,
  colors,
  radius,
  space,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { usePrivyIdentity } from '@/auth/usePrivyIdentity';
import { useStore } from '@/state/store';
import { useKeyExport } from '@/wallet/useKeyExport';
import { errorText } from '@/data/apiError';

export default function Recovery() {
  const goBack = useGoBack();
  const signedOut = useSignedOut();
  const { email } = usePrivyIdentity();
  const wallet = useStore((s) => s.wallet);
  const setRecoveryBackedUp = useStore((s) => s.setRecoveryBackedUp);
  const done = useStore((s) => s.recoveryBackedUp);
  const keyExport = useKeyExport(wallet?.address);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string>();

  async function exportKey() {
    if (!keyExport.supported || exporting) return;
    setExportError(undefined);
    setExporting(true);
    try {
      await keyExport.exportKey();
      // Privy's window offered this wallet's key to its owner and was closed. That is the step, taken.
      setRecoveryBackedUp(true);
    } catch (e) {
      setExportError(errorText(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
        <BackButton onPress={() => goBack()} />
        <Text variant="screenTitle">Recovery</Text>
      </View>

      <Text variant="onboardingTitle" style={{ marginTop: space.s20 }}>
        Your email is the way back
      </Text>
      <Text variant="body" color={colors.ink55} style={{ marginTop: space.s10 }}>
        Sign in with it on any device to open this wallet.
      </Text>

      <Fill style={{ marginTop: space.s26 }}>
        {/* The address itself, so "your email" is a specific inbox the person can check they still open. */}
        {email ? (
          <SheetCard borderRadius={radius.panel} padding={space.s16} style={{ marginBottom: space.s16 }}>
            <Eyebrow small>Email</Eyebrow>
            <Text variant="rowPrimary" selectable style={{ marginTop: space.s6 }}>
              {email}
            </Text>
          </SheetCard>
        ) : null}
        {keyExport.supported ? (
          <>
            <Button label="Export private key" variant="secondary" loading={exporting} onPress={exportKey} />
            <Text variant="footnote" color={colors.ink55} align="center" style={{ marginTop: space.s10 }}>
              Shown in a secure window. xorr never sees it.
            </Text>
          </>
        ) : (
          <Text variant="footnote" color={colors.ink55}>
            {keyExport.reason}
          </Text>
        )}
        {exportError ? (
          <Text variant="footnote" color={colors.down} style={{ marginTop: space.s10 }}>
            {exportError}
          </Text>
        ) : null}
      </Fill>

      {signedOut ? (
        <SignInButton />
      ) : done ? (
        <Button label="Done" onPress={() => goBack()} />
      ) : email ? (
        /* Stated as what it is: the person says they can open this inbox. Reading the screen marks nothing. */
        <Button
          label="I can open this email"
          onPress={() => {
            setRecoveryBackedUp(true);
            goBack();
          }}
        />
      ) : null}
    </Screen>
  );
}
