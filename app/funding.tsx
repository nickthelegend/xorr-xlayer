/**
 * Funding — who is paying whom across the busiest futures contracts (2026-09-13).
 *
 * The contract screen shows one market. Funding is a cross-sectional signal — it says which side of
 * the market is crowded — and reading it one contract at a time is how you miss that everything is
 * paying longs at once.
 *
 * Neutral ink throughout: funding is a cost of holding a side, not a profit or a loss.
 *
 * The interval is the venue's, not this file's. "Paid every hour", "/ h" and a yearly figure of
 * rate × 24 × 365 were written here as facts, while the list itself carries no interval. The venue's
 * contract read does, and the venue pays every contract on one clock, so the busiest contract's interval
 * is asked for rather than assumed.
 */
import React, { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Price,
  Row,
  Screen,
  Text,
  colors,
  size,
  space,
} from '@/ui';
import { percent, price as fmtPrice } from '@/format';
import { useAsync } from '@/data/useAsync';
import { repos } from '@/data';
import { intervalWords, paymentsPerYear } from '@/markets/funding';

/** The busiest contracts — where funding says the most about positioning. */
const ROWS = 20;

export default function Funding() {
  const goBack = useGoBack();
  const router = useRouter();
  const { data, loading, error, reload } = useAsync(() => repos.perps.markets(), []);
  const rows = useMemo(() => (data?.markets ?? []).slice(0, ROWS), [data]);

  const busiest = rows[0]?.symbol;
  const clock = useAsync(
    () => (busiest ? repos.perps.metrics(busiest) : Promise.resolve(null)),
    [busiest],
  );
  const hours = clock.data?.fundingIntervalHours;
  const words = hours ? intervalWords(hours) : undefined;

  const failure = error ?? clock.error;
  const retry = () => {
    if (error) reload();
    if (clock.error) clock.reload();
  };

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Funding</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          {words ? `Paid ${words.every}. Positive means longs pay shorts.` : 'Positive means longs pay shorts.'}
        </Text>
      </View>

      <Fill style={{ marginTop: space.s12, paddingHorizontal: space.gutter }}>
        {failure ? (
          <ErrorState error={failure} onRetry={retry} />
        ) : (loading && !data) || (busiest !== undefined && clock.loading) ? (
          <LoadingRows count={8} height={size.rowLg} />
        ) : rows.length === 0 ? (
          <EmptyState text="No contracts listed right now." />
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.s30 }}>
            {rows.map((m, i) => (
              <Row
                key={m.symbol}
                height={size.rowLg}
                divider={i < rows.length - 1}
                onPress={() => router.push(`/perp/${m.symbol}`)}
                title={m.symbol}
                secondary={fmtPrice(m.markPx)}
                figure="market"
                value={
                  <Price variant="rowPrimary" figure="market">
                    {`${percent(m.fundingRate * 100, { digits: 4, explicitSign: true })}${words ? ` / ${words.short}` : ''}`}
                  </Price>
                }
                // A year of the payments the venue actually makes, at today's rate. Without the interval there is no year to state.
                delta={
                  hours
                    ? `${percent(m.fundingRate * 100 * paymentsPerYear(hours), { digits: 1, explicitSign: true })} a year`
                    : undefined
                }
              />
            ))}
            <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s14 }}>
              {`Rates from ${data?.venue ?? 'the venue'}. xorr does not trade futures.`}
            </Text>
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
