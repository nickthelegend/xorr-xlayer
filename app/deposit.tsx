/**
 * Deposit — money in (PLAN.md 4.5; X Layer: P4.7, P4.12, owner decisions D8 and D16).
 *
 * The address, with a code where a code is true, and plainly what may be sent to it: USDC or USDT0 on X Layer. Where
 * money is real, a link out to OKX to buy there and withdraw here. The balances, read from the chain every few seconds so
 * a deposit is seen landing, with USDT0 convertible to USDC by the person's own signature (`src/deposit/`). Test funds
 * where this network has them. The network is named here, in a chip, because this is where money moves. A fork build
 * shows no code: a fork shares X Layer's chain id, so a phone wallet would open on real X Layer.
 *
 * No card on-ramp inside the app (D8): the purchase happens on OKX's own pages.
 */
import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  ErrorState,
  Fill,
  HeaderBar,
  Placeholder,
  Screen,
  SheetCard,
  Text,
  colors,
  quantity,
  radius,
  size,
  space,
  SignInPrompt,
} from '@/ui';
import { AddressQR } from '@/ui/AddressQR';
import { useAuth } from '@/auth/useAuth';
import { CHAIN_KEY, activeChain, chainLabel, chainMoney, depositQrNote, depositQrWorks } from '@/chain';
import { NetworkChip } from '@/networks/NetworkChip';
import { useStore } from '@/state/store';
import { useNow } from '@/state/useNow';
import { useAsync } from '@/data/useAsync';
import { errorText } from '@/data/apiError';
import { faucetStatus, requestFaucet, type FaucetOutcome } from '@/data/deposit';
import { useIntentKeys } from '@/data/useIntentKeys';
import { DepositFunds } from '@/deposit/DepositFunds';
import { OkxLink } from '@/deposit/OkxLink';
import { acceptedTokens } from '@/deposit/stablecoins';

const QR_SIZE = 168;
/** The longest delay a timer takes on every platform: 2³¹ − 1 ms, a little under 25 days. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * When the faucet opens again, in a person's words: "in 22 h", "in 5 min", or a day and a time once it is more than a
 * day off. It printed `toLocaleString()` — "9/15/2026, 2:07:08 AM", seconds and all. Rounded up, so it never says
 * sooner than the executor will allow.
 */
