/**
 * Settings — PLAN.md 10.3 [G14]. The Home gear had no destination.
 * Wallet, delegation status + revoke, security, notifications, the TONE DIAL, legal.
 *
 * Signed out, the rows that describe a wallet are left out rather than answered with "Unavailable" and
 * "Not granted", and the session row signs in.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import { useAuth } from '@/auth/useAuth';
import {
  CloseButton,
  Eyebrow,
  Fill,
  Price,
  Row,
  Screen,
  Segmented,
  SheetCard,
  Text,
  colors,
  radius,
  size,
  space,
  signIn,
} from '@/ui';
import { capLabel, delegateUnusable, delegationExpired, permissionUnreadable } from '@/state/derived';
import { useStore } from '@/state/store';
import { delegationOrUnknown, delegationScope } from '@/accounts/delegationScope';
import { useNow } from '@/state/useNow';
import { useAllowlist } from '@/wallet/allowlist';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { TONES, useTone } from '@/bot/tone';
import { useVoice } from '@/chat/voice';
import { NotSignedIn, errorText } from '@/data/apiError';
import { VersionRow } from '@/about/VersionRow';

const SETTING_ROW = 54;
const TONE_OPTIONS = TONES.map((t) => ({ value: t.id, label: t.label }));

export default function Settings() {
  const router = useRouter();
  const goBack = useGoBack();
  // The store's `wallet` is only ever set by the onboarding screen, so deep-linking here —
  // or opening Settings in a session that did not run onboarding — showed "Address: None"
  // and "Network: —" for a user who has a wallet. Read the source of truth, like every
  // other screen does, and fall back to the store only while that request is in flight.
  const stored = useStore((s) => s.wallet);
  const { data: fetched, error: walletError } = useAsync(() => repos.wallet.current(), []);
  const wallet = fetched ?? stored;
  // "None" and "—" are claims about the wallet. If we could not reach the executor we have
  // no claim to make, so say that instead.
  const unreachable = walletError !== undefined && !wallet;
  const recoveryBackedUp = useStore((s) => s.recoveryBackedUp);
  const { addresses, loading: allowlistLoading, error: allowlistError } = useAllowlist();
  const { tone, setTone } = useTone();
  // Whether anything in this build can speak in that tone (`src/chat/voice.ts`, read as the tab shell mounts).
  const voiceConfigured = useVoice((s) => s.configured);

  /*
   * The permission, read from the chain when the screen opens — and judged the way Safety judges it.
   *
   * Status was `killed || delegation?.revoked` over whatever the store happened to hold: no expiry
   * check, no delegate-key check, and the `killed` flag that drifts from the chain. So a grant that
   * had run out, or that named a key the executor no longer signs with, read "Live" here while
   * Safety, one tap away, said Expired or Disconnected. The same helpers now decide both rows, in the
   * same order, and the stored delegation is only the answer until the read lands.
   */
  /*
   * The cached permission ONLY when it belongs to the address in use.
   *
   * A switch re-points every executor call at another account; carrying the old grant across would
   * show one account's cap while the executor acts on another. `undefined` is "not read yet",
   * which is what every reader here already treats as still-loading — `null` is a claim that this
   * address has granted nothing, and must never stand in for not having looked.
   */
  const storedDelegation = delegationOrUnknown(
    delegationScope({
      cached: useStore((s) => s.delegation),
      cachedFor: useStore((s) => s.delegationAddress),
      active: useStore((s) => s.wallet?.address),
    }),
  );
  const storedKilled = useStore((s) => s.killed);
  const permission = useAsync(() => repos.wallet.delegation(), []);
  const delegation = permission.data !== undefined ? permission.data : storedDelegation;
  const now = useNow();
  const killed = delegation ? delegation.revoked : storedKilled;
  const unusable = delegateUnusable(delegation, killed);
  const expired = delegationExpired(delegation, killed, now);
  // Signed out is not a failed read: the whole section is left out then, below.
  const readError = permission.error instanceof NotSignedIn ? undefined : permission.error;
  const unreadable = permissionUnreadable(readError, delegation);
  const reading = permission.loading && permission.data === undefined && !storedDelegation;

  const status = reading
    ? { label: '· · ·', color: colors.ink55 }
    : unreadable
      ? { label: '—', color: colors.ink55 }
      : unusable
        ? { label: 'Disconnected', color: colors.down }
        : !delegation
          ? { label: 'Not granted', color: colors.ink55 }
          : expired
            ? { label: 'Expired', color: colors.down }
            : killed
              ? { label: 'Stopped', color: colors.ink55 }
              : { label: 'Live', color: colors.up };

  /*
   * Sign out. There was no way to.
   *
   * `useAuth` has exposed `logout` since it was written and not one screen called it, so a
   * signed-in session could only be ended by deleting the app — which does not even work, because
   * Privy keeps the session in the iOS keychain and it survives a reinstall. On a shared or lost
   * phone that is the whole account, and for anyone testing it means one account, forever.
   *
   * Two taps rather than a dialog: the app has no modal confirm of its own, and the row saying
   * what the second tap does is clearer than inventing one. Biometrics gate what the BOT may do —
   * signing out changes none of that, and the on-chain permission is untouched by it, which the
   * row says out loud so nobody reads this as a kill switch.
   */
  const { logout, ready, authenticated } = useAuth();
  const signedOut = ready && !authenticated;
  const forgetAccount = useStore((s) => s.forgetAccount);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string>();

  async function signOut() {
    if (!confirmingSignOut) {
      setConfirmingSignOut(true);
      return;
    }
    setSignOutError(undefined);
    try {
      await logout();
      // The persisted store outlives the session, and the entry gate reads `wallet` to choose
      // between onboarding and the tab shell. Leaving it set signs you out into a signed-in shell,
      // and the rest of what it keeps about the person went to whoever signed in next.
      forgetAccount();
      router.replace('/welcome');
    } catch (e) {
      setConfirmingSignOut(false);
      setSignOutError(errorText(e));
    }
  }

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="screenTitle">Settings</Text>
        <CloseButton onPress={() => goBack()} />
      </View>

      <Fill style={{ marginTop: space.s20 }}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {signedOut ? null : (
            <>
              <Eyebrow small>Wallet</Eyebrow>
              <Row
                title="Address"
                value={
                  <Price color={colors.ink55}>
                    {wallet
                      ? `${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}`
                      : unreachable
                        ? 'Unavailable'
                        : 'None'}
                  </Price>
                }
                height={SETTING_ROW}
              />
              <Row
                title="Recovery"
                value={
                  <Text variant="rowPrimary" color={recoveryBackedUp ? colors.ink55 : colors.warn}>
                    {recoveryBackedUp ? 'Done' : 'Review'}
                  </Text>
                }
                height={SETTING_ROW}
                onPress={() => router.push('/recovery')}
              />
            </>
          )}

          {/*
            One door to everything the app can show about itself — the verification report, the
            approvals, the runs, the network. Thirty-odd surfaces cannot each earn a row here, and
            a screen nobody can reach is worse than no screen.
          */}
          <Row
            title="Explore"
            value={
              <Text variant="rowPrimary" color={colors.ink55}>
                Everything else
              </Text>
            }
            height={SETTING_ROW}
            onPress={() => router.push('/explore')}
          />

          {signedOut ? null : (
            <>
              <Eyebrow small style={{ marginTop: space.s26 }}>
                Permission
              </Eyebrow>
              {/*
                "Live · $1,600/day" for a wallet that has granted nothing.

                `cap` is the value the SLIDER is sitting on — a preference the user has not signed —
                and `stopped` was only true once a delegation existed and was revoked. So before any
                grant this section read "Status Live, Daily cap $1,600/day" under a heading that says
                "What the bot may do". The bot may do nothing; there is no permission. Same mistake as
                the two dashes on Safety, in the opposite direction: there it said too little, here it
                claimed something that was not true.
              */}
              <Row
                title="Status"
                value={
                  <Text variant="rowPrimary" color={status.color}>
                    {status.label}
                  </Text>
                }
                height={SETTING_ROW}
                onPress={() => router.push('/safety')}
              />
              <Row
                title="Daily cap"
                value={
                  delegation ? (
                    /*
                      The cap that was SIGNED, not the one the slider is sitting on.

                      `cap` is a local preference the user can move without granting anything, so this
                      row reported a number the chain had never seen — on the row whose whole job is to
                      say how much the bot may spend. `dailyCapUsd` comes off the delegation itself.
                    */
                    <Price color={colors.ink55}>{capLabel(delegation.dailyCapUsd)}</Price>
                  ) : (
                    <Text variant="rowPrimary" color={colors.ink55}>
                      —
                    </Text>
                  )
                }
                height={SETTING_ROW}
              />
              <Row
                title="Allowlist"
                value={
                  <Text variant="rowPrimary" color={colors.ink55}>
                    {/* The executor holds the list: a count it has not given is not zero addresses. */}
                    {allowlistError
                      ? '—'
                      : allowlistLoading
                        ? '· · ·'
                        : addresses.length === 1
                          ? '1 address'
                          : `${addresses.length} addresses`}
                  </Text>
                }
                height={SETTING_ROW}
                onPress={() => router.push('/allowlist')}
              />

              <Eyebrow small style={{ marginTop: space.s26 }}>
                Voice
              </Eyebrow>
              <SheetCard
                borderRadius={radius.panel}
                padding={space.s16}
                style={{ marginTop: space.s10 }}
              >
                <Segmented
                  options={TONE_OPTIONS}
                  value={tone}
                  onChange={setTone}
                  height={size.segThumbSm}
                />
                <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s12 }}>
                  {/* With no language model nothing speaks in any tone: the choice is kept for when one exists, and says so. */}
                  {voiceConfigured === false
                    ? 'Used once this build has a language model.'
                    : TONES.find((t) => t.id === tone)?.description}
                </Text>
              </SheetCard>
            </>
          )}

          <Eyebrow small style={{ marginTop: space.s26 }}>
            Notifications
          </Eyebrow>
          {/* Named for where it goes. It read "Notifications" and opened Alerts. */}
          <Row
            title="Alerts"
            value={<Text variant="rowPrimary" color={colors.ink55}>Manage</Text>}
            height={SETTING_ROW}
            onPress={() => router.push('/alerts')}
          />

          <Eyebrow small style={{ marginTop: space.s26 }}>
            Legal
          </Eyebrow>
          <Row title="Terms" height={SETTING_ROW} onPress={() => router.push('/legal/terms')} />
          <Row
            title="Privacy policy"
            height={SETTING_ROW}
            onPress={() => router.push('/legal/privacy')}
          />
          <Row
            title="Risk disclosure"
            height={SETTING_ROW}
            divider={false}
            onPress={() => router.push('/legal/risk')}
          />

          <Eyebrow small style={{ marginTop: space.s26 }}>
            Session
          </Eyebrow>
          {signedOut ? (
            <Row title="Sign in" height={SETTING_ROW} divider={false} onPress={signIn} />
          ) : (
            <Row
              title={
                confirmingSignOut ? (
                  <Text variant="rowPrimary" color={colors.down}>
                    Tap again to sign out
                  </Text>
                ) : (
                  'Sign out'
                )
              }
              secondary={
                confirmingSignOut
                  ? 'You’ll need an email code to sign back in.'
                  : 'Your permission stays on. Stop it in Safety.'
              }
              height={SETTING_ROW}
              divider={false}
              onPress={() => void signOut()}
            />
          )}
          {signOutError ? (
            <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s10 }}>
              {signOutError}
            </Text>
          ) : null}

          {/* Which code this is, and whether the server runs the same (FEATURES.md #53, `src/about/VersionRow.tsx`). */}
          <Eyebrow small style={{ marginTop: space.s26 }}>
            About
          </Eyebrow>
          <VersionRow height={SETTING_ROW} />
          <View style={{ height: space.s30 }} />
        </ScrollView>
      </Fill>
    </Screen>
  );
}
