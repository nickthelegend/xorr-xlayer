/**
 * Every proposal the bot has made, and what you did about it.
 *
 * The chat renders the current proposal and forgets the rest, so the record of the whole
 * approve-before-execute loop existed only as rows in a table. This is that record — and the
 * interesting rows are the expired ones, because an expiry is the bot asking and nobody answering,
 * which is a different fact from either an approval or a skip and is visible nowhere else.
 *
 * The payload is rendered as it was stored. Re-pricing an old proposal against today's market would
 * rewrite what was actually put in front of someone, which is the one thing a record of decisions
 * must never do.
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Pill,
  PillRow,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { clock, when } from '@/format';
import { useAsync } from '@/data/useAsync';
import { system, type ProposalRow } from '@/data/system';

const FILTERS = ['All', 'Approved', 'Skipped', 'Expired'] as const;

function toneFor(decision: ProposalRow['decision']): string {
  if (decision === 'approve') return colors.up;
  if (decision === 'skip') return colors.ink40;
  if (decision === 'expired') return colors.warn;
  return colors.ink65;
}

function labelFor(decision: ProposalRow['decision']): string {
  if (decision === 'approve') return 'Approved';
  if (decision === 'skip') return 'Skipped';
  if (decision === 'expired') return 'Expired unanswered';
  return 'Awaiting you';
}

/** The proposal's own words, if it stored any. Never invented when it did not. */
function summarise(payload: Record<string, unknown>): string | null {
  const action = typeof payload.action === 'string' ? payload.action : null;
  const notional = typeof payload.notional === 'string' ? payload.notional : null;
  if (action && notional) return `${action} · ${notional}`;
  return action ?? notional;
}

export default function Proposals() {
  const goBack = useGoBack();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');
  const { data, loading, error, reload } = useAsync(() => system.proposals(), []);

  const rows = useMemo(() => {
    const all = data ?? [];
    if (filter === 'All') return all;
    if (filter === 'Approved') return all.filter((p) => p.decision === 'approve');
    if (filter === 'Skipped') return all.filter((p) => p.decision === 'skip');
    return all.filter((p) => p.decision === 'expired');
  }, [data, filter]);

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Proposals</Text>} />
      </View>

      <PillRow style={{ marginTop: space.s14 }} contentPadding={space.gutter}>
        {FILTERS.map((f) => (
          <Pill key={f} label={f} selected={f === filter} onPress={() => setFilter(f)} />
        ))}
      </PillRow>

      <Fill style={{ marginTop: space.s10 }}>
        {error ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <ErrorState error={error} onRetry={reload} />
          </View>
        ) : loading && !data ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <LoadingRows count={5} height={size.rowLg} />
          </View>
        ) : rows.length === 0 ? (
          <EmptyState
            text={filter === 'All' ? 'The bot has not proposed anything yet.' : `Nothing ${filter.toLowerCase()}.`}
          />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: space.gutter,
              paddingBottom: space.s30,
              gap: space.s10,
            }}
          >
            {rows.map((p) => {
              const summary = summarise(p.payload);
              return (
                <SheetCard key={p.id} bordered borderRadius={radius.panel} padding={space.s14}>
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                    }}
                  >
                    <Text variant="rowPrimary">{p.agent}</Text>
                    <Text variant="control" color={toneFor(p.decision)}>
                      {labelFor(p.decision)}
                    </Text>
                  </View>

                  {/* Only when the stored payload actually carried one. */}
                  {summary ? (
                    <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s8 }}>
                      {summary}
                    </Text>
                  ) : null}

                  <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s8 }}>
                    {when(new Date(p.at).getTime())}
                    {p.decidedAt
                      ? ` · answered ${clock(new Date(p.decidedAt).getTime())}`
                      : ''}
                  </Text>
                </SheetCard>
              );
            })}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
