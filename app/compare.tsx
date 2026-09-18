/**
 * Two instruments over the same window.
 *
 * Every chart in the app is one asset alone, which answers "did this go up" and never "did this go
 * up more than that". Relative performance is the question people actually have when they hold two
 * things, and it needs both series normalised to the same start — an absolute overlay of a
 * seventy-thousand-dollar asset and a one-dollar one is a flat line and a spike.
 *
 * Normalised to percent from the window's first open, which is why the axis is a percentage and not a
 * price. The two series may have different bar counts if one market has less history; both are drawn
 * over however many bars they have, and the shorter one simply stops.
 *
 * The window was never stated, and the pills were every tradable symbol — eight of them shares with no
 * candle history, which could only ever answer "No history". The pills are what the feed prices now,
 * the window is said once, and a failed read shows as one, with a retry for every read that failed.
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  AreaChart,
  ErrorState,
  Fill,
  HeaderBar,
  Pill,
  PillRow,
  Placeholder,
  Price,
  Screen,
  SheetCard,
  Text,
  colors,
  pnlTone,
  radius,
  size,
  space,
  toCandles,
} from '@/ui';
import { percent } from '@/format';
import { HISTORY_DAYS, type HistoryRange } from '@/data/marketData';
import { system } from '@/data/system';
import { useAsync } from '@/data/useAsync';
import { historySeries, stillWarming, type Series } from '@/markets/series';
import { useLiveRead } from '@/markets/useLiveRead';

const CHART_H = 130;
/** Enough history to be a comparison, short enough that both markets have it. */
const RANGE: HistoryRange = '1M';
const WINDOW = `past ${HISTORY_DAYS[RANGE]} days`;

/**
 * The gap between two percentage changes.
 *
 * `percent()` would render this with a `%` sign, and it is not a percentage — the difference
 * between a rise of four percent and a rise of one percent is three percentage POINTS, not three
 * percent. Conflating the two is the most common way a comparison like this misleads, so it gets
 * its own formatter rather than borrowing one that would label it wrongly.
 */
function points(n: number): string {
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} points`;
}

/** Percent change from the window's first open, so two very different prices share an axis and both start at zero. */
function normalise(series: Series<HistoryRange> | undefined): number[] {
  const candles = toCandles(series?.bars ?? []);
  const start = candles[0]?.open;
  if (!start) return [];
  return [start, ...candles.map((c) => c.close)].map((c) => ((c - start) / start) * 100);
}

export default function Compare() {
  const goBack = useGoBack();
  const [left, setLeft] = useState<string>('WETH');
  const [right, setRight] = useState<string>('CBBTC');

  // What can be compared: what the price feed has history for, asked of the executor.
  const symbols = useAsync(() => system.symbols(), []);
  const a = useLiveRead(() => historySeries(left, RANGE), [left], stillWarming);
  const b = useLiveRead(() => historySeries(right, RANGE), [right], stillWarming);

  // Each side's own symbol only — never the previous pick's line under the new name while it loads.
  const shownA = a.data?.symbol === left ? a.data : undefined;
  const shownB = b.data?.symbol === right ? b.data : undefined;
  const seriesA = useMemo(() => normalise(shownA), [shownA]);
  const seriesB = useMemo(() => normalise(shownB), [shownB]);

  const changeA = seriesA.at(-1);
  const changeB = seriesB.at(-1);

  const error = symbols.error ?? a.error ?? b.error;
  /** Every read that failed. The retry used to reload the first chart alone. */
  const retry = () => {
    if (symbols.error) symbols.reload();
    if (a.error) a.reload();
    if (b.error) b.reload();
  };

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Compare</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          {`Change over the ${WINDOW}, side by side.`}
        </Text>
      </View>

      <Fill style={{ marginTop: space.s12 }}>
        {error ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <ErrorState error={error} onRetry={retry} />
          </View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.s30 }}>
            <Side
              label="First"
              symbol={left}
              pills={symbols.data}
              onPick={setLeft}
              series={seriesA}
              change={changeA}
              loading={a.loading && !shownA}
              line={colors.ink}
            />
            <Side
              label="Second"
              symbol={right}
              pills={symbols.data}
              onPick={setRight}
              series={seriesB}
              change={changeB}
              loading={b.loading && !shownB}
              line={colors.ink55}
            />

            {changeA !== undefined && changeB !== undefined ? (
              <View style={{ paddingHorizontal: space.gutter, marginTop: space.s16 }}>
                <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                  <Text variant="footnote" color={colors.ink55}>
                    GAP
                  </Text>
                  {/*
                    Percentage POINTS, not percent. The difference between two percentage changes is
                    not itself a percentage change, and calling it one is the most common way this
                    kind of comparison misleads.
                  */}
                  <Text variant="rowPrimary" style={{ marginTop: space.s4 }}>
                    {points(Math.abs(changeA - changeB))}
                  </Text>
                  <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
                    {changeA === changeB
                      ? `Level over the ${WINDOW}.`
                      : `${changeA > changeB ? left : right} is ahead over the ${WINDOW}.`}
                  </Text>
                </SheetCard>
              </View>
            ) : null}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}

function Side({
  label,
  symbol,
  pills,
  onPick,
  series,
  change,
  loading,
  line,
}: {
  label: string;
  symbol: string;
  /** Undefined until the executor has said what it prices. */
  pills: readonly string[] | undefined;
  onPick: (s: string) => void;
  series: number[];
  change: number | undefined;
  loading: boolean;
  /**
   * The line's ink. Neutral on purpose: the first line was always green, so a first pick that fell
   * was drawn — and its change printed — in profit green.
   */
  line: string;
}) {
  return (
    <View style={{ marginTop: space.s16 }}>
      <View style={{ paddingHorizontal: space.gutter }}>
        <Text variant="footnote" color={colors.ink55}>
          {label.toUpperCase()}
        </Text>
      </View>

      {pills ? (
        <PillRow style={{ marginTop: space.s8 }} contentPadding={space.gutter}>
          {pills.map((t) => (
            <Pill key={t} label={t} selected={t === symbol} onPress={() => onPick(t)} />
          ))}
        </PillRow>
      ) : (
        <View style={{ paddingHorizontal: space.gutter, marginTop: space.s8 }}>
          <Placeholder height={size.pillH} width="70%" />
        </View>
      )}

      <View style={{ paddingHorizontal: space.gutter, marginTop: space.s12 }}>
        {loading ? (
          <Placeholder height={CHART_H} />
        ) : series.length < 2 ? (
          <Text variant="secondarySm" color={colors.ink55}>
            No history for {symbol}.
          </Text>
        ) : (
          <>
            <AreaChart data={series} height={CHART_H} color={line} endDot />
            <Price
              variant="rowPrimary"
              tone={change === undefined ? 'neutral' : pnlTone(change)}
              style={{ marginTop: space.s8 }}
              figure="market"
            >
              {`${symbol} ${change === undefined ? '—' : percent(change, { explicitSign: true })}`}
            </Price>
          </>
        )}
      </View>
    </View>
  );
}
