/**
 * Spends as the subgraph indexed them, not as our database recorded them.
 *
 * That distinction is the entire point of the screen. `/activity` is our own trail — hash-chained
 * and honest, but ours. This is the same money movement reconstructed from `Spend` events the
 * contract emitted, indexed by someone else's infrastructure. Two independent records of the same
 * facts is what makes either one worth trusting.
 *
 * Only when the index is about this deployment, though, which `/graph/health` says and which is
 * asked first. An index of another contract is somebody else's record: its spends were listed here
 * as this wallet's, and its empty list read as this wallet having spent nothing.
 *
 * Amounts are raw token units as strings, because they are `BigInt` in GraphQL and JSON has no such
 * thing. USDC is six decimals, so they are divided by that and labelled — anything else here would
 * be a guess about a token this screen does not resolve.
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
  NoteStrip,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { money, shortAddress, when } from '@/format';
import { useAsync } from '@/data/useAsync';
import { indexDay, system, type GraphSpend } from '@/data/system';

/** The settlement token's decimals. Every `Spend` is denominated in it. */
const USDC_DECIMALS = 6;

function usd(raw: string): string {
  const n = Number(raw) / 10 ** USDC_DECIMALS;
  return Number.isFinite(n) ? money(n) : raw;
}

export default function GraphSpends() {
  const goBack = useGoBack();
  const { data, loading, error, reload } = useAsync(() => system.graphActivity(), []);
  const index = useAsync(() => system.graphHealth(), []);

  const spends = data?.spends ?? [];
  const daily = data?.daily ?? [];
  const failed = error ?? index.error;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Indexed spends</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          The same money, recorded by an independent index.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s16 }}>
        {failed ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <ErrorState
              error={failed}
              onRetry={() => {
                reload();
                index.reload();
              }}
            />
          </View>
        ) : (loading && !data) || (index.loading && !index.data) ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <LoadingRows count={6} height={size.row} />
          </View>
        ) : index.data?.indexesThisDeployment === false ? (
          /* One line in place of the rows: whatever the index holds is another contract's, not this wallet's here. */
          <View style={{ paddingHorizontal: space.gutter }}>
            <NoteStrip kind="risk">This index follows a different deployment.</NoteStrip>
          </View>
        ) : spends.length === 0 ? (
          <EmptyState text="No spends indexed yet." />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: space.gutter,
              paddingBottom: space.s30,
              gap: space.s10,
            }}
          >
            {daily.length > 0 ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                <Text variant="footnote" color={colors.ink55}>
                  BY DAY
                </Text>
                {daily.slice(0, 7).map((d) => {
                  const trades = Number(d.tradeCount);
                  return (
                    <View
                      key={d.day}
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        marginTop: space.s8,
                      }}
                    >
                      {/* A date, not the index's day number ("20345"). */}
                      <Text variant="secondarySm" color={colors.ink65}>
                        {indexDay(d.day)}
                      </Text>
                      <Text variant="secondarySm" figure="own">
                        {usd(d.total)} · {trades === 1 ? 'one trade' : `${d.tradeCount} trades`}
                      </Text>
                    </View>
                  );
                })}
              </SheetCard>
            ) : null}

            {spends.map((s) => (
              <SpendRow key={s.id} spend={s} />
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}

function SpendRow({ spend }: { spend: GraphSpend }) {
  return (
    <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        {/* What the permission spent is the person's money, and hides while balances are hidden (FEATURES.md #47). */}
        <Text variant="rowPrimary" figure="own">
          {usd(spend.amount)}
        </Text>
        <Text variant="footnote" color={colors.ink55}>
          {when(Number(spend.timestamp) * 1000)}
        </Text>
      </View>
      <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s6 }}>
        venue {shortAddress(spend.venue)} · token {shortAddress(spend.token)}
      </Text>
      {/*
        The transaction hash, in full. This is the thing a reader takes to an explorer, and an
        ellipsis in the middle of it makes it useless for that.
      */}
      <Text variant="footnoteSm" color={colors.ink55} style={{ marginTop: space.s6 }}>
        {spend.txHash}
      </Text>
    </SheetCard>
  );
}
