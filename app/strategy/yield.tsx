/**
 * Move idle cash to yield — tier 4 of the ladder.
 *
 * The rung above take-profit and below range accumulation, and it earns that place by asking
 * the bot to forecast nothing: the rate is published, the venue is one contract, and every
 * move can be checked against app.aave.com. §1.2 — "every move is a published rate you can
 * check."
 *
 * Two numbers, and the second is the one that matters. "Sweep at most $X" is the size;
 * "always keep $Y spendable" is the promise that this strategy will not quietly starve every
 * other strategy the account has by supplying the balance they were counting on.
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
import { percent } from '@/format';
import { useSignedOut } from '@/auth/useSignedOut';
import { keypadPress } from '@/state/derived';
import { AMOUNT_DECIMALS, checkAmount } from '@/markets/amount';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { nextRuns } from '@/strategies/schedule';
import type { Cadence } from '@/data/types';

const CADENCES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 wks' },
  { value: 'monthly', label: 'Monthly' },
] as const satisfies readonly { value: Cadence; label: string }[];

/** Buffers offered as one tap. The default is not zero — see the header comment. */
const KEEP_OPTIONS = [50, 100, 250, 500] as const;
const KEEPS = KEEP_OPTIONS.map((v) => ({ value: v as number, label: money(v, { decimals: 0 }) }));

/** Below this the gas costs more than the yield, so the strategy leaves the cash alone. */
const MIN_MOVE_USD = 25;

/** The cadence in the sentence the CTA and the label both speak. */
function phrase(c: Cadence): string {
  return CADENCES.find((x) => x.value === c)!.label.toLowerCase();
}

