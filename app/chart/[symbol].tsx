/**
 * Screen 21 — Pro chart. screens.md Group B.
 *
 * Price 38/700, change chip, "{signed} past 12 hours". A 230pt candlestick on the TIGHT projection:
 * grid, candles, a 56pt right price axis derived from the projection, and the dashed mark
 * line with its chip — all of which `Candlestick` now draws itself. Timeframe pills. Sell / Buy.
 *
 * Every pill is a candle of exactly its length (`CHART_PLAN` in src/data/marketData.ts), so the pills
 * are the lengths the feed can cut: `15m` drew `1H`'s day under another name, and `1W` drew four-day
 * candles. The change line said "today" under all of them. Gone with those: the volume row, which the
 * feed has no volume for and so was always an empty strip, and a note saying an agent was "watching
 * the range high", which no agent was.
 *
 * Short and Long had no `onPress`, and then opened the spot ticket for the raw symbol — so on BTC
 * and ETH they led to "Not tradable here", and on everything else a spot sale is not a short. They
 * are Sell and Buy now, for the token the market trades as, and only where it can trade.
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  Button,
  ButtonPair,
  Candlestick,
  DeltaChip,
  EmptyState,
  ErrorState,
  Fill,
  LoadingRows,
  Pill,
  PillRow,
  Price,
  Screen,
  Text,
  colors,
  percent,
  pnlTone,
  price as fmtPrice,
  space,
  tightProjection,
  toCandles,
} from '@/ui';
import { axisLabel, signedMoney } from '@/format';
import { CHART_PLAN, CHART_TIMEFRAMES, type ChartTimeframe } from '@/data/marketData';
import { settlementSymbol } from '@/data/tradable';
import { useSettleable } from '@/data/useSettleable';
import { chartSeries, spanWords, stillWarming } from '@/markets/series';
import { useLiveRead } from '@/markets/useLiveRead';

const CHART_H = 230;

export default function ProChart() {
  const params = useLocalSearchParams<{ symbol: string }>();
  const symbol = params.symbol ?? '';
  const router = useRouter();
  const goBack = useGoBack();
  // screens.md: 1H is the default (bolded in the pill row).
  const [tf, setTfRaw] = useState<ChartTimeframe>('1H');
  /*
   * Which candle the user is reading, if any.
   *
   * A selection is an index into ONE specific series. Carrying it across a timeframe change
   * would leave it pointing at a different bar, of a different length, while looking like the
   * same choice — and the readout would confidently show the wrong candle's numbers.
   */
  const [sel, setSel] = useState<number | null>(null);
  const setTf = (next: ChartTimeframe) => {
    setSel(null);
    setTfRaw(next);
  };

  /*
   * Three answers, and each gets its own words: still warming is a wait (asked again by
   * `useLiveRead`), a symbol nothing prices has no candles, and a failed read is a failure. Through
   * the repository all three read "No price feed", and the error branches here could never show.
   */
  const read = useLiveRead(() => chartSeries(symbol, tf), [symbol, tf], stillWarming);
  // The answer for this pill — not the last pill's candles under the new label while this one loads.
  const shown = read.data?.symbol === symbol && read.data.window === tf ? read.data : undefined;
  const loading = read.loading && !shown;

  const series = useMemo(() => toCandles(shown?.bars ?? []), [shown]);
  const proj = series.length ? tightProjection(series) : null;

  const last = series.length ? series[series.length - 1]!.close : 0;
  const first = series.length ? series[0]!.open : 0;
  const changeAbs = last - first;
  const changePct = first ? (changeAbs / first) * 100 : 0;
  /** What the candles on screen span: twelve of them, each as long as the pill. */
  const span = spanWords(series.length * CHART_PLAN[tf].candleMs);
  /** The OHLC of the chosen bar. Guarded, because a stale index must not read past the end. */
  const picked = sel !== null && sel >= 0 && sel < series.length ? series[sel]! : null;

  // The token this market trades as — BTC buys XBTC — asked of the executor, as on the asset screen.
  const settleable = useSettleable(symbol);
  const into = settlementSymbol(symbol);

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
        <BackButton onPress={() => goBack()} />
        <Text variant="cardTitle">{symbol}/USD</Text>
      </View>

      {/* PLAN.md §1.4.5 — nothing lies. With no series there is no last price, and
          rendering the `0` fallback put "$0.0000" and a green "+0.00%" on screen as if
          they were a quote. No bars means no number: say so instead. */}
      <View style={{ marginTop: space.s18, gap: space.s8 }}>
        {series.length ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10 }}>
              <Price variant="priceMd" figure="market">
                {fmtPrice(last)}
              </Price>
              <DeltaChip label={percent(changePct, 2)} tone={pnlTone(changeAbs)} />
            </View>
            {/*
              The numbers behind one bar, when a bar is chosen.
              The chart was the centrepiece and read-only: a user could see the shape and
              never the open, high, low or close of any single candle. The data is already
              loaded, so this costs a tap and nothing else, and the line reverts the moment
              the selection clears.
            */}
            {picked ? (
              <Text variant="secondary" color={colors.ink55}>
                {`O ${fmtPrice(picked.open)}  H ${fmtPrice(picked.high)}  L ${fmtPrice(picked.low)}  C ${fmtPrice(picked.close)}`}
              </Text>
            ) : (
              <Text variant="secondary">{`${signedMoney(changeAbs)} ${span}`}</Text>
            )}
          </>
        ) : (
          <Price variant="priceMd" color={colors.ink55} figure="market">
            —
          </Price>
        )}
      </View>

      <Fill style={{ marginTop: space.s18 }}>
        {read.error ? (
          <ErrorState error={read.error} onRetry={read.reload} />
        ) : loading ? (
          <LoadingRows count={3} height={70} />
        ) : !proj ? (
          <EmptyState
            text={
              shown?.feed === 'unavailable'
                ? `No candles for ${symbol}.`
                : `No ${tf} candles for ${symbol} yet.`
            }
          />
        ) : (
          <Candlestick
            series={series}
            projection={proj}
            height={CHART_H}
            grid
            showAxis
            formatAxis={axisLabel}
            lastPrice={{ value: last, label: fmtPrice(last) }}
            selected={sel}
            onSelect={setSel}
          />
        )}
      </Fill>

      <PillRow style={{ marginTop: space.s14, flexGrow: 0 }}>
        {CHART_TIMEFRAMES.map((t) => (
          <Pill key={t} label={t} selected={t === tf} onPress={() => setTf(t)} />
        ))}
      </PillRow>

      {settleable === 'no' ? (
        <View style={{ marginTop: space.s14, paddingVertical: space.s14, alignItems: 'center' }}>
          <Text variant="secondary" align="center">
            Not tradable here
          </Text>
        </View>
      ) : (
        <ButtonPair
          style={{ marginTop: space.s14 }}
          left={
            <Button
              label="Sell"
              variant="secondary"
              disabled={settleable === 'checking'}
              onPress={() => router.push(`/order/${into}?side=sell`)}
            />
          }
          right={
            <Button
              label="Buy"
              backgroundColor={colors.candleUp}
              color={colors.ink}
              disabled={settleable === 'checking'}
              onPress={() => router.push(`/order/${into}?side=buy`)}
            />
          }
        />
      )}
    </Screen>
  );
}
