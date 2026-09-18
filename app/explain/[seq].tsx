/**
 * Why the agent took this trade.
 *
 * Opened from a row on Activity, and read back from what the agent wrote down at the moment it
 * decided — not recomputed now. The distinction is the whole feature: re-running the analysis on
 * demand would produce a fluent account of what the agent WOULD do today, presented as the reason
 * it acted then, and the two diverge as soon as a price moves.
 *
 * A row with no record says so plainly. Manual trades have no agent reasoning, and trades placed
 * before the agent started recording have none either; neither gets a story invented for it.
 */
import React from 'react';
import { Linking, ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  ErrorState,
  Fill,
  LoadingRows,
  NoteStrip,
  Press,
  Row,
  Screen,
  Text,
  colors,
  size,
  space,
} from '@/ui';
import { api } from '@/data/api';
import { useAsync } from '@/data/useAsync';
import { explainLines, type TradeExplanation } from '@/bot/explain';

/** The row height used for the reason list — the same `rowLg` the rest of the app lists with. */
const ROW_H = size.rowLg;

/**
 * "Check it on chain" — when there is a chain to check it on.
 *
 * Same split as the Activity list: a real URL is a link, and a `fork:`/`local:` label is the
 * reference in plain text. Pretending a local transaction has an explorer entry would be the
 * small dishonesty this whole screen exists to make impossible.
 */
function Receipt({ explorer }: { explorer: string }) {
  if (!explorer.startsWith('http')) {
    const ref = explorer.split(':')[1];
    return (
      <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s14 }}>
        {`${ref?.slice(0, 10) ?? ''}…`}
      </Text>
    );
  }
  return (
    <Press
      onPress={() => void Linking.openURL(explorer)}
      accessibilityRole="link"
      accessibilityLabel="View this transaction"
      hitHeight={size.hit}
      style={{ marginTop: space.s14 }}
    >
      <Text variant="secondarySm" color={colors.ink55}>
        View transaction ›
      </Text>
    </Press>
  );
}

export default function ExplainTrade() {
  const { seq } = useLocalSearchParams<{ seq: string }>();
  const goBack = useGoBack();

  const read = useAsync(
    () => api.get<TradeExplanation>(`/activity/${encodeURIComponent(seq ?? '')}/explain`),
    [seq],
  );
  const found = read.data;

  return (
    <Screen gutter="none" sheet>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8, paddingHorizontal: space.gutter }}>
        <BackButton onPress={() => goBack()} />
        <Text variant="screenTitle">Why this trade</Text>
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {read.error ? (
          <ErrorState error={read.error} onRetry={read.reload} />
        ) : read.loading && !found ? (
          <LoadingRows count={5} height={ROW_H} />
        ) : !found ? null : found.status === 'no_record' ? (
          /*
           * No reasoning was stored, and none is invented.
           *
           * Deliberately does not guess WHY it is absent. A manual buy and a trade that predates
           * the agent recording its reasons look identical from here, and picking between them
           * would put a confident sentence on top of an absence.
           */
          <View style={{ gap: space.s12 }}>
            <NoteStrip kind="risk">
              No decision record was stored for this one, so there is nothing to show. Only the
              autonomous agent writes down why it acted; a trade placed by hand has no reasoning
              behind it to read back.
            </NoteStrip>
            <Row title="Recorded by" value={found.agent} height={ROW_H} divider={false} />
          </View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.s30 }}>
            {/*
              The agent's own sentence, as it wrote it.

              Not re-worded to match the outcome. A trade that worked and a trade that did not are
              both explained by the reason that was actually held at the time.
            */}
            <NoteStrip kind="acted">{found.record.opening}</NoteStrip>

            <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s16 }}>
              {found.record.reason}
            </Text>

            <View style={{ marginTop: space.s16 }}>
              {explainLines(found.record).map((line, i, all) => (
                <Row
                  key={line.label}
                  title={line.label}
                  value={line.value}
                  height={ROW_H}
                  divider={i < all.length - 1}
                />
              ))}
            </View>

            {/*
              The receipt. Everything above is what the agent says it did; this is where anyone can
              go and check whether it did.

              Tappable only where there is somewhere to go. `explorerTx` hands back a `fork:` or
              `local:` label on a network with no explorer, and linking that to Solscan would 404
              — which reads as the transaction not being real rather than the network not being
              public.
            */}
            {found.explorer ? <Receipt explorer={found.explorer} /> : null}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
