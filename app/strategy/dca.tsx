/**
 * DCA setup — PLAN.md 9.4. The headline feature of the pivot, and tier 1 of the ladder.
 *
 * White sheet, built from screen 14's ticket pattern (amount keypad + segmented controls)
 * plus a "next 3 runs" preview. One primary CTA.
 *
 * §1.2: "Buy $50 of WETH every Monday is verifiable by a user with no trading knowledge."
 * The next-runs preview exists so that verification is possible at the moment of setup,
 * not after the fact.
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  CloseButton,
  Eyebrow,
  FailureNote,
  Fill,
  Keypad,
  Price,
  Screen,
  Segmented,
  Text,
  colors,
  money,
  radius,
  size,
  space,
  SignInButton,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { keypadPress } from '@/state/derived';
import { repos } from '@/data';
import { nextRuns } from '@/strategies/schedule';
import { RECURRING_BUY_SYMBOLS, type RecurringBuySymbol } from '@/strategies/ladder';
import type { Cadence } from '@/data/types';
import { AMOUNT_DECIMALS, checkAmount } from '@/markets/amount';

const CADENCES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 wks' },
  { value: 'monthly', label: 'Monthly' },
] as const satisfies readonly { value: Cadence; label: string }[];

/**
 * What a recurring buy can actually buy. These are the Base tokens the executor can route
 * through 1inch and settle through XorrDelegation — offering a symbol it cannot route would
 * let a user schedule a strategy that can never execute.
 *
 * The list is `RECURRING_BUY_SYMBOLS`, kept with the ladder and shared with the backtest, which had
 * drifted into offering USDC — the case this screen removed. Why USDC is impossible is written there.
 */
const SYMBOLS = RECURRING_BUY_SYMBOLS.map((s) => ({ value: s, label: s }));

type Symbol = RecurringBuySymbol;

/** The cadence in the sentence the CTA and the label both speak. */
function phrase(c: Cadence): string {
  return CADENCES.find((x) => x.value === c)!.label.toLowerCase();
}

