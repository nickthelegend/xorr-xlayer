/**
 * A futures contract — Hyperliquid's market for one symbol (2026-09-13). screens.md Group B, screen 25.
 *
 * The mark and its move, the venue's own candles, and the four figures a futures trader reads first:
 * the funding rate and when it is next paid, open interest, and the day's volume. Every number is the
 * venue's.
 *
 * What left: the leverage calculator and the Short / Long buttons. The calculator was arithmetic about
 * a contract xorr does not offer, and both buttons opened the SPOT ticket — someone who set 10x and
 * tapped Long got an unleveraged spot buy. xorr does not trade futures, and the screen says so in one
 * line instead of offering buttons that do something else.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  AreaChart,
  AssetMark,
  BackButton,
  Candlestick,
  DeltaChip,
  ErrorState,
  Pill,
  PillRow,
  Placeholder,
  Press,
  Screen,
  Segmented,
  StatGrid,
  Tag,
  Text,
  colors,
  percent,
  pnlTone,
  price as fmtPrice,
  radius,
  size,
  space,
  tightProjection,
  toCandles,
} from '@/ui';
import { RollingNumber } from '@/ui/RollingNumber';
import { compactMoney, countdown } from '@/format';
import { assetGradient } from '@/design/gradients';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { useLogo } from '@/data/useLogos';
import type { PerpMetrics, PerpRange } from '@/data/repositories';
import { intervalWords, nextPaymentAt } from '@/markets/funding';

const RANGES: readonly PerpRange[] = ['1D', '1W', '1M', '1Y'];
/** How each range reads in the move under the price. */
const RANGE_WORDS: Readonly<Record<PerpRange, string>> = {
  '1D': 'today',
  '1W': 'this week',
  '1M': 'this month',
  '1Y': 'this year',
};

/** Candles or line, as a visible control — the asset screen's, word for word. */
const CHART_VIEWS: { value: number; label: string }[] = [
  { value: 0, label: 'Candles' },
  { value: 1, label: 'Line' },
];
const CHART_VIEW_SEGMENT = 58;
const CHART_VIEW_W = CHART_VIEW_SEGMENT * 2 + space.s4 + size.segPad * 2;

const CHART_H = 170;
const MARK = 26;
/** The stat grid's height, for its placeholder while the contract loads. */
const STATS_H = 150;

