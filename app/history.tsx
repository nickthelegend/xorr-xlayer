/**
 * Transaction history — PLAN.md 3.14 (first built as 10.7 [G14]).
 *
 * Deliberately DISTINCT from Activity (screen 15). Activity answers "what did the bot decide"; this answers "what
 * settled on chain". They differ: a blocked proposal is an activity event with no transaction, and a fee is a
 * transaction with no decision behind it.
 *
 * The rows are the delegation contract's own `Spent` and `Closed` events for this wallet, read from the chain this
 * build settles on by `GET /history`. A settlement
 * history the user cannot verify independently is not a settlement history, so every row carries its transaction.
 *
 * Until 3.14 it read spends alone, from an index of another deployment, on the client, so on the fork — 33 filled runs,
 * every one of them on chain — it said nothing had settled; and closes, half of what a permission does, were never shown
 * at all. The Base build's index is gone; the chain is the only source.
 */
import React from 'react';
import { Linking, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Press,
  Price,
  Screen,
  Text,
  colors,
  divider,
  size,
  space,
} from '@/ui';
import { money, quantity, when } from '@/format';
import { useAsync } from '@/data/useAsync';
import { history, unitsOf, type HistoryItem } from '@/data/history';
import { useRefreshControl } from '@/ui/useRefreshControl';

/** What happened, in the chain's word for it — and, for a spend a run sent, what it bought. */
function titleOf(item: HistoryItem): string {
  const symbol = item.token?.symbol ?? 'an unlisted token';
  if (item.kind === 'spent') {
    const bought = item.run && item.run.symbol !== item.token?.symbol ? ` for ${item.run.symbol === 'PORTFOLIO' ? 'the portfolio' : item.run.symbol}` : '';
    return `Spent ${symbol}${bought}`;
  }
  return `Closed ${symbol}`;
}

/** Cents where the amount is dollars; more digits for an asset, where 0.0001 of it is a real amount. */
function amountOf(item: HistoryItem): string {
  const units = unitsOf(item);
  if (units === null || !item.token) return item.amount === null ? 'No token moved' : 'Unlisted token';
  const digits = item.usd !== null ? 2 : units !== 0 && Math.abs(units) < 1 ? 6 : 4;
  return `${quantity(units, digits)} ${item.token.symbol}`;
}

/**
 * The receipt: a tappable link on a public chain, a plain label on a fork or a local node — a link to an explorer that
 * has never seen the transaction reads as the transaction not being real. The same rule Activity follows.
 */
function Receipt({ explorer }: { explorer: string }) {
  if (!explorer.startsWith('http')) {
    // The hash alone: which network it is on is not named off the money screens (PLAN.md O3).
    const ref = explorer.split(':')[1];
    return (
      <Text variant="footnote" color={colors.ink55}>
        {`${ref?.slice(0, 10) ?? ''}…`}
      </Text>
    );
  }
  return (
    <Press
      onPress={() => void Linking.openURL(explorer)}
      accessibilityRole="link"
      accessibilityLabel="View this transaction"
      hitHeight={24}
    >
      <Text variant="footnote" color={colors.ink55}>
        View transaction ›
      </Text>
    </Press>
  );
}

function HistoryRow({ item }: { item: HistoryItem }) {
  /*
   * The chain's dollars where the amount is dollars. A close's worth is not on chain, so where a run sent it the
   * executor's measurement stands in — and says it is one, rather than passing for the chain's.
   */
  const usd = item.usd ?? item.run?.usd ?? null;
  const measured = item.usd === null && usd !== null;
  // When, and nothing about which venue: the network and the venues are not named off the money screens (PLAN.md O3).
  const context = item.at ? when(new Date(item.at).getTime()) : 'Time not read';

  return (
    <View style={[{ flexDirection: 'row', gap: space.s12, paddingVertical: space.s14 }, divider]}>
      <View style={{ flex: 1, gap: space.s2 }}>
        <Text variant="rowPrimary" numberOfLines={1}>
          {titleOf(item)}
        </Text>
        <Text variant="secondarySm" numberOfLines={1}>
          {context}
        </Text>
        <Receipt explorer={item.explorer} />
      </View>
      <View style={{ alignItems: 'flex-end', gap: space.s2 }}>
        {/* What moved, in its token's units, hides while balances are hidden (FEATURES.md #47); so does its worth. */}
        <Price variant="rowPrimary" figure="units">
          {amountOf(item)}
        </Price>
        {usd !== null ? (
          <Price variant="delta" color={colors.ink55}>
            {measured ? `${money(usd)} measured` : money(usd)}
          </Price>
        ) : null}
      </View>
    </View>
  );
}

export default function History() {
  const goBack = useGoBack();
  const router = useRouter();
  const { data, loading, error, reload } = useAsync(() => history(), []);
  // Pulling down is the gesture people already try on a list of things that keep changing.
  const refresh = useRefreshControl(reload);
  const items = data?.items ?? [];

  /*
   * The window, said out loud. The executor reads a bounded stretch of the chain, so "nothing here" only ever means
   * "nothing since then" — and a list that did not say so would claim more than it looked at.
   */
  const scope = data?.window.since ? `since ${when(new Date(data.window.since).getTime())}` : '';

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">History</Text>} />
        {data?.unavailable ? (
          <Text variant="footnote" color={colors.warn} style={{ marginTop: space.s4 }}>
            Some history couldn’t load.
          </Text>
        ) : null}
      </View>

      <Fill style={{ marginTop: space.s14, paddingHorizontal: space.gutter }}>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <LoadingRows count={6} height={size.rowLg} />
        ) : items.length === 0 ? (
          <EmptyState
            text={scope ? `No trades ${scope}.` : 'No trades yet.'}
            actionLabel="See activity"
            onAction={() => router.push('/activity')}
          />
        ) : (
          <ScrollView
            refreshControl={refresh.control}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30 }}
          >
            {/* A pull that failed says so, over the rows it could not replace. A success says nothing. */}
            {refresh.notice}
            {items.map((item, i) => (
              <HistoryRow key={`${item.kind}:${item.txHash}:${i}`} item={item} />
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
