/**
 * Range accumulation — tier 5.
 *
 * The user draws a band; the bot buys a rung lower and sells a rung higher inside it. It is the
 * first tier that ASSUMES something — that the range holds — which is why it sits above the ones
 * that assume nothing, and why this screen puts the assumption on the screen rather than in a
 * footnote. A range that breaks leaves you holding everything bought on the way down.
 *
 * The rungs are drawn against the live price, because a range is a claim about where the price is
 * going to stay and you cannot judge one without seeing where it is now.
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  CloseButton,
  Eyebrow,
  Fill,
  Press,
  Price,
  Screen,
  Segmented,
  Text,
  colors,
  money,
  radius,
  size,
  space,
  typeScale,
  SignInButton,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { repos } from '@/data';
import { usePrices } from '@/data/usePrices';
import { useAsync } from '@/data/useAsync';
import { api } from '@/data/api';

import { nextRuns } from '@/strategies/schedule';
import type { Cadence } from '@/data/types';
import { errorText } from '@/data/apiError';
import { percent } from '@/format';

type GridBacktest = {
  inRangePct: number;
  buys: number;
  sells: number;
  ret: number;
  leftValue: number;
  leftCost: number;
  disclaimer: string;
};

const SYMBOLS = [
  { value: 'WETH', label: 'WETH' },
  { value: 'CBBTC', label: 'CBBTC' },
] as const;
type Symbol = (typeof SYMBOLS)[number]['value'];

/** What a backtest ran on. Its result is shown only while the screen still says the same. */
type GridInputs = { symbol: Symbol; lower: number; upper: number; steps: number; usdPerStep: number };

function sameGrid(a: GridInputs, b: GridInputs): boolean {
  return (
    a.symbol === b.symbol &&
    a.lower === b.lower &&
    a.upper === b.upper &&
    a.steps === b.steps &&
    a.usdPerStep === b.usdPerStep
  );
}

const STEP_OPTIONS = [2, 4, 6, 8] as const;
const STEPS = STEP_OPTIONS.map((n) => ({ value: n as number, label: String(n) }));

const CADENCES = [
  { value: 'daily', label: 'Check daily' },
  { value: 'weekly', label: 'Check weekly' },
] as const satisfies readonly { value: Cadence; label: string }[];

const FIELD_H = 46;

