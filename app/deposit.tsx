/**
 * Deposit — money in (PLAN.md 4.5), distilled 2026-09-14.
 *
 * The address, with a code where a code is true; the balance, read from the chain every few seconds so a deposit is
 * seen landing; and test funds where this network has them. The network is named here, in a chip, because this is
 * where money moves. A fork build shows no code: a fork shares Base's chain id, so a phone wallet would open on real Base.
 *
 * Money landing is a moment (FEATURES.md #21): the balance it lands in rolls to its new figure, with one success tap.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  ErrorState,
  Eyebrow,
  Fill,
  HeaderBar,
  LoadingRows,
  Placeholder,
  Price,
  Row,
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
import { RollingNumber } from '@/ui/RollingNumber';
import { successTap } from '@/ui/haptics';
import { useAuth } from '@/auth/useAuth';
import { shortAddress } from '@/format';
import { activeChain, chainLabel, depositQrNote, depositQrWorks } from '@/chain';
import { NetworkChip } from '@/networks/NetworkChip';
import { useStore } from '@/state/store';
import { useNow } from '@/state/useNow';
import { ETH_DIGITS, NO_ARRIVALS, USDC_DIGITS, noteFunds } from '@/state/moneyIn';
import { useAsync } from '@/data/useAsync';
import { usePoll } from '@/data/usePoll';
import type { PollState } from '@/data/pollState';
import { errorText } from '@/data/apiError';
import { faucetStatus, requestFaucet, walletFunds, type FaucetOutcome, type WalletFunds } from '@/data/deposit';
import { useIntentKeys } from '@/data/useIntentKeys';

import { openMoonPayBuy } from '@/deposit/moonpay';

/** Often enough to see a deposit land while you wait for it. Each read is two balance calls against the executor's node. */
const POLL_MS = 5_000;
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
  const funds = usePoll(walletFunds, POLL_MS);
  const faucet = useAsync(() => faucetStatus(), []);
  const now = useNow();
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const [openingMoonPay, setOpeningMoonPay] = useState(false);
  const [moonPayError, setMoonPayError] = useState<string>();
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
      // The balances changed on chain; read them now rather than at the next tick.
      if (result.status === 'sent') void funds.refresh();
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

          <Funds funds={funds} address={address} />

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

/**
 * What the wallet holds, as the chain last said.
 *
 * A placeholder before the first answer; a first read that fails, the failure. After that the last answer stays through
 * a failed read, with when it was read. A balance that could not be read is never shown as a number.
 *
 * Each answer is set beside the one before it (`src/state/moneyIn.ts`). A balance that rose rolls in at its new figure
 * and the phone taps once — for that arrival, and never for the first answer, which is what the wallet held when the
 * screen opened.
 */
function Funds({
  funds,
  address,
}: {
  funds: PollState<WalletFunds> & { refresh: () => Promise<void> };
  address: string | undefined;
}) {
  const { data, dataAt, error } = funds;
  // The balances are of the wallet the executor has on file. If that is not this address, say so.
  const elsewhere = data !== undefined && address !== undefined && data.owner.toLowerCase() !== address.toLowerCase();

  /*
   * Noted while rendering, the way React has state follow a prop, so a figure and the arrivals it rolls for always come
   * from the same answer. Noted in an effect, one render would draw the new balance before its arrival was counted, and
   * the roll would start on a figure that had already changed in place.
   */
  const [arrivals, setArrivals] = useState(NO_ARRIVALS);
  if (data !== undefined && data !== arrivals.last) setArrivals(noteFunds(arrivals, data));

  // One tap for each arrival. A render that repeats the count taps for nothing.
  const tapped = useRef(0);
  useEffect(() => {
    if (arrivals.count <= tapped.current) return;
    tapped.current = arrivals.count;
    successTap();
  }, [arrivals.count]);

  return (
    <View>
      <Eyebrow small>Balance</Eyebrow>
      {data ? (
        <View style={{ marginTop: space.s6 }}>
          <Row
            title="USDC"
            value={<Holding figure={quantity(data.usdc.amount, USDC_DIGITS)} arrivals={arrivals.usdc} />}
            height={size.rowSm}
          />
          <Row
            title={data.sol ? 'SOL' : 'ETH'}
            value={
              <Holding
                figure={quantity(data.sol ? data.sol.amount : data.eth.amount, data.sol ? 4 : ETH_DIGITS)}
                arrivals={arrivals.eth}
              />
            }
            height={size.rowSm}
            divider={false}
          />
          {error ? (
            <Text variant="footnote" color={colors.down} style={{ marginTop: space.s8 }}>
              {`Couldn’t refresh · last read ${clock(dataAt)}`}
            </Text>
          ) : null}
          {elsewhere ? (
            <Text variant="footnote" color={colors.down} style={{ marginTop: space.s6 }}>
              {`Showing ${shortAddress(data.owner)}, not this address.`}
            </Text>
          ) : null}
        </View>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void funds.refresh()} />
      ) : (
        <LoadingRows count={2} height={size.rowSm} />
      )}
    </View>
  );
}

/**
 * One balance's figure: still until money lands in it, then rolled in at its true value, once for each arrival — each
 * is a new `key`, and `RollingNumber` rolls a figure as it mounts. Reduced motion lands it without the roll. USDC and
 * ETH are money written in their units, without a dollar sign, so the figure says so and hides while balances are hidden.
 */
function Holding({ figure, arrivals }: { figure: string; arrivals: number }) {
  if (arrivals === 0) return <Price figure="units">{figure}</Price>;
  return <RollingNumber key={arrivals} value={figure} figure="units" />;
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

/** A time to the minute. Seconds on "last read 2:07:08 AM" were precision nobody reads. */
const clock = (at: number | undefined) =>
  at === undefined ? 'unknown' : new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