function againIn(at: number, now: number): string {
  const ms = at - now;
  if (ms < 60_000) return 'in under a minute';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export default function Deposit() {
  const goBack = useGoBack();
  const auth = useAuth();
  const signedOut = auth.ready && !auth.authenticated;
  // The store's wallet is set by onboarding. A session that never ran it still has Privy's embedded wallet.
  const address = useStore((s) => s.wallet)?.address ?? auth.address;
  const faucet = useAsync(() => faucetStatus(), []);
  const now = useNow();
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const [outcome, setOutcome] = useState<FaucetOutcome>();

  /*
   * Ask again when the window opens, so a disabled button does not go on saying "in under a minute" about a wallet the
   * executor would already serve. The moment is the executor's; this device's clock only runs the timer.
   */
  const nextAt = faucet.data?.wallet?.nextAt ?? undefined;
  const reloadFaucet = faucet.reload;
  useEffect(() => {
    if (nextAt === undefined) return;
    const timer = setTimeout(reloadFaucet, Math.min(Math.max(nextAt - Date.now(), 0) + 1_000, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [nextAt, reloadFaucet]);

  async function copy() {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setCopied(true);
  }

  /*
   * The claim's Idempotency-Key (FEATURES.md #29). A claim that timed out may have been sent; the button tapped again
   * carries the same key, so the executor answers with what that claim did instead of sending again.
   */
  const keys = useIntentKeys();

  async function ask() {
    if (asking) return;
    setAsking(true);
    try {
      const result = await keys.send('faucet', (idempotencyKey) => requestFaucet({ idempotencyKey }));
      setOutcome(result);
    } catch (e) {
      setOutcome({ status: 'failed', error: errorText(e) });
    } finally {
      setAsking(false);
      // Whether this wallet may ask again changed with the answer, whatever it was: read it rather than guess it.
      faucet.reload();
    }
  }

  const status = faucet.data;

  const header = (
    <View style={{ paddingHorizontal: space.gutter }}>
      <HeaderBar
        onBack={goBack}
        title={<Text variant="screenTitle">Deposit</Text>}
        right={<NetworkChip />}
      />
    </View>
  );

  // Signed out there is no address to show, so no balance or test funds to read for it: one way in.
  if (signedOut) {
    return (
      <Screen gutter="none">
        {header}
        <View style={{ paddingHorizontal: space.gutter }}>
          <SignInPrompt text="Sign in to see your address." />
        </View>
      </Screen>
    );
  }

  return (
    <Screen gutter="none">
      {header}

      <Fill style={{ marginTop: space.s16 }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.s30, gap: space.s22 }}
        >
          <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
            {address && depositQrWorks ? (
              <View style={{ alignItems: 'center', paddingBottom: space.s12 }}>
                <AddressQR value={`ethereum:${address}@${activeChain.id}`} size={QR_SIZE} />
              </View>
            ) : null}
            {/* In full and selectable rather than shortened: it is going to be pasted somewhere. */}
            <Text variant="body" selectable>
              {address ?? 'Setting up your wallet…'}
            </Text>
            {address ? (
              <View style={{ marginTop: space.s12, gap: space.s10 }}>
                <Button
                  label={copied ? 'Copied' : 'Copy address'}
                  variant="ghost"
                  onPress={copy}
                />
              </View>
            ) : null}
            <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
              {depositQrWorks ? `Send only ${acceptedTokens(CHAIN_KEY)} on ${chainLabel}. Other tokens or networks will be lost.` : depositQrNote}
            </Text>
          </SheetCard>

          {/* Real money only: on a test network or a fork, OKX would send to a chain this build does not read. */}
          {chainMoney === 'real' && address ? <OkxLink /> : null}

          <DepositFunds address={address} />

          {/* Test funds only where this network has them; elsewhere the section is simply not there. */}
          {faucet.error && !status ? (
            <ErrorState error={faucet.error} onRetry={faucet.reload} />
          ) : !status ? (
            <Placeholder height={size.button} style={{ borderRadius: radius.card }} />
          ) : status.available && status.usdc !== null ? (
            <View>
              <Button
                label={`Get ${quantity(status.usdc, 0)} test USDC`}
                variant="secondary"
                loading={asking}
                disabled={!status.wallet?.canAsk}
                onPress={ask}
              />
              {/* A disabled button always says why: no wallet on file yet, or asked within the window. */}
              {status.wallet === null ? (
                <Text variant="footnote" color={colors.ink55} align="center" style={{ marginTop: space.s8 }}>
                  Set up your wallet first.
                </Text>
              ) : status.wallet?.nextAt ? (
                <Text variant="footnote" color={colors.ink55} align="center" style={{ marginTop: space.s8 }}>
                  {`Available again ${againIn(status.wallet.nextAt, now)}`}
                </Text>
              ) : null}
              <Outcome outcome={outcome} />
            </View>
          ) : null}
        </ScrollView>
      </Fill>
    </Screen>
  );
}

/** What asking for test funds did: what arrived, or the executor's reason nothing was sent. */
function Outcome({ outcome }: { outcome: FaucetOutcome | undefined }) {
  if (!outcome) return null;
  if (outcome.status !== 'sent') {
    return (
      <Text variant="footnote" color={colors.down} align="center" numberOfLines={2} style={{ marginTop: space.s10 }}>
        {outcome.status === 'blocked' ? outcome.detail : outcome.error}
      </Text>
    );
  }
  // Gas that could not be topped up is the one detail that changes what the wallet can do next.
  const gasFailed = outcome.eth !== null && 'failed' in outcome.eth;
  return (
    <Text
      variant="footnote"
      color={gasFailed ? colors.down : colors.ink}
      align="center"
      style={{ marginTop: space.s10 }}
      figure="units"
    >
      {`Added ${quantity(outcome.usdc.amount, 2)} USDC.${gasFailed ? ' Gas top-up failed.' : ''}`}
    </Text>
  );
}
