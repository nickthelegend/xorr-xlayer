/**
 * What the delegation has spent, day by day, as the chain recorded it.
 *
 * `/limits` answers "how much is left today". This answers "how much does it usually use", which is
 * the question that tells you whether the cap is doing anything — a cap of two thousand against
 * days that never exceed three hundred is a control that has never once bound.
 *
 * From the subgraph's `dailySpends`, so these are totals the contract emitted rather than our own
 * tally of what we asked it to do — provided the index is about this deployment. `/graph/health`
 * says whether it is, and it is asked first: an index of another contract answers just as
 * confidently, and on the fork build, where it follows the Sepolia deployment, its days were shown
 * as this wallet's and its silence as this wallet having spent nothing.
 */
import React, { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  NoteStrip,
  Screen,
  Text,
  colors,
  size,
  space,
} from '@/ui';
import { money } from '@/format';
import { useAsync } from '@/data/useAsync';
import { indexDay, system } from '@/data/system';

const USDC_DECIMALS = 6;
const BAR_H = 8;

export default function Spend() {
  const goBack = useGoBack();
  const { data, loading, error, reload } = useAsync(() => system.graphActivity(), []);
  const index = useAsync(() => system.graphHealth(), []);

  const days = useMemo(
    () =>
      (data?.daily ?? []).map((d) => ({
        day: d.day,
        usd: Number(d.total) / 10 ** USDC_DECIMALS,
        trades: Number(d.tradeCount),
      })),
    [data],
  );

  /* Scaled to the busiest day, so the bars compare to each other rather than to a cap that may
     have changed since. */
  const peak = useMemo(() => days.reduce((m, d) => Math.max(m, d.usd), 0), [days]);
  const failed = error ?? index.error;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Spend</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          What your permission spent, day by day.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {failed ? (
          <ErrorState
            error={failed}
            onRetry={() => {
              reload();
              index.reload();
            }}
          />
        ) : (loading && !data) || (index.loading && !index.data) ? (
          <LoadingRows count={6} height={size.row} />
        ) : index.data?.indexesThisDeployment === false ? (
          /* One line in place of the rows: whatever the index holds is another contract's, not this wallet's here. */
          <NoteStrip kind="risk">This index follows a different deployment.</NoteStrip>
        ) : days.length === 0 ? (
          <EmptyState text="No spending indexed yet." />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30 }}
          >
            {days.map((d) => (
              <View key={d.day} style={{ marginTop: space.s16 }}>
                <View
                  style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}
                >
                  {/* A date, not the index's day number ("20345"). */}
                  <Text variant="rowPrimary">{indexDay(d.day)}</Text>
                  <Text variant="rowPrimary" figure="own">
                    {money(d.usd)}
                  </Text>
                </View>
                <View
                  style={{
                    height: BAR_H,
                    borderRadius: BAR_H / 2,
                    backgroundColor: colors.control,
                    marginTop: space.s8,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      width: `${peak > 0 ? (d.usd / peak) * 100 : 0}%`,
                      height: '100%',
                      borderRadius: BAR_H / 2,
                      backgroundColor: colors.ink,
                    }}
                  />
                </View>
                <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s6 }}>
                  {d.trades === 1 ? 'one trade' : `${d.trades} trades`}
                </Text>
              </View>
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