export default function YieldSetup() {
  const goBack = useGoBack();
  const [amount, setAmount] = useState('250');
  const [cadence, setCadence] = useState<Cadence>('daily');
  const [keepCashUsd, setKeepCashUsd] = useState<number>(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const rate = useAsync(() => repos.yield.staking(), []);
  const balance = useAsync(() => repos.portfolio.balance(), []);
  const signedOut = useSignedOut();

  const usd = parseFloat(amount || '0') || 0;
  /*
   * The same rules the ticket and the recurring buy hold an amount to. A sweep ceiling of `$0.001` sets a
   * strategy whose every run moves nothing; one of `$9,999,999` is past what the route will take.
   */
  const bad = checkAmount({ text: amount });
  const runs = useMemo(() => nextRuns(cadence, 3), [cadence]);

  const cash = balance.data?.cash;
  const supplied = balance.data?.supplied ?? 0;
  /*
   * What this run would actually move, given what is there right now.
   *
   * Showing the configured amount when the wallet cannot cover it is the sort of small lie that
   * makes a user think the bot failed. The strategy sweeps `min(idle, amount)` and does nothing at
   * all below the floor, so the preview says the same.
   */
  const idle = cash === undefined ? undefined : Math.max(cash - keepCashUsd, 0);
  const wouldMove = idle === undefined ? undefined : Math.min(idle, usd);
  /*
   * The same rule applied to the floor: you cannot hold back money you do not have. With an empty
   * wallet the configured $100 would otherwise read as $100 sitting there being protected, which is
   * the same small lie one line up, told about a different number.
   */
  const kept = cash === undefined ? undefined : Math.min(keepCashUsd, cash);
  const apy = rate.data?.estimatedApy;
  /* Only once the rate has actually loaded — an absent answer is not a refusal. */
  const unavailable = rate.data != null && rate.data.availableHere === false;
  /*
   * Asked, and no rate came back.
   *
   * The card said "No rate right now. Nothing will move." while the button under it stayed live and
   * created the strategy — so something WAS set to move, on a schedule, against a rate nobody had read
   * and a pool nobody had confirmed was there. Without a rate there is nothing to decide with, so the
   * button waits for one, as it already does while the rate loads.
   */
  const noRate = !rate.loading && apy === undefined;

  async function create() {
    if (bad.state !== 'ok') return;
    setBusy(true);
    setError(undefined);
    try {
      await repos.strategies.create({
        kind: 'yield-rotation',
        state: 'live',
        label: `Idle cash to yield, ${phrase(cadence)}`,
        // The asset being swept is USDC. The venue is fixed and lives on the server, because a
        // pool address is not something a user should be asked to type.
        symbol: 'USDC',
        params: { usd, keepCashUsd, minMoveUsd: 25 },
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
    <Screen light>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="sheetTitle" color={colors.sheet.ink}>
          Idle cash to yield
        </Text>
        <CloseButton onPress={() => goBack()} light />
      </View>

      {/*
        The live rate, or an honest silence.

        A rate is the entire reason to run this strategy, so it is read from the Aave Pool
        rather than written into the design. Loading, unavailable and a real number are three
        different things and each says which one it is.
      */}
      <View
        style={{
          marginTop: space.s16,
          padding: space.s14,
          borderRadius: radius.tile,
          backgroundColor: colors.sheet.fill,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <View style={{ flex: 1, paddingRight: space.s12 }}>
          <Eyebrow small color={colors.sheet.muted}>
            USDC supply
          </Eyebrow>
          <Text variant="secondarySm" color={colors.sheet.muted} style={{ marginTop: space.s4 }}>
            {rate.loading ? 'Loading…' : noRate ? 'Couldn’t read the rate.' : 'Variable rate.'}
          </Text>
        </View>
        <Price color={apy === undefined ? colors.sheet.muted : colors.up} figure="market">
          {/* A rate is unsigned: the unsigned percent, not the signed one with its "+" cut off. */}
          {rate.loading
            ? '…'
            : apy === undefined
              ? '—'
              : percent(apy * 100, { digits: 2, explicitSign: false })}
        </Price>
      </View>

      <View style={{ alignItems: 'center', marginTop: space.s20, gap: space.s6 }}>
        {/* Being typed, so never masked: an amount its author cannot read is not private, it is unusable. */}
        <Price variant="heroAmount" color={colors.sheet.ink} figure="input">
          ${amount}
        </Price>
        <Text variant="body" color={colors.sheet.muted}>
          swept at most, {phrase(cadence)}
        </Text>
      </View>

      <Segmented
        options={CADENCES}
        value={cadence}
        onChange={setCadence}
        light
        height={size.segThumbSm}
        style={{ marginTop: space.s16 }}
      />

      <Fill style={{ marginTop: space.s8 }}>
        <ScrollView showsVerticalScrollIndicator={false}>
          <Keypad light onPress={(k) => setAmount((a) => keypadPress(a, k, { decimals: AMOUNT_DECIMALS }))} />

          <Eyebrow small color={colors.sheet.muted} style={{ marginTop: space.s14 }}>
            Always keep spendable
          </Eyebrow>
          <Segmented
            options={KEEPS}
            value={keepCashUsd}
            onChange={setKeepCashUsd}
            light
            height={size.segThumbSm}
            style={{ marginTop: space.s8 }}
          />

          {/* What it would do right now, against the real balance. */}
          <Card title="If it ran now">
            <StatRow
              label="Spendable cash"
              value={balance.loading ? '…' : cash === undefined ? '—' : money(cash)}
            />
            <StatRow
              label="Kept back"
              // Unknown is a dash. U+2212 is a minus sign, and it read as a negative amount kept back.
              value={balance.loading ? '…' : kept === undefined ? '—' : money(kept)}
            />
            <StatRow
              label="Would move"
              value={
                balance.loading
                  ? '…'
                  : wouldMove === undefined
                    ? '—'
                    : wouldMove < MIN_MOVE_USD
                      ? 'nothing'
                      : money(wouldMove)
              }
              emphasis
            />
            {supplied > 0 ? <StatRow label="Already earning" value={money(supplied)} /> : null}
            {wouldMove !== undefined && wouldMove < MIN_MOVE_USD ? (
              <Text variant="footnote" color={colors.sheet.dim}>
                {`Moves nothing under ${money(MIN_MOVE_USD, { decimals: 0 })}.`}
              </Text>
            ) : null}
          </Card>

          <Card title="Next three runs">
            {runs.map((d) => (
              <StatRow
                key={d.toISOString()}
                label={d.toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
                value={`up to ${money(usd, { decimals: 0 })}`}
              />
            ))}
          </Card>

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
      {/* What is wrong with the field now, ahead of what the executor said about the last thing sent. */}
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

      {/*
        A sweep that cannot run is not worth creating.
        
        The rate above is X Layer mainnet's, on every build, because the testnet has no lending pool
        to ask — the yield module says so at length. But
        the executor's own planner checks `getCode` on the pool before it will supply anything and
        returns null when there is nothing there, so on a build without Aave this screen was
        offering to schedule a strategy guaranteed to do nothing on every run, for ever, silently.
        The executor now reports that check as `availableHere` and this is the other half of it.

        Its note is no longer repeated above the button: it names the venue and the chain, and the
        button already says the one thing that matters. A rate that could not be read is refused the
        same way — see `noRate`.
      */}
      {signedOut ? (
        <SignInButton label="Sign in to start" backgroundColor={colors.candleUp} color={colors.ink} />
      ) : (
        <Button
          label={
            unavailable
              ? 'Not available on this network'
              : noRate
                ? 'No rate right now'
                : `Sweep up to ${money(usd, { decimals: 0 })} ${phrase(cadence)}`
          }
          figure="own"
          backgroundColor={colors.candleUp}
          color={colors.ink}
          disabled={bad.state !== 'ok' || unavailable || apy === undefined}
          loading={busy}
          onPress={create}
        />
      )}
      {/*
        The exit, said up front.

        Supplying is the only thing the bot can do here: the receipt token is yours and it was
        never approved for the delegation to move, so withdrawing is a signature only you can
        make. Saying so at setup is the difference between a permission and a trap.
      */}
      <Text
        variant="footnote"
        color={colors.sheet.dim}
        align="center"
        style={{ marginTop: space.s12 }}
      >
        Only you can withdraw.
      </Text>
    </Screen>
  );
}

/** A pale panel on the light sheet. Three of these, all the same shape. */
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: colors.sheet.fill,
        borderRadius: radius.tile,
        padding: space.s14,
        marginTop: space.s14,
        gap: space.s8,
      }}
    >
      <Eyebrow small color={colors.sheet.muted}>
        {title}
      </Eyebrow>
      {children}
    </View>
  );
}

function StatRow({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text variant="body" color={colors.sheet.muted}>
        {label}
      </Text>
      <Price variant="body" color={emphasis ? colors.sheet.ink : colors.sheet.muted}>
        {value}
      </Price>
    </View>
  );
}
