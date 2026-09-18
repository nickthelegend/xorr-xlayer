/**
 * Fund the wallet — PLAN.md 7.4, the last onboarding step. Made honest 2026-09-14.
 *
 * A non-custodial wallet has one way in: tokens sent to its address. This screen dressed that up as
 * the handoff's screen 9 — a $500 hero amount, four presets, two payment methods, a fee and an
 * arrival date — and none of it was real. The presets and the method set local values that nothing
 * read, so "$500" belonged to no deposit; "Free" priced an exchange withdrawal nobody here controls;
 * and "Available Tue, Sep 15" was an invented next business day.
 *
 * What is left is what is true, the way Deposit has it: the address in full, the network named in a
 * chip (money moves here), a code where a code is true, and test funds where this network has them.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { activeChain, chainLabel, depositQrNote, depositQrWorks } from '@/chain';
import { NetworkChip } from '@/networks/NetworkChip';
import { AddressQR } from '@/ui/AddressQR';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  ErrorState,
  Eyebrow,
  Fill,
  Placeholder,
  Progress,
  Screen,
  SheetCard,
  SignInPrompt,
  Text,
  colors,
  quantity,
  radius,
  size,
  space,
} from '@/ui';
import { useAuth } from '@/auth/useAuth';
import { useSignedOut } from '@/auth/useSignedOut';
import { useStore } from '@/state/store';
import { useNow } from '@/state/useNow';
import { useAsync } from '@/data/useAsync';
import { useIntentKeys } from '@/data/useIntentKeys';
import { errorText } from '@/data/apiError';
import { faucetStatus, requestFaucet, type FaucetOutcome } from '@/data/deposit';

import { openMoonPayBuy } from '@/deposit/moonpay';

const QR_SIZE = 168;

/**
 * When the faucet opens again, in a person's words: "in 22 h", "in 5 min", or a day and a time once
 * it is more than a day off. Rounded up, so it never says sooner than the executor will allow.
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

export default function Fund() {
  const router = useRouter();
  const goBack = useGoBack();
  const auth = useAuth();
  const signedOut = useSignedOut();
  // Registered on the step before this one; a session that skipped it still has Privy's own address.
  const address = useStore((s) => s.wallet)?.address ?? auth.address;
  const faucet = useAsync(() => faucetStatus(), []);
  const now = useNow();
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const [openingMoonPay, setOpeningMoonPay] = useState(false);
  const [moonPayError, setMoonPayError] = useState<string>();
  const [outcome, setOutcome] = useState<FaucetOutcome>();
  // One key per claim, kept through a timeout, as Deposit's claim does: a retry asks after the first, never sends twice.
  const keys = useIntentKeys();

  async function copy() {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setCopied(true);
  }

  async function buyWithMoonPay() {
    if (!address || openingMoonPay) return;
    setOpeningMoonPay(true);
    setMoonPayError(undefined);
    try {
      await openMoonPayBuy({ walletAddress: address });
    } catch (e) {
      setMoonPayError(errorText(e));
    } finally {
      setOpeningMoonPay(false);
    }
  }

  async function ask() {
    if (asking) return;
    setAsking(true);
    try {
      setOutcome(await keys.send('faucet', (idempotencyKey) => requestFaucet({ idempotencyKey })));
    } catch (e) {
      setOutcome({ status: 'failed', error: errorText(e) });
    } finally {
      setAsking(false);
      // Whether this wallet may ask again changed with the answer, whatever it was: read it rather than guess it.
      faucet.reload();
    }
  }

  const status = faucet.data;

  return (
    <Screen>
      <Progress step={3} total={3} onBack={() => goBack()} />

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: space.s12,
          marginTop: space.s26,
        }}
      >
        <Text variant="onboardingTitle" style={{ flexShrink: 1 }}>
          Fund the wallet
        </Text>
        {/* The network, named where money moves, and the way to every network xorr runs on. */}
        <NetworkChip />
      </View>
      <Text variant="body" color={colors.ink55} style={{ marginTop: space.s10 }}>
        Send USDC to your address.
      </Text>

      {/*
        Scrolls. The code made this screen taller than a short phone.

        Measured at 375×667: 368pt of overflow with three elements unreachable, including the
        address itself — on the screen whose entire job is handing someone an address. The code is
        worth the height; the height has to be reachable.
      */}
      <Fill style={{ marginTop: space.s20 }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: space.s16, gap: space.s18 }}
        >
          {signedOut ? (
            <SignInPrompt text="Sign in to see your address." />
          ) : (
            <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
              <Eyebrow small>Send USDC to</Eyebrow>
              {/*
                A code, because the sending wallet is on the other device.

                The person doing the sending is almost always looking at a different phone or an
                exchange in a browser. Retyping 42 hex characters between two screens is the step
                where funding actually fails, and a mistyped address is money that is simply gone.

                EIP-681 rather than the bare address: a wallet that understands the URI opens
                pre-filled on the right chain, and one that does not still reads the address out of
                it. Only rendered once there IS an address — a QR of the empty string is a code that
                scans to nothing.

                And only where the chain id is this chain's (PLAN.md 4.5). A fork build encoded 8453,
                which is real Base: scanned, it pointed a phone wallet at real money. `depositQrWorks`
                says where a code is true, and a fork build says why it has none.
              */}
              {address && depositQrWorks ? (
                <View style={{ alignItems: 'center', paddingVertical: space.s12 }}>
                  <AddressQR value={`ethereum:${address}@${activeChain.id}`} size={QR_SIZE} />
                </View>
              ) : null}
              {/* In full and selectable rather than shortened: it is going to be pasted somewhere. */}
              <Text variant="body" selectable style={{ marginTop: space.s6 }}>
                {address ?? 'Setting up your wallet…'}
              </Text>
              {address ? (
                <View style={{ marginTop: space.s12, gap: space.s10 }}>
                  <Button
                    label="Buy with Card · MoonPay Sandbox"
                    variant="secondary"
                    loading={openingMoonPay}
                    onPress={buyWithMoonPay}
                  />
                  {moonPayError ? (
                    <Text variant="footnote" color={colors.down} align="center">
                      {moonPayError}
                    </Text>
                  ) : null}
                  <Button
                    label={copied ? 'Copied' : 'Copy address'}
                    variant="ghost"
                    onPress={copy}
                  />
                </View>
              ) : null}
              <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
                {depositQrWorks ? `Send only USDC on ${chainLabel}.` : depositQrNote}
              </Text>
            </SheetCard>
          )}

          {/* Test funds only where this network has them; elsewhere the section is simply not there. */}
          {signedOut ? null : faucet.error && !status ? (
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

      <Button label="Continue — set the limits" onPress={() => router.push('/delegate')} />
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
  // What arrived is the person's money, in its units: it hides while balances are hidden (FEATURES.md #47).
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
