/**
 * One strategy: what it is set to do, and what it has actually done.
 *
 * The strategies tab lists them and the creators make them; nothing showed a live one in full.
 * Parameters and outcomes on one screen is the point — a DCA set to buy fifty dollars weekly that
 * has filled twice and been refused nine times is a different object from the same DCA with nine
 * fills, and the list row is identical for both.
 *
 * Runs are filtered to this strategy, which the list screen cannot do. They come from the wallet's
 * latest runs across every strategy — `/runs` has no per-strategy filter and answers at most 200 — so
 * when that window is full, the count says which window it counted.
 */
import React, { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  ErrorState,
  Fill,
  HeaderBar,
  Placeholder,
  Row,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { clock, day, money, quantity } from '@/format';
import { useAsync } from '@/data/useAsync';
import { repos } from '@/data';
import { system, type StrategyRunRow } from '@/data/system';
import { recordEntries, recordFigure } from '@/state/derived';
import { kindLabel, labelFigure } from '@/strategies/ladder';

/** The most `/runs` answers with. Fewer than this back, and it was every run the wallet has. */
const RUNS_WINDOW = 200;

function toneFor(status: StrategyRunRow['status']): string {
  if (status === 'filled') return colors.up;
  if (status === 'failed') return colors.down;
  if (status === 'pending') return colors.ink40;
  return colors.warn;
}

export default function StrategyDetail() {
  const goBack = useGoBack();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const strategies = useAsync(() => repos.strategies.list(), []);
  const runs = useAsync(() => system.runs(RUNS_WINDOW), []);

  const strategy = (strategies.data ?? []).find((s) => s.id === id);
  const mine = useMemo(
    () => (runs.data ?? []).filter((r) => r.strategyId === id),
    [runs.data, id],
  );

  const filled = mine.filter((r) => r.status === 'filled');
  // What its fills came to, in dollars. Not "spent": an exit rule's fills are sales.
  const filledUsd = filled.reduce((sum, r) => sum + (r.usd ?? 0), 0);
  // A full window may have cut off this strategy's older runs, so the count names the window.
  const windowFull = (runs.data?.length ?? 0) >= RUNS_WINDOW;
  const entries = strategy ? recordEntries(strategy.params) : [];

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Strategy</Text>} />
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {strategies.error ? (
          <ErrorState error={strategies.error} onRetry={strategies.reload} />
        ) : strategies.loading && !strategies.data ? (
          <Placeholder height={160} />
        ) : !strategy ? (
          <Text variant="body" color={colors.ink55}>
            No strategy with that id.
          </Text>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30, gap: space.s10 }}
          >
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <Text variant="footnote" color={colors.ink55}>
                {kindLabel(strategy.kind).toUpperCase()} · {strategy.state.toUpperCase()}
              </Text>
              <Text variant="screenTitle" style={{ marginTop: space.s6 }} figure={labelFigure(strategy.kind)}>
                {strategy.label}
              </Text>
              <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
                {strategy.symbol}
              </Text>
            </SheetCard>

            <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
              <Text variant="footnote" color={colors.ink55}>
                SET TO
              </Text>
              {/*
                The parameters as stored, row by row through `recordEntries`. A strategy's params are
                kind-specific — a grid has rungs, a rebalance has targets — and `String(value)` printed
                the nested ones as `[object Object]` and a list of weights as `55,30,15`.
              */}
              {entries.length === 0 ? (
                <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s10 }}>
                  —
                </Text>
              ) : (
                entries.map((e) => (
                  <View
                    key={e.key}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      gap: space.s12,
                      marginTop: space.s10,
                    }}
                  >
                    <Text variant="secondarySm" color={colors.ink65}>
                      {e.label}
                    </Text>
                    <Text variant="secondarySm" style={{ flexShrink: 1, textAlign: 'right' }} figure={recordFigure(e)}>
                      {e.value}
                    </Text>
                  </View>
                ))
              )}
            </SheetCard>

            <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
              <Text variant="footnote" color={colors.ink55}>
                HAS DONE
              </Text>
              {/*
                A read that failed is not a strategy that did nothing. This printed "0 filled · 0 did
                not" and "$0.00 spent" whenever /runs failed.
              */}
              {runs.error && !runs.data ? (
                <ErrorState error={runs.error} onRetry={runs.reload} />
              ) : !runs.data ? (
                <Placeholder height={44} style={{ marginTop: space.s8 }} />
              ) : (
                <>
                  <Text variant="rowPrimary" style={{ marginTop: space.s6 }}>
                    {filled.length} filled · {mine.length - filled.length} did not
                  </Text>
                  <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }} figure="own">
                    {windowFull
                      ? `${money(filledUsd)} across its fills, in your latest ${RUNS_WINDOW} runs.`
                      : `${money(filledUsd)} across its fills.`}
                  </Text>
                </>
              )}
            </SheetCard>

            {mine.slice(0, 20).map((r) => (
              <Row
                key={r.id}
                height={size.rowLg}
                onPress={() => router.push(`/runs/${r.id}`)}
                title={day(new Date(r.at).getTime())}
                secondary={r.error ?? clock(new Date(r.at).getTime())}
                value={
                  <Text variant="rowPrimary" color={toneFor(r.status)} figure="units">
                    {r.status === 'filled' && r.units !== null ? quantity(r.units) : r.status}
                  </Text>
                }
              />
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
