/**
 * What has actually been made, per symbol, on positions that are closed.
 *
 * Holdings show what a position is worth now. This shows what selling actually returned, which is
 * a different number and the only one that is real — an unrealised gain is a price, and a realised
 * one is money that moved.
 *
 * `basisIncomplete` is surfaced per row rather than hidden. A sale with no recorded cost is booked
 * as no gain or loss — `server/src/positions/index.ts` leaves its realised figure at zero — so the
 * total leaves that sale's real outcome out, whichever way it went, and a total that did not say so
 * would be a number nobody could reconcile. This said "understates", which holds only when the
 * unknown cost was below the price; `/disposals` said "upper bound", which holds only when it was
 * above. All three screens now say what the executor does.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  EmptyList,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Price,
  Row,
  Screen,
  Text,
  colors,
  pnlTone,
  size,
  space,
} from '@/ui';
import { money, quantity, signedMoney } from '@/format';
import { useAsync } from '@/data/useAsync';
import { repos } from '@/data';

export default function Pnl() {
  const goBack = useGoBack();
  const { data, loading, error, reload } = useAsync(() => repos.portfolio.realised(), []);

  const rows = data?.bySymbol ?? [];
  const incomplete = rows.filter((r) => r.basisIncomplete).length;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Realised</Text>} />
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <LoadingRows count={5} height={size.rowLg} />
        ) : rows.length === 0 ? (
          <EmptyList list="realised" />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30 }}
          >
            <View style={{ paddingBottom: space.s16 }}>
              <Text variant="footnote" color={colors.ink55}>
                TOTAL REALISED
              </Text>
              <Price variant="screenTitle" tone={pnlTone(data!.total)} style={{ marginTop: space.s6 }}>
                {signedMoney(data!.total)}
              </Price>
              {incomplete > 0 ? (
                <Text variant="secondarySm" color={colors.warn} style={{ marginTop: space.s8 }}>
                  {/*
                    Counted, not hand-waved. "Some figures may be incomplete" is the kind of
                    disclaimer that reassures nobody and helps nobody.
                  */}
                  {incomplete === 1
                    ? 'One symbol had a sale with no recorded cost, counted as no gain or loss.'
                    : `${incomplete} symbols had sales with no recorded cost, counted as no gain or loss.`}
                </Text>
              ) : null}
            </View>

            {rows.map((r) => (
              <Row
                key={r.symbol}
                height={size.rowLg}
                title={r.symbol}
                secondary={`${quantity(r.unitsSold)} sold · ${money(r.proceeds)} back${r.basisIncomplete ? ' · cost incomplete' : ''}`}
                secondaryFigure="units"
                value={
                  <Price variant="rowPrimary" tone={pnlTone(r.realised)}>
                    {signedMoney(r.realised)}
                  </Price>
                }
              />
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