export default function PerpContract() {
  const { symbol = 'BTC' } = useLocalSearchParams<{ symbol: string }>();
  const goBack = useGoBack();
  const [range, setRange] = useState<PerpRange>('1D');
  const [candleView, setCandleView] = useState(true);

  const metrics = useAsync(() => repos.perps.metrics(symbol), [symbol]);
  const candles = useAsync(() => repos.perps.candles(symbol, range), [symbol, range]);
  const logo = useLogo(symbol);
  const m = metrics.data;
  const name = m?.symbol ?? symbol;

  const series = useMemo(() => toCandles(candles.data?.bars ?? []), [candles.data]);
  const closes = useMemo(() => series.map((c) => c.close), [series]);
  const projection = useMemo(() => tightProjection(series), [series]);
  const lastClose = closes.at(-1);
  const lastPrice = useMemo(
    () => (lastClose === undefined ? undefined : { value: lastClose, label: fmtPrice(lastClose) }),
    [lastClose],
  );
  const hasSeries = closes.length > 1;
  const windowPct = hasSeries ? ((closes.at(-1)! - closes[0]!) / closes[0]!) * 100 : null;
  /* Today is the venue's own 24-hour change; a longer range is measured across the candles drawn. */
  const changePct = range === '1D' ? (m?.change24hPct ?? windowPct) : windowPct;

  return (
    <Screen gutter="none">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10, paddingHorizontal: space.gutter }}>
        <BackButton onPress={goBack} />
        <AssetMark gradient={assetGradient(name)} {...logo} size={MARK} />
        <Text variant="cardTitleLg" numberOfLines={1} style={{ flexShrink: 1 }}>
          {name}
        </Text>
        <Tag label="Perp" small colors={{ bg: colors.surfaceAlt, fg: colors.ink55 }} style={{ alignSelf: 'center' }} />
        <View style={{ marginLeft: 'auto' }}>
          {m ? (
            <Tag label={`Up to ${m.maxLeverage}x`} small colors={{ bg: colors.goldBg, fg: colors.goldFill }} />
          ) : metrics.loading ? (
            <Placeholder width={72} height={22} style={{ borderRadius: radius.full }} />
          ) : null}
        </View>
      </View>

      {metrics.error ? (
        <View style={{ marginTop: space.s22, paddingHorizontal: space.gutter }}>
          <ErrorState error={metrics.error} onRetry={metrics.reload} />
        </View>
      ) : !m && !metrics.loading ? (
        <Text
          variant="body"
          color={colors.ink55}
          align="center"
          style={{ marginTop: space.s30, paddingHorizontal: space.gutter }}
        >
          {`No futures contract for ${symbol}.`}
        </Text>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: space.s30 }} showsVerticalScrollIndicator={false}>
          <View style={{ alignItems: 'center', marginTop: space.s22, gap: space.s6 }}>
            {m ? (
              <RollingNumber value={fmtPrice(m.markPx)} variant="priceLg" figure="market" />
            ) : (
              <Placeholder width={150} height={34} style={{ borderRadius: radius.tile }} />
            )}
            {m && changePct !== null ? (
              <DeltaChip
                label={`${changePct >= 0 ? 'up' : 'down'} ${percent(Math.abs(changePct)).replace('+', '')} ${RANGE_WORDS[range]}`}
                tone={pnlTone(changePct)}
                style={{ alignSelf: 'center' }}
              />
            ) : !m ? (
              <Placeholder width={110} height={24} style={{ borderRadius: radius.full }} />
            ) : null}
          </View>

          {hasSeries ? (
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'flex-end',
                marginTop: space.s12,
                paddingHorizontal: space.gutter,
              }}
            >
              <Segmented
                options={CHART_VIEWS}
                value={candleView ? 0 : 1}
                onChange={(v) => setCandleView(v === 0)}
                height={size.segThumbSm}
                style={{ width: CHART_VIEW_W }}
              />
            </View>
          ) : null}

          {hasSeries ? (
            <Press
              onPress={() => setCandleView((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={`${name} ${candleView ? 'candlestick' : 'price'} chart, ${range}. Switch to the ${candleView ? 'line' : 'candle'} view.`}
              style={{ marginTop: space.s10, paddingHorizontal: space.gutter }}
            >
              {candleView ? (
                <Candlestick
                  series={series}
                  projection={projection}
                  height={CHART_H}
                  lastPrice={lastPrice}
                  drawIn
                />
              ) : (
                <AreaChart
                  data={closes}
                  height={CHART_H}
                  color={(windowPct ?? 0) < 0 ? colors.down : colors.up}
                  endDot
                  drawIn
                />
              )}
            </Press>
          ) : (
            <View style={{ height: CHART_H, marginTop: space.s18, paddingHorizontal: space.gutter, justifyContent: 'center' }}>
              {candles.error ? (
                <ErrorState error={candles.error} onRetry={candles.reload} />
              ) : candles.loading ? (
                <Placeholder height={CHART_H} style={{ borderRadius: radius.tile }} />
              ) : (
                <Text variant="body" color={colors.ink55} align="center">
                  No candles for this range yet.
                </Text>
              )}
            </View>
          )}

          <PillRow style={{ marginTop: space.s16 }} contentPadding={space.gutter}>
            {RANGES.map((r) => (
              <Pill key={r} label={r} selected={r === range} onPress={() => setRange(r)} />
            ))}
          </PillRow>

          <View style={{ marginTop: space.s22, paddingHorizontal: space.gutter }}>
            {m ? (
              <ContractStats m={m} />
            ) : (
              <Placeholder height={STATS_H} style={{ borderRadius: radius.panel }} />
            )}
            <Text variant="footnote" color={colors.ink55} align="center" style={{ marginTop: space.s16 }}>
              {`Market data from ${m?.venue ?? 'the venue'}. xorr does not trade futures.`}
            </Text>
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}

/**
 * The four figures under the chart.
 *
 * It owns the funding clock, so only this block re-renders every second — not the screen, and not the
 * chart above it. The clock counts to the venue's own next payment, `nextFundingAt`, and rolls on by the
 * venue's own interval once that passes. It used to count to the top of the phone's hour whatever the
 * venue said, and the rate was labelled "per hour" whatever interval it was quoted for.
 */
function ContractStats({ m }: { m: PerpMetrics }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const next = nextPaymentAt(m.nextFundingAt, m.fundingIntervalHours, now);
  const fundingIn = Math.max(0, Math.round((next - now) / 1000));

  return (
    <StatGrid
      items={[
        // The venue's figures, public to anyone: none of them hides while balances are hidden.
        {
          label: `Funding / ${intervalWords(m.fundingIntervalHours).unit}`,
          value: percent(m.fundingRate * 100, 4),
          figure: 'market',
        },
        { label: 'Next funding', value: countdown(fundingIn) },
        { label: 'Open interest', value: compactMoney(m.openInterestUsd), figure: 'market' },
        { label: '24h volume', value: compactMoney(m.dayVolumeUsd), figure: 'market' },
      ]}
    />
  );
}
