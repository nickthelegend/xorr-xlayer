/**
 * Every sale, with what it cost and what it returned.
 *
 * `/pnl` aggregates by symbol, which answers "what have I made". This is the row-level record,
 * which answers "which sale was that" — the question an accountant asks first and the one the app
 * could only answer by emailing a CSV.
 *
 * `basisKnown` is per row, not folded into a footnote. A sale whose cost was never recorded has no
 * gain anyone can state — the executor books it as zero, and the truth could be either side of that
 * — and *which* sale that is matters more than the fact that some of them are. A summary line saying
 * "some figures may be incomplete" helps nobody.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Price,
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
import { money, quantity, signedMoney, when } from '@/format';
import { useAsync } from '@/data/useAsync';
import { system, type Disposal } from '@/data/system';

export default function Disposals() {
  const goBack = useGoBack();
  const { data, loading, error, reload } = useAsync(() => system.disposals(), []);

  const rows = data ?? [];

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Disposals</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          One row per sale, with the cost it was matched against.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s16 }}>
        {error ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <ErrorState error={error} onRetry={reload} />
          </View>
        ) : loading && !data ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <LoadingRows count={6} height={size.rowLg} />
          </View>
        ) : rows.length === 0 ? (
          <EmptyState text="Nothing has been sold, so there is nothing to report." />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: space.gutter,
              paddingBottom: space.s30,
              gap: space.s10,
            }}
          >
            {rows.map((d) => (
              <DisposalRow key={d.id} disposal={d} />
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}

function DisposalRow({ disposal }: { disposal: Disposal }) {
  return (
    <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text variant="rowPrimary">{disposal.symbol}</Text>
        {/* A dash for a gain nobody measured: "+$0.00" was the executor's zero, printed as if it were a result. */}
        {disposal.basisKnown ? (
          <Price variant="rowPrimary" tone={pnlTone(disposal.realised)}>
            {signedMoney(disposal.realised)}
          </Price>
        ) : (
          <Price variant="rowPrimary">—</Price>
        )}
      </View>

      <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s4 }}>
        {when(new Date(disposal.at).getTime())}
      </Text>

      <View style={{ flexDirection: 'row', gap: space.s20, marginTop: space.s12 }}>
        <Cell label="Sold" value={quantity(disposal.units)} figure="units" />
        <Cell label="Proceeds" value={money(disposal.proceeds)} figure="own" />
        <Cell label="Cost" value={disposal.basisKnown ? money(disposal.cost) : '—'} figure="own" />
      </View>

      {disposal.basisKnown ? null : (
        <Text variant="secondarySm" color={colors.warn} style={{ marginTop: space.s10 }}>
          {/*
            Per row, because which sale is missing its cost is the actionable half. Not "an upper
            bound": with the cost unknown the sale could have been a loss, and the totals on /pnl and
            in the file count it as neither — which is what this says, and all it says.
          */}
          No recorded cost, so this counts as no gain or loss.
        </Text>
      )}
    </SheetCard>
  );
}

/** One figure of a sale, which says what it is: each of them is the person's money, in units or in dollars. */
function Cell({ label, value, figure }: { label: string; value: string; figure: FigureKind }) {
  return (
    <View style={{ gap: space.s2 }}>
      <Text variant="footnote" color={colors.ink55}>
        {label}
      </Text>
      <Text variant="secondarySm" figure={figure}>
        {value}
      </Text>
    </View>
  );
}
