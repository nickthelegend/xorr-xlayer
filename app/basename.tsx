/**
 * Basenames, both directions.
 *
 * Base's naming service is already wired — the permission screen resolves the owner and delegate to
 * names when they have them, because two addresses that differ only in the middle look identical
 * truncated, on the one screen where telling them apart is the point. That resolver was reachable
 * from nowhere else.
 *
 * Both directions, because they answer different questions. Address to name is "who is this"; name
 * to address is "is this the address I think it is", which is the one worth having before you send
 * anything anywhere.
 *
 * A name that resolves to nothing says so. Falling back to the input would be the fabrication this
 * screen exists to prevent.
 */
import React, { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  Fill,
  HeaderBar,
  Screen,
  SheetCard,
  Text,
  border,
  colors,
  radius,
  space,
  typeScale,
} from '@/ui';
import { system } from '@/data/system';
import { errorText } from '@/data/apiError';

const FIELD_H = 48;

type Result =
  | { kind: 'name'; query: string; address: string | null }
  | { kind: 'address'; query: string; name: string | null }
  | { kind: 'error'; message: string };

export default function Basename() {
  const goBack = useGoBack();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const q = input.trim();
  /* An address, or something ending in a name suffix. Anything else is neither and cannot be looked up. */
  const looksAddress = /^0x[a-fA-F0-9]{40}$/.test(q);
  const looksName = q.includes('.');
  const canLook = looksAddress || looksName;

  const look = async () => {
    if (!canLook || busy) return;
    setBusy(true);
    setResult(null);
    try {
      if (looksAddress) {
        const r = await system.basenameOf(q);
        setResult({ kind: 'address', query: q, name: r.name });
      } else {
        const r = await system.addressOf(q);
        setResult({ kind: 'name', query: q, address: r.address });
      }
    } catch (e) {
      setResult({ kind: 'error', message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Basenames</Text>} />

      <Fill style={{ marginTop: space.s20, gap: space.s12 }}>
        <View
          style={[
            {
              height: FIELD_H,
              justifyContent: 'center',
              borderRadius: radius.card,
              backgroundColor: colors.inputBg,
              paddingHorizontal: space.s16,
            },
            border.input,
          ]}
        >
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="name.base.eth or 0x…"
            placeholderTextColor={colors.ink35}
            accessibilityLabel="Basename or address"
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={look}
            returnKeyType="search"
            style={[typeScale.body, { color: colors.ink }]}
          />
        </View>

        <Button
          label={busy ? 'Looking…' : 'Look it up'}
          disabled={!canLook || busy}
          onPress={look}
        />

        {result === null ? (
          <Text variant="secondarySm" color={colors.ink55}>
            Resolved on the chain, both ways.
          </Text>
        ) : result.kind === 'error' ? (
          <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
            <Text variant="secondary" color={colors.down}>
              {result.message}
            </Text>
          </SheetCard>
        ) : (
          <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
            <Text variant="footnote" color={colors.ink55}>
              {result.kind === 'address' ? 'NAME' : 'ADDRESS'}
            </Text>
            {/*
              Null is rendered as "no name", never as the query echoed back. A resolver that returns
              its input when it finds nothing is a resolver that always appears to work.
            */}
            <Text
              variant="rowPrimaryLg"
              color={
                (result.kind === 'address' ? result.name : result.address) ? colors.ink : colors.ink40
              }
              style={{ marginTop: space.s6 }}
            >
              {result.kind === 'address'
                ? (result.name ?? 'This address has no Basename.')
                : (result.address ?? 'That name does not resolve.')}
            </Text>
            <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
              {result.query}
            </Text>
          </SheetCard>
        )}
      </Fill>
    </Screen>
  );
}
