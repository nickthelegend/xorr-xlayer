/**
 * Your money at Aave, and the way out.
 *
 * Tier 4 can put cash here and deliberately cannot take it back. That is the design, not a
 * gap: burning your own aTokens needs nobody's permission, so the delegation was never given
 * the receipt token — and a permission that cannot be used to trap you is the whole argument
 * this app makes. But a design nobody can act on is indistinguishable from a trap, so the
 * exit needs a screen, and it has to be obvious.
 *
 * The transaction is signed by the user's own wallet and does not touch the delegation.
 */
import React, { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  CloseButton,
  Eyebrow,
  Fill,
  Press,
  Price,
  Screen,
  SheetCard,
  Text,
  colors,
  money,
  radius,
  size,
  space,
  SignInPrompt,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { percent } from '@/format';
import { useAsync } from '@/data/useAsync';
import { errorText } from '@/data/apiError';
import { withdrawals } from '@/data/withdrawals';
import { useAaveWithdraw } from '@/defi/useAaveWithdraw';

/** Quick fractions of the position, plus everything. */
const PORTIONS = [0.25, 0.5, 1] as const;
const PORTION_H = 42;

export default function Yield() {
  const goBack = useGoBack();
  const [portion, setPortion] = useState<number>(1);
  const [txHash, setTxHash] = useState<string>();
  const [nonce, setNonce] = useState(0);
  const { withdraw, busy, error } = useAaveWithdraw();

  // `AavePosition`, the one type for this endpoint — the second one, here, promised an `apy` the executor does not always send.
  const pos = useAsync(() => withdrawals.aavePosition(), [nonce]);
  const signedOut = useSignedOut();
  const p = pos.data;
  const supplied = p?.suppliedUsd ?? 0;
  const amount = supplied * portion;

  const submit = useCallback(async () => {
    // A full withdrawal asks for "all of it" — `null` — rather than a number: aUSDC accrues every
    // second, so any figure read a moment ago already leaves dust behind.
    const hash = await withdraw(portion === 1 ? null : amount).catch(() => undefined);
    if (hash) {
      setTxHash(hash);
      setNonce((n) => n + 1);
    }
  }, [withdraw, portion, amount]);

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text variant="screenTitle">Earning</Text>
      <CloseButton onPress={() => goBack()} />
    </View>
  );

  // Signed out there is no position to read, and a withdraw button with nothing behind it.
  if (signedOut) {
    return (
      <Screen>
        {header}
        <SignInPrompt />
      </Screen>
    );
  }

  return (
    <Screen>
      {header}

      <Fill style={{ marginTop: space.s16 }}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {pos.loading && !p ? (
            <Text variant="body" color={colors.ink55}>
              Loading…
            </Text>
          ) : pos.error ? (
            <SheetCard borderRadius={radius.note} padding={space.s16}>
              <Text variant="rowPrimary" color={colors.down}>
                Couldn’t load what is earning.
              </Text>
              <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s6 }}>
                {errorText(pos.error)}
              </Text>
            </SheetCard>
          ) : p && !p.available ? (
            <SheetCard borderRadius={radius.note} padding={space.s16}>
              {/*
                Which absence it is decides the sentence. The executor's `reason` is not printed: it names the
                pool and its address, or is the identifier `no_wallet` — and "No lending pool here" said to a
                wallet the executor has no row for is a claim about the chain made from a missing account.
              */}
              <Text variant="rowPrimary">{p.reason === 'no_wallet' ? 'No wallet yet.' : 'No lending pool here.'}</Text>
              {p.reason === 'no_wallet' ? null : (
                /* "Nothing supplied" and "nowhere to supply" are different, and the
                   difference matters — the second one is not something the user did. */
                <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
                  Your balance is unaffected.
                </Text>
              )}
            </SheetCard>
          ) : p ? (
            <>
              <SheetCard borderRadius={radius.note} padding={space.s18}>
                <Eyebrow small>Supplied</Eyebrow>
                <Price variant="heroAmount" style={{ marginTop: space.s6 }}>
                  {money(supplied)}
                </Price>
                {/* No rate line without a rate: an absent `apy` times a hundred printed "NaN% a year". */}
                {p.apy !== undefined && Number.isFinite(p.apy) ? (
                  <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
                    {percent(p.apy * 100, { digits: 2, explicitSign: false })} a year, paid into the balance.
                  </Text>
                ) : null}
              </SheetCard>

              {supplied <= 0 ? (
                <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s16 }}>
                  Nothing earning yet.
                </Text>
              ) : (
                <>
                  <Eyebrow small style={{ marginTop: space.s20 }}>
                    Withdraw
                  </Eyebrow>
                  <View style={{ flexDirection: 'row', gap: space.s8, marginTop: space.s10 }}>
                    {PORTIONS.map((f) => (
                      <Press
                        key={f}
                        onPress={() => setPortion(f)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: portion === f }}
                        accessibilityLabel={f === 1 ? 'All of it' : `${f * 100} percent`}
                        style={{
                          flex: 1,
                          height: PORTION_H,
                          borderRadius: radius.panel,
                          alignItems: 'center',
                          justifyContent: 'center',
                          // Selection is white-on-dark. Never green: this is a choice, not a
                          // profit.
                          backgroundColor: portion === f ? colors.ink : colors.control,
                        }}
                      >
                        <Text
                          variant="control"
                          color={portion === f ? colors.sheet.ink : colors.ink50}
                        >
                          {f === 1 ? 'All' : `${f * 100}%`}
                        </Text>
                      </Press>
                    ))}
                  </View>

                  <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s14 }} figure="own">
                    {portion === 1
                      ? 'Withdraws all of it, with interest.'
                      : `Withdraws about ${money(amount)}, leaving ${money(supplied - amount)} earning.`}
                  </Text>
                </>
              )}

              {txHash ? (
                <View
                  style={{
                    marginTop: space.s16,
                    padding: space.s14,
                    borderRadius: radius.tile,
                    backgroundColor: colors.surface,
                  }}
                >
                  <Text variant="rowPrimary" color={colors.up}>
                    Withdrawal sent.
                  </Text>
                  <Text
                    variant="footnote"
                    color={colors.ink55}
                    style={{ marginTop: space.s6 }}
                    selectable
                  >
                    {txHash}
                  </Text>
                </View>
              ) : null}

              {error ? (
                <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s14 }}>
                  {error}
                </Text>
              ) : null}
            </>
          ) : null}
        </ScrollView>
      </Fill>

      <Button
        label={portion === 1 ? 'Withdraw all of it' : `Withdraw ${money(amount)}`}
        figure="own"
        height={size.buttonLg}
        disabled={!p?.available || supplied <= 0}
        loading={busy}
        onPress={submit}
      />
      {/* The claim that makes tier 4 safe to hand someone, restated where it is relied on. */}
      <Text
        variant="footnote"
        color={colors.ink55}
        align="center"
        style={{ marginTop: space.s12 }}
      >
        Only you can withdraw.
      </Text>
    </Screen>
  );
}
