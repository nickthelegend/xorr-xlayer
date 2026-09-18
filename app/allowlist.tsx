/**
 * Withdrawal allowlist — PLAN.md 10.6 / 12.21 [G31], held by the executor since 4.9.
 *
 * Screen 20 shows "2 addresses" with nothing behind it. Adding one starts a cooling-off
 * period, so an attacker who gets the phone still cannot move funds today.
 *
 * "Add an address" had no `onPress`. It does now — and since 4.9 the entry is the executor's: it
 * is stored there, its cooling-off is counted by the executor's clock rather than this phone's, and
 * "Pending" on a row is the executor's answer with the moment it ends beside it. Removing an address
 * takes effect at once, everywhere; adding it back starts the wait again.
 */
import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  EmptyState,
  ErrorState,
  Button,
  Fill,
  LoadingRows,
  Press,
  Price,
  Row,
  Screen,
  SheetCard,
  Text,
  border,
  colors,
  radius,
  size,
  space,
  typeScale,
} from '@/ui';
import { isSolana } from '@/chain';
import { errorText } from '@/data/apiError';
import {
  isValidAddress,
  normaliseAddress,
  sameAddress,
  usableFromText,
  usableIn,
  useAllowlist,
} from '@/wallet/allowlist';

/*
 * The validator lives in the store, and there is exactly one of it.
 *
 * This screen had its own copy — base58, 32–44 characters, the shape a SOLANA address takes,
 * left over from before the pivot. Base58 has no `0` and no `x`, so every real Base address
 * failed it: the button never enabled, and the screen told the user their own wallet "does not
 * look like a Solana address". The store's `add()` has validated `0x…` correctly the whole
 * time; this regex sat in front of it and never let a valid address through.
 */
const FIELD_H = 48;

export default function Allowlist() {
  const goBack = useGoBack();
  const { addresses, add, remove, pendingFor, coolingOffHours, serverTime, loading, error, reload } = useAllowlist();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [saving, setSaving] = useState(false);
  /** The executor's own sentence when it refused an add, or the reason it could not be asked. */
  const [refused, setRefused] = useState<string>();
  /** The address whose Remove was pressed once. Only a second press on the same row removes it. */
  const [removing, setRemoving] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();

  const trimmed = normaliseAddress(address);
  // Case-insensitively, because `0xAB…` and `0xab…` are one address — and the executor dedupes that
  // way, so an exact-match check here disagreed with the refusal the user actually got.
  const duplicate = addresses.some((a) => sameAddress(a.address, trimmed));
  const valid = isValidAddress(trimmed) && label.trim().length > 0 && !duplicate;

  const problem = !trimmed
    ? undefined
    : duplicate
      ? 'That address is already on the list.'
      : isValidAddress(trimmed)
        ? undefined
        : isSolana
          ? 'Not a valid address: Solana addresses are base58 public keys.'
          : 'Not a valid address: it starts with 0x and has 42 characters.';

  // The number is the executor's. Until it has answered, the sentence does without one rather than guess.
  const wait = coolingOffHours === undefined ? 'after a cooling-off period' : `${coolingOffHours} hours after you add it`;

  async function save() {
    setSaving(true);
    setRefused(undefined);
    try {
      await add(label.trim(), trimmed);
      setLabel('');
      setAddress('');
      setAdding(false);
    } catch (e) {
      setRefused(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  async function pressRemove(target: string) {
    if (removing !== target) {
      setRemoving(target);
      setRemoveError(undefined);
      return;
    }
    setRemoving(undefined);
    try {
      await remove(target);
    } catch (e) {
      setRemoveError(errorText(e));
    }
  }

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
        <BackButton onPress={() => goBack()} />
        <Text variant="screenTitle">Allowlist</Text>
      </View>

      <Text variant="secondary" style={{ marginTop: space.s10 }}>
        Funds can only go here. A new address unlocks {wait}.
      </Text>

      <Fill style={{ marginTop: space.s20 }}>
        {error && addresses.length === 0 ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading ? (
          <LoadingRows count={2} height={68} />
        ) : addresses.length === 0 && !adding ? (
          /*
            An empty list rendered as an empty screen: a title, a sentence and then nothing at all
            down to the button. Every other list in the app says why it is empty; this one, which is
            empty for every new wallet, said nothing.
          */
          <EmptyState
            text="No addresses yet."
          />
        ) : null}

        {addresses.map((a) => {
          const pending = pendingFor(a);
          const confirming = removing === a.address;
          return (
            <Row
              key={a.address}
              title={a.label}
              secondary={
                pending
                  ? `Usable from ${usableFromText(a)}${serverTime !== undefined ? `, ${usableIn(a, serverTime)}` : ''}`
                  : a.address
              }
              value={
                <Price color={pending ? colors.warn : colors.up}>{pending ? 'Pending' : 'Active'}</Price>
              }
              right={
                <Press
                  onPress={() => void pressRemove(a.address)}
                  accessibilityRole="button"
                  accessibilityLabel={confirming ? `Confirm removing ${a.label}` : `Remove ${a.label}`}
                  style={{ paddingVertical: space.s8, paddingLeft: space.s10 }}
                >
                  <Text variant="secondarySm" color={confirming ? colors.down : colors.ink45}>
                    {confirming ? 'Confirm' : 'Remove'}
                  </Text>
                </Press>
              }
              height={68}
            />
          );
        })}

        {removing ? (
          <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
            Removing is instant. Re-adding restarts the wait.
          </Text>
        ) : null}
        {removeError ? (
          <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s8 }}>
            {removeError}
          </Text>
        ) : null}

        {adding ? (
          <SheetCard
            borderRadius={radius.panel}
            padding={space.s16}
            style={{ marginTop: space.s16 }}
          >
            <Text variant="cardTitle">New address</Text>
            <Field
              value={label}
              onChangeText={setLabel}
              placeholder="What is it? e.g. Cold storage"
              label="Address label"
            />
            <Field
              value={address}
              onChangeText={setAddress}
              placeholder="0x…"
              label="Address"
              mono
            />
            {problem || refused ? (
              <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s8 }}>
                {problem ?? refused}
              </Text>
            ) : null}
            <Button
              label={coolingOffHours === undefined ? 'Add' : `Add — usable in ${coolingOffHours} hours`}
              disabled={!valid}
              loading={saving}
              height={size.ghostSm}
              style={{ marginTop: space.s14 }}
              onPress={save}
            />
          </SheetCard>
        ) : null}
      </Fill>

      <Button
        label={adding ? 'Cancel' : 'Add an address'}
        variant="ghost"
        onPress={() => {
          setRefused(undefined);
          setAdding((v) => !v);
        }}
      />
    </Screen>
  );
}

function Field({
  value,
  onChangeText,
  placeholder,
  label,
  mono = false,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  label: string;
  mono?: boolean;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.ink35}
      accessibilityLabel={label}
      autoCapitalize="none"
      autoCorrect={false}
      style={[
        typeScale.body,
        border.input,
        {
          color: colors.ink,
          backgroundColor: colors.inputBg,
          borderRadius: radius.tile,
          paddingHorizontal: space.s14,
          height: FIELD_H,
          marginTop: space.s12,
          // An address is read glyph by glyph when it is checked, so it never goes tabular
          // — but it does get the full width and no autocorrect mangling it.
          letterSpacing: mono ? 0.2 : 0,
        },
      ]}
    />
  );
}