export default function DcaSetup() {
  const goBack = useGoBack();
  const [amount, setAmount] = useState('50');
  const [cadence, setCadence] = useState<Cadence>('weekly');
  const [symbol, setSymbol] = useState<Symbol>('WETH');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const signedOut = useSignedOut();

  const usd = parseFloat(amount || '0') || 0;
  /*
   * The same rules the ticket holds an amount to, on the field that commits to REPEATING it.
   *
   * This screen had none: the only guard was `usd <= 0`, so `$0.001 of WETH, weekly` was a live green
   * button for a strategy every run of which would be refused by the route, and `$9,999,999` likewise. An
   * amount refused here is refused before it becomes a schedule.
   *
   * Not checked against the balance. A recurring buy is not spent today, so today's cash says nothing about
   * whether it can run — the daily cap is what governs it, and the executor answers that when it is created.
   */
  const bad = checkAmount({ text: amount });
  const runs = useMemo(() => nextRuns(cadence, 3), [cadence]);
  const sentence = `${money(usd, { decimals: 0 })} of ${symbol}, ${phrase(cadence)}`;

  async function create() {
    if (bad.state !== 'ok') return;
    setBusy(true);
    setError(undefined);
    try {
      await repos.strategies.create({
        kind: 'dca',
        state: 'live',
        label: sentence,
        symbol,
        params: { usd },
        cadence,
        nextRunAt: runs[0]!.getTime(),
        dailyAllocationUsd: usd,
      });
      goBack();
    } catch (e) {
      // Kept as the error it is: `FailureNote` reads the retry, the wait and the fix off it.
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen light gutter="gutter">
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="sheetTitle" color={colors.sheet.ink}>
          Recurring buy
        </Text>
        <CloseButton onPress={() => goBack()} light />
      </View>

      <Segmented
        options={SYMBOLS}
        value={symbol}
        onChange={setSymbol}
        light
        style={{ marginTop: space.s16 }}
      />

      <View style={{ alignItems: 'center', marginTop: space.s22, gap: space.s6 }}>
        {/*
          Being typed, so never masked while balances are hidden. What it commits to — the runs below and the sentence on
          the button — is the person's money, and hides.
        */}
        <Price variant="heroAmount" color={colors.sheet.ink} figure="input">
          ${amount}
        </Price>
        <Text variant="body" color={colors.sheet.muted}>
          of {symbol}, {phrase(cadence)}
        </Text>
      </View>

      <Segmented
        options={CADENCES}
        value={cadence}
        onChange={setCadence}
        light
        height={size.segThumbSm}
        style={{ marginTop: space.s18 }}
      />

      <Fill style={{ marginTop: space.s8 }}>
        <ScrollView showsVerticalScrollIndicator={false}>
          <Keypad light onPress={(k) => setAmount((a) => keypadPress(a, k, { decimals: AMOUNT_DECIMALS }))} />

          {/* The whole point of tier 1: you can check the schedule before you agree to it. */}
          <View
            style={{
              backgroundColor: colors.sheet.fill,
              borderRadius: radius.tile,
              padding: space.s14,
              marginTop: space.s12,
              gap: space.s8,
            }}
          >
            <Eyebrow small color={colors.sheet.muted}>
              Next three runs
            </Eyebrow>
            {/*
              A schedule of nothing is not a schedule.

              With the amount cleared this listed three dated rows at $0 — a confident preview of
              three buys that would never happen, under a heading promising the opposite. The
              button is correctly disabled at that point; the panel above it was still making a
              claim. It asks for the amount instead.
            */}
            {bad.state !== 'ok' ? (
              <Text variant="body" color={colors.sheet.muted}>
                Enter an amount to see the schedule.
              </Text>
            ) : null}
            {bad.state === 'ok' && runs.map((d) => (
              <View
                key={d.toISOString()}
                style={{ flexDirection: 'row', justifyContent: 'space-between' }}
              >
                <Text variant="body" color={colors.sheet.ink}>
                  {d.toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
                </Text>
                <Price variant="body" color={colors.sheet.muted}>
                  {money(usd, { decimals: 0 })}
                </Price>
              </View>
            ))}
          </View>

        </ScrollView>
      </Fill>

      {/*
        The refusal has to be where the button is.

        It used to render inside the ScrollView, below a panel tall enough to push it off the
        screen, while the button that triggers it is pinned outside the scroll area. So tapping
        "Buy $9,000 of WETH, weekly" over the daily cap looked like nothing happened at all: the
        executor answered `400` in 304ms with a perfectly good sentence, and the user never saw it.
        Above the button, it is on screen whenever it exists.
      */}
      {/*
        The amount's own refusal first: it is about what is in the field right now, and the executor's answer
        below it is about the last thing that was sent. Showing both at once would put two red sentences under
        one button, one of them stale.
      */}
      {bad.state === 'refused' ? (
        <Text
          variant="secondarySm"
          color={colors.candleDown}
          style={{ marginBottom: space.s12 }}
          accessibilityLiveRegion="polite"
        >
          {bad.reason}
        </Text>
      ) : error !== undefined ? (
        <FailureNote error={error} light style={{ marginBottom: space.s12 }} />
      ) : null}

      {signedOut ? (
        <SignInButton label="Sign in to start" backgroundColor={colors.candleUp} color={colors.ink} />
      ) : (
        <Button
          label={`Buy ${sentence}`}
          figure="own"
          backgroundColor={colors.candleUp}
          color={colors.ink}
          disabled={bad.state !== 'ok'}
          loading={busy}
          onPress={create}
        />
      )}
      <Text
        variant="footnote"
        color={colors.sheet.dim}
        align="center"
        style={{ marginTop: space.s12 }}
      >
        Within your daily cap. Pause anytime.
      </Text>
    </Screen>
  );
}
