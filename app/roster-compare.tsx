/**
 * The four agents side by side, on the numbers rather than the pitch.
 *
 * The roster shows cards you scroll past one at a time, which is the wrong shape for choosing:
 * comparing a win rate you can see against one you are remembering is how people end up hiring the
 * agent with the best card rather than the best record.
 *
 * Every figure carries the same disclaimer the roster carries, once, at the bottom — not per row,
 * because four copies of a caveat is a caveat nobody reads.
 *
 * A read that failed says so. `listAgents` fell back to four fixture personas when /agents could not
 * answer, so the ErrorState below could never show and an outage read as four agents with no record;
 * it throws now. And an agent that has not traded shows no win rate — "0%" over nothing is not one.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  AgentOrb,
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Press,
  Screen,
  SheetCard,
  Text,
  colors,
  pnlTone,
  radius,
  size,
  space,
  type FigureKind,
} from '@/ui';
import { agentGradient } from '@/design/gradients';
import { signedPnl, winRate } from '@/state/derived';
import { useAsync } from '@/data/useAsync';
import { repos } from '@/data';

export default function RosterCompare() {
  const goBack = useGoBack();
  const router = useRouter();
  const { data, loading, error, reload } = useAsync(() => repos.bot.listAgents(), []);

  const agents = data ?? [];

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Compare agents</Text>} />
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <LoadingRows count={4} height={size.rowLg} />
        ) : agents.length === 0 ? (
          <EmptyState text="No agents to compare yet." />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30, gap: space.s10 }}
          >
            {agents.map((a) => (
              <Press
                key={a.id}
                onPress={() => router.push(`/agent/${a.personaId ?? a.id}`)}
                accessibilityRole="button"
                accessibilityLabel={`${a.name}. ${a.role}`}
              >
                <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s12 }}>
                    <AgentOrb gradient={agentGradient(a.name)} identity={a.name} size={52} face />
                    <View style={{ flex: 1 }}>
                      <Text variant="rowPrimary">{a.name}</Text>
                      <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s2 }}>
                        {a.role}
                      </Text>
                    </View>
                    {a.hired ? (
                      <Text variant="footnote" color={colors.up}>
                        hired
                      </Text>
                    ) : null}
                  </View>

                  <View style={{ flexDirection: 'row', gap: space.s20, marginTop: space.s14 }}>
                    <Cell label="30d" value={signedPnl(a.pnl30d)} tone={pnlTone(a.pnl30d)} figure="own" />
                    <Cell label="Won" value={winRate(a)} />
                    <Cell label="Trades" value={String(a.trades)} />
                  </View>
                </SheetCard>
              </Press>
            ))}

            <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
              {/* Once, at the bottom. Four copies of a caveat is a caveat nobody reads. */}
              Past performance of a strategy says nothing about tomorrow.
            </Text>
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}

/** One figure of an agent's record. Its 30-day P&L is money made in this wallet, and hides while balances are hidden. */
function Cell({
  label,
  value,
  tone,
  figure,
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down' | 'neutral';
  figure?: FigureKind;
}) {
  return (
    <View style={{ gap: space.s2 }}>
      <Text variant="footnote" color={colors.ink55}>
        {label}
      </Text>
      <Text
        variant="rowPrimary"
        color={tone === 'up' ? colors.up : tone === 'down' ? colors.down : colors.ink}
        figure={figure}
      >
        {value}
      </Text>
    </View>
  );
}
