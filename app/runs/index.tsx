/**
 * Every run, including the ones that did nothing.
 *
 * This is the table the whole product rests on — "the bot trades unattended and every run is
 * recorded, including the ones it refused" — and it had no screen. The leaderboard read it, the
 * alert evaluator read it, one verification check counted it. The person whose money it is could
 * not look at it.
 *
 * Refusals are shown at the same weight as fills, which is the entire reason to build this rather
 * than a list of trades. `blocked` with "daily cap" next to it is the limit doing its job, and it
 * is invisible anywhere else in the app.
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Pill,
  PillRow,
  Row,
  Screen,
  Text,
  colors,
  size,
  space,
} from '@/ui';
import { money, quantity, when } from '@/format';
import { useAsync } from '@/data/useAsync';
import { system, type StrategyRunRow } from '@/data/system';
import { labelFigure } from '@/strategies/ladder';

const FILTERS = ['All', 'Filled', 'Refused', 'Skipped', 'Failed'] as const;

/**
 * Green filled, red failed, amber refused — refused is neither a success nor an error. A skip is none of the three: the
 * period had already run, there was nothing to do, or it waits on a yes. It is quiet, not amber.
 */
function toneFor(status: StrategyRunRow['status']): string {
  if (status === 'filled') return colors.up;
  if (status === 'failed') return colors.down;
  if (status === 'pending' || status === 'skipped') return colors.ink40;
  return colors.warn;
}

/** "Refused" is a limit saying no. Skips had their own place under it, which made a quiet day look like a blocked one. */
function matches(run: StrategyRunRow, filter: (typeof FILTERS)[number]): boolean {
  if (filter === 'All') return true;
  if (filter === 'Filled') return run.status === 'filled';
  if (filter === 'Failed') return run.status === 'failed';
  if (filter === 'Skipped') return run.status === 'skipped';
  return run.status === 'blocked';
}

export default function Runs() {
  const goBack = useGoBack();
  const router = useRouter();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');
  const { data, loading, error, reload } = useAsync(() => system.runs(), []);

  const rows = useMemo(() => (data ?? []).filter((r) => matches(r, filter)), [data, filter]);

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Runs</Text>} />
      </View>

      <PillRow style={{ marginTop: space.s14 }} contentPadding={space.gutter}>
        {FILTERS.map((f) => (
          <Pill key={f} label={f} selected={f === filter} onPress={() => setFilter(f)} />
        ))}
      </PillRow>

      <Fill style={{ marginTop: space.s10, paddingHorizontal: space.gutter }}>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <LoadingRows count={7} height={size.rowLg} />
        ) : rows.length === 0 ? (
          <EmptyState
            text={
              filter === 'All'
                ? 'No strategy has run yet.'
                : `No ${filter.toLowerCase()} runs.`
            }
          />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30 }}
          >
            {rows.map((r) => (
              <Row
                key={r.id}
                height={size.rowLg}
                onPress={() => router.push(`/runs/${r.id}`)}
                title={r.symbol}
                secondary={`${r.label} · ${when(new Date(r.at).getTime())}`}
                // Hidden balances hide the units it filled, and the label's size; the date beside the label stays.
                figure="units"
                secondaryFigure={labelFigure(r.kind)}
                value={
                  <Text variant="rowPrimary" color={toneFor(r.status)} figure="own">
                    {/*
                      The number where there is one, the status where there is not. A refused run
                      showing "$0.00" would claim it traded nothing; it did not trade at all.
                    */}
                    {r.status === 'filled' && r.usd !== null
                      ? money(r.usd)
                      : r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                  </Text>
                }
                delta={r.status === 'filled' && r.units !== null ? quantity(r.units) : undefined}
              />
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
