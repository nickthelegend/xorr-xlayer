/**
 * Every price this deployment has actually recorded for an equity.
 *
 * The tokenized equities have no market-data feed. Their price comes from probing a live route, and
 * every probe is written to `price_observations` — so the only history that exists for them is the
 * history this executor made by looking. That is a genuinely unusual property and the screen says it
 * in plain words rather than presenting the series as though a vendor supplied it.
 *
 * When the record began is rendered, always. A chart with eleven points looks like a chart with
 * eleven thousand unless something states when the record began.
 *
 * Anything that is not an equity has no record here, and the executor says so with a 404. That is an
 * answer, not a failure: /oracle/BTC read "That did not load. BTC is not a tokenized equity", so it
 * now says what the screen is for and where the equities are.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  AreaChart,
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  Placeholder,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  space,
} from '@/ui';
import { price as fmtPrice, when } from '@/format';
import { ApiError } from '@/data/apiError';
import { useAsync } from '@/data/useAsync';
import { system } from '@/data/system';

const CHART_H = 140;

export default function Oracle() {
  const goBack = useGoBack();
  const router = useRouter();
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  const { data, loading, error, reload } = useAsync(() => system.observed(symbol!), [symbol]);
  const notAnEquity = error instanceof ApiError && error.status === 404;

  const points = data?.points ?? [];
  const series = points.map((p) => p.usd);
  // The provenance line, from the readings themselves. The executor's own note carries an ISO timestamp.
  const since =
    data?.observedSince != null
      ? new Date(data.observedSince).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : undefined;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">{symbol}</Text>} />
        {notAnEquity ? null : (
          <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
            Every price we recorded for it.
          </Text>
        )}
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {notAnEquity ? (
          <EmptyState
            text="Recorded prices are kept for tokenized stocks."
            actionLabel="See stocks"
            onAction={() => router.push('/stocks')}
          />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <Placeholder height={CHART_H} />
        ) : points.length === 0 ? (
          <EmptyState text="No readings yet." />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30, gap: space.s12 }}
          >
            {series.length > 1 ? (
              <AreaChart data={series} height={CHART_H} color={colors.ink65} endDot />
            ) : null}

            <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
              {/*
                The provenance line, always. A short series and a long one look identical without
                a statement of when the record started.
              */}
              <Text variant="secondarySm" color={colors.ink65}>
                {`${points.length} ${points.length === 1 ? 'reading' : 'readings'} since ${since}.`}
              </Text>
            </SheetCard>

            {points
              .slice()
              .reverse()
              .slice(0, 40)
              .map((p) => (
                <View
                  key={p.at}
                  style={{ flexDirection: 'row', justifyContent: 'space-between' }}
                >
                  <Text variant="secondarySm" color={colors.ink55}>
                    {when(new Date(p.at).getTime())}
                  </Text>
                  <Text variant="secondarySm">{fmtPrice(p.usd)}</Text>
                </View>
              ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
