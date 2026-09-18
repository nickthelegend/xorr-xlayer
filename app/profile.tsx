/**
 * Profile — who you are, and where everything else lives (2026-09-13).
 *
 * Opened from the wallet header on Home, as a sheet. It used to be a dashboard — three counts, the full
 * address in a card, the last five audit events and two more buttons — and the product owner found it
 * too much. It is now the identity, the address one tap from the clipboard, and four rows to the
 * screens that carry the detail: Activity, Permissions, Approvals and Settings.
 *
 * The identity still comes from two places, each the authority on its half: Privy for the email the
 * account was made with, the executor for the wallet the app is using. There is no name service on X Layer
 * that this reads, so an address is shown as an address. It is shortened on screen and copied whole.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  ErrorState,
  Placeholder,
  Press,
  Row,
  Screen,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { Icon, type IconName } from '@/design/Icon';
import { Rise } from '@/ui/Rise';
import { usePrivyIdentity } from '@/auth/usePrivyIdentity';
import { useAsync } from '@/data/useAsync';
import { repos } from '@/data';
import { errorText } from '@/data/apiError';
import { useStore } from '@/state/store';
import {
  SWITCH_CONSEQUENCE,
  kindLabel,
  shortAddress,
  switchedNote,
  walletSubtitle,
  worthSwitching,
} from '@/accounts/switcher';
import type { AccountWallet } from '@/data/repositories';

const AVATAR = 84;
const LINK_GLYPH = 18;

/** Where the detail went. Each row is a screen that already exists. */
const LINKS: readonly { label: string; icon: IconName; href: string }[] = [
  { label: 'Activity', icon: 'activity', href: '/activity' },
  { label: 'Permissions', icon: 'shield', href: '/delegation' },
  { label: 'Approvals', icon: 'check', href: '/approvals' },
  { label: 'Settings', icon: 'gear', href: '/settings' },
];

