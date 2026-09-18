/**
 * One run, in full: what it tried, what stopped it, and the transaction if there was one.
 *
 * The list answers "what has the bot been doing". This answers "why did that one not happen",
 * which is the question people actually have, and it is the reason the `error` column is rendered
 * verbatim rather than mapped to a friendly sentence. "daily cap" and "no live market for WETH"
 * are different problems with different fixes, and a single "could not run" hides both.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
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
  type FigureKind,
} from '@/ui';
import { money, price, quantity, when } from '@/format';
import { useAsync } from '@/data/useAsync';
import { system, type StrategyRunRow } from '@/data/system';
import { kindLabel, labelFigure } from '@/strategies/ladder';
import { FillReceipt } from '@/ui/FillReceipt';

function toneFor(status: StrategyRunRow['status']): string {
  if (status === 'filled') return colors.up;
  if (status === 'failed') return colors.down;
  if (status === 'pending') return colors.ink40;
  return colors.warn;
}

export default function RunDetail() {
  const goBack = useGoBack();
  const { id } = useLocalSearchParams<{ id: string }>();
  /*
   * Fetched from the list rather than a per-run route, because there is no per-run route and
   * inventing one for a screen that only opens from the list would be a round trip for nothing.
   * The list is capped, so a run older than that is not reachable — said plainly below rather than
   * rendered as an empty screen.
   */
  const { data, loading, error, reload } = useAsync(() => system.runs(200), []);
  const run = (data ?? []).find((r) => r.id === id);

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Run</Text>} />
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <Placeholder height={170} />
        ) : !run ? (
          <Text variant="body" color={colors.ink55}>
            Not among your latest 200 runs.
          </Text>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30, gap: space.s10 }}
          >
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <Text variant="footnote" color={colors.ink55} figure={labelFigure(run.kind)}>
                {run.label.toUpperCase()}
              </Text>
              <Text variant="screenTitle" color={toneFor(run.status)} style={{ marginTop: space.s6 }}>
                {run.status.charAt(0).toUpperCase() + run.status.slice(1)}
              </Text>
              <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
                {/* The kind as the library names it — "Recurring buy", not `dca`. */}
                {run.symbol} · {kindLabel(run.kind)} · {when(new Date(run.at).getTime())}
              </Text>
            </SheetCard>

            {run.error ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                <Text variant="footnote" color={colors.ink55}>
                  WHY IT DID NOT HAPPEN
                </Text>
                {/*
                  Verbatim. "daily cap" and "no live market for WETH" need different responses from
                  the reader, and one friendly sentence for both would cost them that.
                */}
                {/* A refusal can name the cap it met — "$1,600.00 cap" — which is the person's own, as on the list. */}
                <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s6 }} figure="own">
                  {run.error}
                </Text>
              </SheetCard>
            ) : null}

            {run.usd !== null ? <Field label="Size" value={money(run.usd)} figure="own" /> : null}
            {run.units !== null ? <Field label="Units" value={quantity(run.units)} figure="units" /> : null}
            {run.price !== null ? <Field label="Price" value={price(run.price)} figure="market" /> : null}

            {/*
              The receipt, with the venue it filled at — which this screen recorded all along and did not show. A
              signature on its own proves a transaction happened; the venue is what says WHICH event it was, and a
              `venue-vault` settlement and a `jupiter-route` fill produce equally valid signatures for two different
              things (`fillVenue.ts`).

              `animate={false}`: this screen is opened from the list, so its run already happened. A receipt that rises
              into place here would be saying a fill just landed when it may be a week old.
            */}
            {run.signature ? (
              <FillReceipt signature={run.signature} venue={run.venue} animate={false} />
            ) : null}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}

/** One figure of the run, which says what it is: the size and units are the person's, the price is the market's. */
function Field({ label, value, figure }: { label: string; value: string; figure: FigureKind }) {
  return (
    <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
      <Text variant="footnote" color={colors.ink55}>
        {label}
      </Text>
      <Text variant="rowPrimary" style={{ marginTop: space.s4 }} figure={figure}>
        {value}
      </Text>
    </SheetCard>
  );
}
