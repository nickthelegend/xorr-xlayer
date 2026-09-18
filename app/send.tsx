/**
 * Send / withdraw — PLAN.md 10.6 [G14].
 *
 * PLAN.md §3.4: withdrawals may go ONLY to a user-allowlisted destination. This screen cannot
 * enter a free-form address on purpose — that constraint is the product, not a limitation.
 *
 * It used to say withdrawals were "not enabled in this build", for two reasons, one of which was
 * wrong: that the executor has no transfer-out path (true, and deliberate — an executor that can
 * move funds out is a custodian) and that "the wallet is a devnet wallet whose key the executor
 * holds" (false since the Privy pivot, and the opposite of the product's central claim).
 *
 * The withdrawal was never the executor's to make. The owner signs it with their own embedded
 * wallet, the same way they sign the grant. Since PLAN.md 4.9 the list is the executor's: only the
 * addresses its clock says are usable can be chosen here, a pending one says when it will be, and
 * `useWithdraw` asks the executor again immediately before a signature is requested.
 */
import React, { useMemo, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  Button,
  Eyebrow,
  Fill,
  NoteStrip,
  Pill,
  Press,
  Price,
  RadioCard,
  Screen,
  Text,
  border,
  colors,
  money,
  quantity,
  radius,
  space,
  typeScale,
  SignInPrompt,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { useAllowlist, usableFromText, usableIn } from '@/wallet/allowlist';
import { useWithdraw } from '@/wallet/useWithdraw';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { useDebounced } from '@/data/useDebounced';
import { usePrice } from '@/data/usePrices';
import { system } from '@/data/system';
import { swapSpendable } from '@/state/derived';
import { transferCall } from '@/wallet/transfer';
import { useGrantDelegation } from '@/auth/useGrantDelegation';
import { formatEther, type Address } from 'viem';
import { shortAddress } from '@/format';
import { NetworkChip } from '@/networks/NetworkChip';

const FIELD_H = 52;

export default function Send() {
  const router = useRouter();
  const goBack = useGoBack();
  const {
    addresses,
    usable,
    pending,
    serverTime,
    loading: listLoading,
    error: listError,
  } = useAllowlist();
  const [chosen, setChosen] = useState<string>();
  const [amount, setAmount] = useState('');
  const { withdraw, busy, error, txHash } = useWithdraw();

  const balance = useAsync(() => repos.portfolio.balance(), []);
  /*
   * What can be sent (PLAN.md 3.11): the tokens this chain knows, at this chain's own addresses and decimals — asked,
   * never assumed. Send moved only USDC, with six decimals written into the hook. Native ETH is left out: this sends
   * ERC-20 transfers.
   */
  const listed = useAsync(() => system.watchable(), []);
  const [symbol, setSymbol] = useState('USDC');
  const sendable = (listed.data ?? []).filter((t) => t.symbol !== 'ETH');
  const token = sendable.find((t) => t.symbol === symbol);

  // Cash for USDC and the chain's holding for anything else; undefined while it is unknown, never a zero.
  const held = swapSpendable(balance.data, symbol);
  /*
   * Only a usable address can be the destination. Chosen by address, not by position, so a list read
   * again — an address that became usable, or one removed elsewhere — cannot move the selection onto
   * a different card.
   */
  const entry = usable.find((a) => a.address === chosen) ?? usable[0];
  const typed = Number(amount);
  const overBalance = held !== undefined && typed > held;

  const problem = useMemo(() => {
    if (listLoading) return undefined;
    // A list that could not be read says so once, where the list goes. Saying it here as well printed it twice.
    if (listError && addresses.length === 0) return undefined;
    if (addresses.length === 0) return 'Add an address first.';
    if (usable.length === 0) return 'No address is unlocked yet.';
    if (!entry) return 'Choose a destination.';
    if (!amount) return undefined;
    // A token list that could not be read says so once, where the pills go; one that did has pills to choose from.
    if (listed.data && !listed.data.some((t) => t.symbol === symbol && t.symbol !== 'ETH')) return 'Choose a token.';
    if (!(typed > 0)) return 'Enter an amount above zero.';
    if (overBalance) return 'More than you hold.';
    return undefined;
  }, [listLoading, listError, addresses.length, usable.length, entry, amount, listed.data, symbol, typed, overBalance]);

  /*
   * What the send costs you in gas (PLAN.md 3.13), asked of your own wallet, which pays it — nothing here goes
   * through the executor. Estimated for the transfer as built, once typing settles.
   */
  const { estimateFee } = useGrantDelegation();
  const settledAmount = useDebounced(amount);
  const feeFor =
    token && entry && Number(settledAmount) > 0
      ? `${token.address}:${entry.address}:${settledAmount}`
      : '';
  const fee = useAsync(async () => {
    if (!feeFor || !token || !entry) return undefined;
    let call: ReturnType<typeof transferCall>;
    try {
      call = transferCall(token, entry.address as Address, settledAmount);
    } catch {
      return undefined;
    }
    return estimateFee(call.to, call.data);
  }, [feeFor]);
  const { quote: ethPrice } = usePrice('WETH');
  const feeUsd =
    fee.data && ethPrice?.price !== undefined
      ? Number(formatEther(fee.data.gas * fee.data.gasPrice)) * ethPrice.price
      : undefined;

  const ready = Boolean(entry) && typed > 0 && !overBalance && Boolean(token);
  const signedOut = useSignedOut();

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
      <BackButton onPress={() => goBack()} />
      <Text variant="screenTitle" style={{ flex: 1 }}>
        Send
      </Text>
      <NetworkChip />
    </View>
  );

  // Signed out there is no allowlist, balance or wallet to send from: one way in, not three dashes and an error.
  if (signedOut) {
    return (
      <Screen>
        {header}
        <SignInPrompt text="Sign in to send." />
      </Screen>
    );
  }

  return (
    <Screen>
      {header}

      <Fill style={{ marginTop: space.s22 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Eyebrow small>To</Eyebrow>
          <Press onPress={() => router.push('/allowlist')} accessibilityRole="button" accessibilityLabel="Manage your allowlist">
            <Text variant="footnote" color={colors.ink55}>
              Manage
            </Text>
          </Press>
        </View>
        <View style={{ gap: space.s10, marginTop: space.s12 }}>
          {listLoading ? (
            <Text variant="secondary" color={colors.ink55}>
              Loading…
            </Text>
          ) : listError && addresses.length === 0 ? (
            // A list that could not be read is not an empty list, and must not look like one.
            <Text variant="secondary" color={colors.down}>
              Couldn’t load your allowlist.
            </Text>
          ) : addresses.length === 0 ? (
            <Text variant="secondary" color={colors.ink55}>
              No addresses yet.
            </Text>
          ) : (
            <>
              {usable.map((a) => (
                <RadioCard
                  key={a.address}
                  title={a.label}
                  detail={a.address}
                  selected={a.address === entry?.address}
                  onPress={() => setChosen(a.address)}
                  showRadio={false}
                />
              ))}
              {/* Pending addresses are shown, and cannot be chosen: when each becomes usable is the executor's answer. */}
              {pending.map((a) => (
                <Text key={a.address} variant="secondarySm" color={colors.ink55}>
                  {a.label} · {shortAddress(a.address)} — usable from {usableFromText(a)}
                  {serverTime !== undefined ? `, ${usableIn(a, serverTime)}` : ''}
                </Text>
              ))}
            </>
          )}
        </View>

        <View style={{ marginTop: space.s22 }}>
          <Eyebrow small>Token</Eyebrow>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s8, marginTop: space.s10 }}>
            {/*
              No pills is not a list of nothing. A token list that failed left this row empty and Send dimmed with no
              word as to why, so the three states the row can be in are each said.
            */}
            {listed.error ? (
              <Text variant="secondary" color={colors.down}>
                Couldn’t load tokens.
              </Text>
            ) : listed.loading && !listed.data ? (
              <Text variant="secondary" color={colors.ink55}>
                Loading…
              </Text>
            ) : sendable.length === 0 ? (
              <Text variant="secondary" color={colors.ink55}>
                Nothing to send here.
              </Text>
            ) : (
              sendable.map((t) => (
                <Pill
                  key={t.symbol}
                  label={t.symbol}
                  selected={t.symbol === symbol}
                  onPress={() => {
                    setSymbol(t.symbol);
                    // An amount of one token is not an amount of another.
                    setAmount('');
                  }}
                />
              ))
            )}
          </View>
        </View>

        <View style={{ marginTop: space.s22 }}>
          <Eyebrow small>Amount</Eyebrow>
          <View
            style={{
              height: FIELD_H,
              borderRadius: radius.card,
              ...border.input,
              backgroundColor: colors.surfaceAlt,
              justifyContent: 'center',
              paddingHorizontal: space.s14,
              marginTop: space.s10,
            }}
          >
            <TextInput
              value={amount}
              onChangeText={setAmount}
              placeholder="0.00"
              placeholderTextColor={colors.ink30}
              keyboardType="decimal-pad"
              inputMode="decimal"
              accessibilityLabel={`Amount in ${symbol}`}
              style={[typeScale.amountMd, { color: colors.ink, padding: 0 }]}
            />
          </View>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              marginTop: space.s8,
            }}
          >
            <Text variant="footnote" color={colors.ink55}>
              Balance
            </Text>
            {/*
              A dash, never a confident $0.00, when the balance could not be read — and never a
              dash for one that simply has not arrived yet. `?? null` collapsed those two into the
              same glyph, and against this executor "not yet" lasts long enough to read as "we
              could not": measured at twenty-five seconds on the simulator before $24,207.43
              appeared where a dash had been.
            */}
            <Price variant="footnote" figure="units">
              {held !== undefined ? `${quantity(held)} ${symbol}` : balance.loading ? '· · ·' : '—'}
            </Price>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.s6 }}>
            <Text variant="footnote" color={colors.ink55}>
              Network fee
            </Text>
            {/* A dash for a fee nobody could estimate. U+2212 is a minus, and a fee is never negative. */}
            {/* The network's price for sending, not the person's money: it stays while balances are hidden. */}
            <Price variant="footnote" figure="market">
              {feeUsd !== undefined ? `≈ ${money(feeUsd)}` : fee.loading ? '· · ·' : '—'}
            </Price>
          </View>
        </View>

        <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s16 }}>
          New addresses unlock after a cooling-off period.
        </Text>

        {/* A problem is said once there is an amount to say it about. A list that failed says so in the list. */}
        {problem && amount ? (
          <Text variant="secondary" color={colors.down} style={{ marginTop: space.s12 }}>
            {problem}
          </Text>
        ) : null}
        {error ? (
          <Text variant="secondary" color={colors.down} style={{ marginTop: space.s12 }}>
            {error}
          </Text>
        ) : null}
        {txHash ? (
          <NoteStrip kind="acted" style={{ marginTop: space.s12 }}>
            Sent. {txHash.slice(0, 10)}…{txHash.slice(-8)}
          </NoteStrip>
        ) : null}
      </Fill>

      <Button
        label={busy ? 'Signing…' : 'Send'}
        disabled={!ready || busy}
        onPress={() => {
          if (!token) return;
          void withdraw({ token, entry, allowlist: usable, amount }).catch(() => undefined);
        }}
      />
      <Press
        onPress={() => router.push('/withdraw-everything')}
        accessibilityRole="button"
        accessibilityLabel="Withdraw everything"
        style={{ marginTop: space.s14, alignItems: 'center' }}
      >
        <Text variant="footnote" color={colors.ink55}>
          Withdraw everything ›
        </Text>
      </Press>
    </Screen>
  );
}
