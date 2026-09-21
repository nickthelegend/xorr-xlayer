/**
 * The strategy book — all 313, including the ones that did not work.
 *
 * These were measured by the research engine that preceded this app: every registered rule replayed over
 * two years of hourly candles on nine symbols, split in half, with the second half never seen during
 * design. What is listed is that second half.
 *
 * The failures are in the list on purpose. A book that showed only its winners would be a different claim
 * — that the method finds edges — when the honest one is that it finds a few and rules out the rest, and
 * the ratio is the interesting number. So `archive` is a filter, not a deletion, and the header says how
 * many of each there are before you choose.
 *
 * Trusted-only is on by default. Under 30 unseen trades a return is real and the interval around it is
 * wide, and a first screen full of two-percent returns over three trades would be the most misleading
 * honest thing this app could draw.
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Pill,
  PillRow,
  Row,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { percent } from '@/format';
import { useAsync } from '@/data/useAsync';
import { system } from '@/data/system';
import type { BookSort, StrategyTier } from '@/data/strategyBook';

type Filter = StrategyTier | 'all';

const FILTERS: readonly { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'verified', label: 'Verified' },
  { key: 'measured', label: 'Measured' },
  { key: 'archive', label: 'Archive' },
];

const SORTS: readonly { key: BookSort; label: string }[] = [
  { key: 'return', label: 'Return' },
  { key: 'sharpe', label: 'Sharpe' },
  { key: 'drawdown', label: 'Drawdown' },
  { key: 'trades', label: 'Trades' },
];

export default function Playbook() {
  const goBack = useGoBack();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<BookSort>('return');
  const [trustedOnly, setTrustedOnly] = useState(true);

  const book = useAsync(
    () => system.strategyBook({ tier: filter === 'all' ? undefined : filter, trusted: trustedOnly, sort }),
    [filter, sort, trustedOnly],
  );
  const rows = useMemo(() => book.data?.rows ?? [], [book.data]);
  const counts = book.data?.counts;

  return (
    <Screen>
      <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Strategies</Text>} />
      <Fill>
        <ScrollView contentContainerStyle={{ paddingBottom: space.s30 }}>
          <View style={{ paddingHorizontal: space.gutter, gap: space.s12 }}>
            <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
              <Text variant="secondary" color={colors.ink65}>
                {counts
                  ? `${counts.total} rules measured on data they had never seen. ${counts.verified} passed all four tests, ${counts.measured} measured positive, ${counts.archive} did not hold.`
                  : 'Rules measured on data they had never seen.'}
              </Text>
            </SheetCard>

            <PillRow>
              {FILTERS.map((f) => (
                <Pill key={f.key} label={f.label} selected={filter === f.key} onPress={() => setFilter(f.key)} />
              ))}
            </PillRow>
            <PillRow>
              {/*
                The sample toggle comes FIRST, before the sorts.
                
                It defaults to on, which means the screen opens already hiding two thirds of the book — and at
                the end of a scrolling row it was off the right edge of a phone, so the control explaining that
                was the one control you could not see. The caption below says the same thing in words, because a
                pill that is scrolled past still has to be accounted for.
              */}
              <Pill
                label={trustedOnly ? '30+ trades' : 'Any sample'}
                selected={trustedOnly}
                onPress={() => setTrustedOnly((v) => !v)}
              />
              {SORTS.map((o) => (
                <Pill key={o.key} label={o.label} selected={sort === o.key} onPress={() => setSort(o.key)} />
              ))}
            </PillRow>

            {counts ? (
              <Text variant="footnote" color={colors.ink55}>
                Showing {rows.length} of {counts.total}
                {trustedOnly ? ' — the ones with at least 30 trades on the unseen half' : ''}
                {filter === 'all' ? '' : `, tier ${filter}`}.
              </Text>
            ) : null}
          </View>

          <View style={{ paddingHorizontal: space.gutter, marginTop: space.s12 }}>
            {book.error ? (
              <ErrorState error={book.error} onRetry={book.reload} />
            ) : book.loading && !book.data ? (
              <LoadingRows count={8} height={size.rowLg} />
            ) : rows.length === 0 ? (
              <Text variant="body" color={colors.ink55} style={{ marginTop: space.s16 }}>
                {trustedOnly
                  ? 'Nothing here has 30 trades on the unseen half. Tap “Any sample” to see the thin ones.'
                  : 'Nothing in the book matches that.'}
              </Text>
            ) : (
              rows.map((r, i) => (
                <Row
                  key={r.slug}
                  height={size.rowLg}
                  divider={i < rows.length - 1}
                  onPress={() => router.push(`/playbook/${r.slug}`)}
                  title={r.slug.replace(/_/g, ' ')}
                  secondary={
                    r.trades === 0
                      ? 'No trades on the unseen half'
                      : `${r.trades} unseen trades${r.survives ? ' · passed all four' : ''}${r.trusted ? '' : ' · thin sample'}`
                  }
                  value={
                    r.returnPct === null ? (
                      <Text variant="rowPrimary" color={colors.ink55}>
                        Not measured
                      </Text>
                    ) : (
                      percent(r.returnPct, { digits: 2 })
                    )
                  }
                  figure="market"
                />
              ))
            )}
          </View>

          {book.data ? (
            <View style={{ paddingHorizontal: space.gutter, marginTop: space.s16 }}>
              <Text variant="footnote" color={colors.ink55}>
                {book.data.window.bars.toLocaleString('en-US')} {book.data.window.interval} bars across{' '}
                {book.data.window.symbols.length} symbols, split in half. Returns are the second half — the one the
                rule never saw — after {book.data.window.feeBpsPerSide} bps a side. Past behaviour over recorded
                candles, not a forecast.
              </Text>
              <Button
                label="How the book was measured"
                variant="ghost"
                onPress={() => router.push('/sources')}
                style={{ marginTop: space.s12 }}
              />
            </View>
          ) : null}
        </ScrollView>
      </Fill>
    </Screen>
  );
}