export default function Profile() {
  const goBack = useGoBack();
  const router = useRouter();
  const { email } = usePrivyIdentity();
  const wallet = useAsync(() => repos.wallet.current(), []);
  const address = wallet.data?.address;
  const [copied, setCopied] = useState(false);

  /*
   * Every address on this account, not just the one in use.
   *
   * Web Privy lists any injected browser extension alongside the embedded wallet, so an account
   * that once connected through an extension has two rows — and everything here is scoped by
   * wallet, so the other one has its own permission, balance, strategies and trail that nothing in
   * the app could reach.
   */
  const accounts = useAsync(() => repos.wallet.all(), []);

  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : undefined;
  const display = email ?? short;
  const initial = (display ?? 'x').replace(/^0x/i, '').charAt(0).toUpperCase();

  async function copy() {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setCopied(true);
  }

  return (
    <Screen gutter="none" sheet>
      <View style={{ flexDirection: 'row', paddingHorizontal: space.gutter }}>
        <BackButton onPress={goBack} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.s30 }}>
        <Rise index={0} style={{ alignItems: 'center', marginTop: space.s6, paddingHorizontal: space.gutter }}>
          {wallet.error ? (
            <ErrorState error={wallet.error} onRetry={wallet.reload} />
          ) : (
            <>
              <View
                style={{
                  width: AVATAR,
                  height: AVATAR,
                  borderRadius: AVATAR / 2,
                  backgroundColor: colors.ink,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {display ? (
                  <Text variant="screenTitle" color={colors.sheet.ink}>
                    {initial}
                  </Text>
                ) : null}
              </View>

              {display ? (
                <Text variant="screenTitle" align="center" numberOfLines={1} style={{ marginTop: space.s16 }}>
                  {display}
                </Text>
              ) : wallet.loading ? (
                <Placeholder width={180} height={26} style={{ marginTop: space.s16 }} />
              ) : (
                /*
                  Nothing to call this account by: the executor has no wallet on file and Privy gave no email. This
                  was a placeholder that never stopped pulsing, which reads as a name still on its way.
                */
                <Text variant="screenTitle" align="center" color={colors.ink55} style={{ marginTop: space.s16 }}>
                  No wallet yet
                </Text>
              )}

              {address && short ? (
                <Press
                  onPress={() => void copy()}
                  accessibilityRole="button"
                  accessibilityLabel={copied ? 'Address copied' : `Copy address ${address}`}
                  hitHeight={size.hit}
                  style={{
                    marginTop: space.s12,
                    height: size.pillH,
                    paddingHorizontal: size.pillPadX,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.s8,
                    borderRadius: radius.full,
                    backgroundColor: colors.control,
                  }}
                >
                  <Text variant="secondarySm" color={colors.ink65}>
                    {copied ? 'Copied' : short}
                  </Text>
                  <Icon name={copied ? 'check' : 'copy'} size={15} color={colors.ink55} />
                </Press>
              ) : wallet.loading ? (
                <Placeholder width={150} height={size.pillH} style={{ marginTop: space.s12, borderRadius: radius.full }} />
              ) : null}
            </>
          )}
        </Rise>

        {worthSwitching(accounts.data ?? []) ? (
          <Rise index={1}>
            <AccountSwitcher
              wallets={accounts.data!}
              onSwitched={() => {
                accounts.reload();
                wallet.reload();
              }}
            />
          </Rise>
        ) : null}

        <Rise
          index={2}
          style={{
            marginTop: space.s26,
            marginHorizontal: space.gutter,
            paddingHorizontal: space.s16,
            borderRadius: radius.panel,
            backgroundColor: colors.surfaceAlt,
          }}
        >
          {LINKS.map((link, i) => (
            <Row
              key={link.href}
              divider={i < LINKS.length - 1}
              onPress={() => router.push(link.href as never)}
              left={
                <View
                  style={{
                    width: size.mark,
                    height: size.mark,
                    borderRadius: radius.full,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: colors.control,
                  }}
                >
                  <Icon name={link.icon} size={LINK_GLYPH} color={colors.ink65} />
                </View>
              }
              title={link.label}
              right={<Icon name="chevron" size={16} color={colors.ink28} />}
            />
          ))}
        </Rise>

        {wallet.data ? (
          <Rise index={3}>
            <Text variant="footnote" color={colors.ink55} align="center" style={{ marginTop: space.s18 }}>
              {/* The kind of wallet in plain words: no vendor and no network on a main sheet (PLAN.md O3). */}
              {kindLabel(wallet.data.kind === 'connected' ? 'connected' : 'embedded')}
            </Text>
          </Rise>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/**
 * The addresses on this account, and which one everything resolves to.
 *
 * Switching is `POST /wallet/connect` — the call that already exists and already asks Privy whether
 * the address really belongs to the caller. A second endpoint that set the active flag directly
 * would be a second door into the same room, and the second door is the one nobody remembers to lock.
 *
 * The consequence is stated above the rows rather than under them: someone about to change which
 * permission and which history they are looking at should read that before the tap, not after.
 */
function AccountSwitcher({
  wallets,
  onSwitched,
}: {
  wallets: readonly AccountWallet[];
  onSwitched: () => void;
}) {
  const switchAccount = useStore((s) => s.switchAccount);
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();
  const [failed, setFailed] = useState(false);

  async function switchTo(w: AccountWallet) {
    if (w.active || busy) return;
    setBusy(w.id);
    setNote(undefined);
    setFailed(false);
    try {
      const next = await repos.wallet.connect(w.address);
      /*
       * The store too, and everything account-scoped in it.
       *
       * `setWallet` alone left the previous account's permission, stop switch, caps and approvals
       * in place — so Safety would render account A's live grant while every executor call now
       * resolved to account B. `switchAccount` drops all of it and each is read again for the
       * account now in use; `accounts/delegationScope.ts` keeps "not read yet" distinct from "this
       * account granted nothing" so nothing renders a claim in the gap.
       */
      switchAccount(next);
      setNote(switchedNote(w));
      onSwitched();
    } catch (e) {
      // The executor refuses an address Privy does not list on this account, and says so. That
      // sentence is more useful than anything this screen could invent.
      setFailed(true);
      setNote(errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <View style={{ marginTop: space.s26, marginHorizontal: space.gutter }}>
      <Text variant="secondarySm" color={colors.ink55}>
        {SWITCH_CONSEQUENCE}
      </Text>
      <View
        style={{
          marginTop: space.s12,
          paddingHorizontal: space.s16,
          borderRadius: radius.panel,
          backgroundColor: colors.surfaceAlt,
        }}
      >
        {wallets.map((w, i) => (
          <Row
            key={w.id}
            divider={i < wallets.length - 1}
            onPress={w.active ? undefined : () => void switchTo(w)}
            // An address is not money and is not masked: hiding it would make the switcher unusable
            // in exactly the state — balances hidden — where someone most wants to check which one
            // they are on.
            title={shortAddress(w.address)}
            secondary={busy === w.id ? 'Switching…' : walletSubtitle(w)}
            right={
              w.active ? (
                <Icon name="check" size={16} color={colors.ink65} />
              ) : (
                <Icon name="chevron" size={16} color={colors.ink28} />
              )
            }
          />
        ))}
      </View>
      {note ? (
        <Text
          variant="footnote"
          color={failed ? colors.down : colors.ink55}
          style={{ marginTop: space.s10 }}
          accessibilityLiveRegion="polite"
        >
          {note}
        </Text>
      ) : null}
    </View>
  );
}
