/**
 * The limits each agent is holding itself to.
 *
 * `riskLimits` is persisted per agent — a most-per-trade and a most-per-day, validated by
 * `PATCH /agents/:id` and enforced by the executor on every run of a strategy that agent runs. Nothing
 * else shows all four together, which is the only way to notice that one of them is carrying a limit
 * far looser than the rest.
 *
 * Rendered through `recordEntries` rather than a layout written for those two fields. Rows stored
 * before the server validated them can carry any shape, a fixed layout would silently drop whatever it
 * did not expect, and `String(value)` printed anything nested as `[object Object]`.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  AgentOrb,
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { agentGradient } from '@/design/gradients';
import { useAsync } from '@/data/useAsync';
import { repos } from '@/data';
import { recordEntries, recordFigure } from '@/state/derived';

export default function Risk() {
  const goBack = useGoBack();
  /*
   * `listAgents` throws when /agents cannot answer. It fell back to four fixture personas with no
   * limits, so an outage reached the empty state below as a claim that no agent carries any — about
   * limits nobody had read. It reaches the ErrorState now, and signed out, a sign-in.
   */
  const { data, loading, error, reload } = useAsync(() => repos.bot.listAgents(), []);

  const agents = data ?? [];
  const withLimits = agents.filter((a) => Object.keys(a.riskLimits ?? {}).length > 0);

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Risk limits</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          Each agent&apos;s own limits, on top of your daily cap.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <LoadingRows count={4} height={size.rowLg} />
        ) : withLimits.length === 0 ? (
          <EmptyState text="No agent has its own limits. Your daily cap still applies." />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30, gap: space.s10 }}
          >
            {withLimits.map((a) => (
              <SheetCard key={a.id} bordered borderRadius={radius.panel} padding={space.s16}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s12 }}>
                  <AgentOrb gradient={agentGradient(a.name)} identity={a.name} size={52} face />
                  <Text variant="rowPrimary" style={{ flex: 1 }}>
                    {a.name}
                  </Text>
                </View>

                {/*
                  Row by row. The shape is per agent, and anything nested is flattened into its own
                  rows rather than dropped without saying so.
                */}
                {recordEntries(a.riskLimits).map((e) => (
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
                    {/* An agent's dollar limits are the person's money, and hide while balances are hidden. */}
                    <Text variant="secondarySm" style={{ flexShrink: 1, textAlign: 'right' }} figure={recordFigure(e)}>
                      {e.value}
                    </Text>
                  </View>
                ))}
              </SheetCard>
            ))}

            <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s6 }}>
              {/*
                The true line. This said the agent "can be wrong about" its own rules; the executor
                enforces them on every run, and the contract enforces the cap on top.
              */}
              The executor enforces these. The contract enforces the cap.
            </Text>
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