export default function GridSetup() {
  const goBack = useGoBack();
  const [symbol, setSymbol] = useState<Symbol>('WETH');
  const { quotes } = usePrices([symbol]);
  const mark = quotes[symbol]?.price;

  const [lower, setLower] = useState('');
  const [upper, setUpper] = useState('');
  const [steps, setSteps] = useState<number>(4);
  const [perRung, setPerRung] = useState('50');
  const [cadence, setCadence] = useState<Cadence>('daily');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const signedOut = useSignedOut();

  const lo = parseFloat(lower) || 0;
  const hi = parseFloat(upper) || 0;
  const usdPerStep = parseFloat(perRung) || 0;
  const runs = useMemo(() => nextRuns(cadence, 3), [cadence]);

  /*
   * The backtest is on demand, not automatic.
   *
   * It costs a call to a rate-limited history API, and re-running it on every keystroke while
   * someone types a range would spend that quota on ranges they are still in the middle of
   * deciding — and could take the live prices down with it.
   *
   * And a result belongs to the range it ran on. The request was keyed on a counter, so after one
   * test, editing the range left the old answer on screen under the new numbers — and hid "Test it",
   * because a result was showing. The inputs a test ran with are kept now, and its result shows only
   * while the inputs on screen still match them.
   */
  const inputs: GridInputs = { symbol, lower: lo, upper: hi, steps, usdPerStep };
  const [tested, setTested] = useState<GridInputs | null>(null);
  const back = useAsync(async () => {
    if (!tested) return null;
    return api.post<GridBacktest>('/strategies/backtest', {
      kind: 'grid',
      symbol: tested.symbol,
      lookback: '90d',
      params: {
        lower: tested.lower,
        upper: tested.upper,
        steps: tested.steps,
        usdPerStep: tested.usdPerStep,
      },
    });
  }, [tested]);
  const testedNow = tested !== null && sameGrid(tested, inputs);
  // The same range again is a retry; a changed one is a new question.
  const runBacktest = () => (testedNow ? back.reload() : setTested(inputs));


  /*
   * Suggest a band around the live price rather than making someone guess in the dark.
   * ±12% is wide enough to hold through ordinary movement and narrow enough that the rungs are
   * meaningfully apart — but it is a starting point that can be typed over, not a default the
   * bot chose for them.
   */
  const suggest = () => {
    if (!mark) return;
    setLower(Math.round(mark * 0.88).toString());
    setUpper(Math.round(mark * 1.12).toString());
  };

  const rungs = useMemo(() => {
    if (!(lo > 0) || !(hi > lo)) return [];
    return Array.from({ length: steps + 1 }, (_, i) => lo + (i * (hi - lo)) / steps);
  }, [lo, hi, steps]);

  const valid = rungs.length > 0 && usdPerStep >= 5;
  const inRange = mark !== undefined && mark >= lo && mark <= hi;
  const maxCommitted = usdPerStep * steps;

  async function create() {
    if (!valid) return;
    setBusy(true);
    setError(undefined);
    try {
      await repos.strategies.create({
        kind: 'grid',
        state: 'live',
        label: `${symbol} ${money(lo, { decimals: 0 })}–${money(hi, { decimals: 0 })}`,
        symbol,
        params: { lower: lo, upper: hi, steps, usdPerStep },
        cadence,
        nextRunAt: runs[0]!.getTime(),
        // The most it can ever have at work: one rung per level, and never more than that.
        dailyAllocationUsd: maxCommitted,
      });
      goBack();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen light>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="sheetTitle" color={colors.sheet.ink}>
          Range accumulation
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
        <Text variant="body" color={colors.sheet.muted}>
          {symbol} right now
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s12 }}>
          <Price color={colors.sheet.ink} figure="market">
            {mark === undefined ? '—' : money(mark)}
          </Price>
          {mark !== undefined ? (
            <Press
              onPress={suggest}
              accessibilityRole="button"
              accessibilityLabel="Suggest a range around the current price"
              hitHeight={size.hit}
            >
              <Text variant="control" color={colors.cancelInk}>
                Suggest
              </Text>
            </Press>
          ) : null}
        </View>
      </View>

      <Fill style={{ marginTop: space.s14 }}>
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <View style={{ flexDirection: 'row', gap: space.s10 }}>
              <Field label="Bottom of range" value={lower} onChange={setLower} />
              <Field label="Top of range" value={upper} onChange={setUpper} />
            </View>

            <Eyebrow small color={colors.sheet.muted} style={{ marginTop: space.s18 }}>
              Rungs
            </Eyebrow>
            <Segmented
              options={STEPS}
              value={steps}
              onChange={setSteps}
              light
              height={size.segThumbSm}
              style={{ marginTop: space.s8 }}
            />

            <View style={{ marginTop: 16 }}>
              <Field label="Each rung buys" value={perRung} onChange={setPerRung} />
            </View>

            {/* The ladder, drawn. A range is only judgeable next to the price it is a claim about. */}
            {rungs.length > 0 ? (
              <View
                style={{
                  backgroundColor: colors.sheet.fill,
                  borderRadius: radius.tile,
                  padding: space.s14,
                  marginTop: space.s18,
                  gap: space.s6,
                }}
              >
                <Eyebrow small color={colors.sheet.muted}>The ladder</Eyebrow>
                {[...rungs].reverse().map((r, idx) => {
                  const isNearest =
                    mark !== undefined &&
                    Math.abs(r - mark) === Math.min(...rungs.map((x) => Math.abs(x - mark)));
                  return (
                    <View
                      key={r}
                      style={{ flexDirection: 'row', justifyContent: 'space-between' }}
                    >
                      <Text
                        variant="body"
                        color={isNearest ? colors.sheet.ink : colors.sheet.muted}
                      >
                        {money(r)}
                        {isNearest ? '  ← price is here' : ''}
                      </Text>
                      <Text variant="body" color={colors.sheet.muted}>
                        {idx === 0 ? 'sell' : idx === rungs.length - 1 ? 'buy' : ''}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : null}

            {/*
              What this range would have done, over real history.
              A grid's entire risk is the assumption in its own description — that the range holds
              — and that is a question about the past, not a forecast. "In range 41% of the last
              ninety days" is something a projection can never tell you.
            */}
            {rungs.length > 0 ? (
              <View
                style={{
                  backgroundColor: colors.sheet.fill,
                  borderRadius: radius.tile,
                  padding: space.s14,
                  marginTop: space.s16,
                  gap: space.s8,
                }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Eyebrow small color={colors.sheet.muted}>Over the last 90 days</Eyebrow>
                  {/* Offered for a range not yet tested, and after a failure — never over a result that stands. */}
                  {!signedOut && !(testedNow && (back.loading || back.data != null)) ? (
                    <Press
                      onPress={runBacktest}
                      accessibilityRole="button"
                      accessibilityLabel="Test this range against real history"
                      hitHeight={size.hit}
                    >
                      <Text variant="control" color={colors.cancelInk}>
                        Test it
                      </Text>
                    </Press>
                  ) : null}
                </View>
                {signedOut ? (
                  <Text variant="secondarySm" color={colors.sheet.muted}>
                    Sign in to test this range.
                  </Text>
                ) : !testedNow ? (
                  <Text variant="secondarySm" color={colors.sheet.muted}>
                    Replay this range over real prices.
                  </Text>
                ) : back.loading ? (
                  <Text variant="body" color={colors.sheet.muted}>Replaying real prices…</Text>
                ) : back.error ? (
                  /*
                    The executor's sentence. Every failure read "No price history for WETH" — a rate
                    limit, a timeout and a refused range alike — which sent people looking for a
                    missing feed.
                  */
                  <Text variant="secondarySm" color={colors.candleDown}>
                    {errorText(back.error)}
                  </Text>
                ) : back.data ? (
                  <>
                    <Text variant="rowPrimaryLg" color={colors.sheet.ink}>
                      In range {back.data.inRangePct}% of the time
                    </Text>
                    <Text variant="secondarySm" color={colors.sheet.muted}>
                      {back.data.buys} buys and {back.data.sells} sells,{' '}
                      {back.data.ret >= 0 ? 'up' : 'down'}{' '}
                      {percent(Math.abs(back.data.ret), { explicitSign: false })} on what it put to work.
                    </Text>
                    {back.data.leftCost > 0 ? (
                      <Text variant="secondarySm" color={colors.candleDown} figure="own">
                        {/* What a broken range looks like, in its own numbers. */}
                        It would have ended holding {money(back.data.leftValue)} of {symbol} that
                        cost {money(back.data.leftCost)}.
                      </Text>
                    ) : null}
                    <Text variant="footnote" color={colors.sheet.dim}>{back.data.disclaimer}</Text>
                  </>
                ) : null}
              </View>
            ) : null}

            {/*
              The two things that decide whether this is a good idea. Neither is a footnote, and each
              is one line that stays true to the planner (`planGrid`, server/src/executor/kinds/index.ts):

                - a rung it holds is not bought again, but a rung it has sold can be — so "it never buys
                  the same rung twice", which this said, stopped being true after the first sale;
                - outside the range it does nothing, and every lot bought on the way down is still held.
            */}
            <View style={{ marginTop: space.s16, gap: 8 }}>
              {/* What it would commit is the person's money; the rungs and the price above are prices, and stay. */}
              <Text variant="secondarySm" color={colors.sheet.muted} figure="own">
                At most {money(maxCommitted)} at work, one buy per rung at a time.
              </Text>
              <Text variant="secondarySm" color={colors.sheet.muted}>
                If {symbol} leaves the range it stops, and you keep what it bought.
              </Text>
              {rungs.length > 0 && !inRange && mark !== undefined ? (
                <Text variant="secondarySm" color={colors.candleDown}>
                  {money(mark)} is outside this range, so it would wait.
                </Text>
              ) : null}
            </View>

            <Segmented
              options={CADENCES}
              value={cadence}
              onChange={setCadence}
              light
              height={size.segThumbSm}
              style={{ marginTop: space.s18, marginBottom: space.s8 }}
            />

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
      {error ? (
        <Text variant="secondarySm" color={colors.candleDown} style={{ marginBottom: space.s12 }}>
          {error}
        </Text>
      ) : null}

      {signedOut ? (
        <SignInButton label="Sign in to start" backgroundColor={colors.candleUp} color={colors.ink} />
      ) : (
        <Button
          label={valid ? `Run this range on ${symbol}` : 'Set a range and a rung size'}
          backgroundColor={colors.candleUp}
          color={colors.ink}
          disabled={!valid}
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
        {/* It trades on crossings, and its first run has nothing to have crossed from (`planGrid`). */}
        Its first run only takes a reading.
      </Text>
    </Screen>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <Eyebrow small color={colors.sheet.muted}>
        {label}
      </Eyebrow>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        placeholder="0"
        placeholderTextColor={colors.sheet.dim}
        accessibilityLabel={label}
        style={[
          typeScale.rowPrimary,
          {
            marginTop: space.s8,
            height: FIELD_H,
            borderRadius: radius.tile,
            backgroundColor: colors.sheet.fill,
            paddingHorizontal: space.s12,
            color: colors.sheet.ink,
          },
        ]}
      />
    </View>
  );
}
