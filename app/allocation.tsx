/**
 * Where the money actually sits.
 *
 * Holdings is a list ordered by whatever it was ordered by; this is the same money as proportions,
 * which is the only view that answers "am I concentrated" — the question that matters most and that
 * a list of rows cannot answer at a glance.
 *
 * Built from the same `positions()` call Holdings uses, so the two cannot disagree. Bars are drawn
 * from `notional` because that is what the position is worth now, and the percentage under each is
 * derived from the same figure rather than stored separately.
 *
 * Cash is included. A portfolio that is eighty percent cash is a fact about the portfolio, and
 * omitting it would make every other slice look larger than it is.
 *
 * Signed out it asks for a sign-in: "nothing is held" was being said about a wallet nobody had named.
 */
import React, { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  AssetMark,
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  Placeholder,
  Price,
  Screen,
  Text,
  colors,
  size,
  space,
  SignInPrompt,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { assetGradient } from '@/design/gradients';
// Unsigned: a share of the whole is not a move, and "+62.4%" read as a gain.
import { money, percent as pct } from '@/format';
import { useAsync } from '@/data/useAsync';
import { logoProps, useLogos } from '@/data/useLogos';
import { repos } from '@/data';

const BAR_H = 6;

export default function Allocation() {
  const goBack = useGoBack();
  const balance = useAsync(() => repos.portfolio.balance(), []);
  const signedOut = useSignedOut();

  /*
   * From the chain, not from the position ledger.
   *
   * This was built on `positions()`, which is what the DB recorded paying for things. That is the
   * right source for cost basis and the wrong one for "where is my money" — the two drifted, and
   * this screen showed WETH at $1,211 while `/balance`, reading the chain, showed $682 of holdings.
   * Two screens that link to each other, disagreeing by five hundred dollars about the same
   * position. The chain is what you actually hold.
   */
  const rows = useMemo(() => {
    const held = (balance.data?.holdings ?? [])
      .filter((h) => h.usd > 0)
      .map((h) => ({ symbol: h.symbol, usd: h.usd }));
    const cash = balance.data?.cash ?? 0;
    const supplied = balance.data?.supplied ?? 0;
    return [
      ...held,
      // Only when there is some. A zero-width bar with a label is noise.
      ...(supplied > 0 ? [{ symbol: 'Supplied', usd: supplied }] : []),
      ...(cash > 0 ? [{ symbol: 'Cash', usd: cash }] : []),
    ];
  }, [balance.data]);

  /* The chain's own total, not a sum of the slices — so the headline cannot drift from `/balance`. */
  const total = balance.data?.total ?? 0;
  const symbols = useMemo(() => rows.map((r) => r.symbol), [rows]);
  const logos = useLogos(symbols);

  const error = balance.error;
  const loading = balance.loading && !balance.data;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Allocation</Text>} />
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {signedOut ? (
          <SignInPrompt />
        ) : error ? (
          <ErrorState error={error} onRetry={balance.reload} />
        ) : loading ? (
          <View style={{ gap: space.s12 }}>
            <Placeholder height={70} />
            <Placeholder height={70} />
            <Placeholder height={70} />
          </View>
        ) : !balance.data ? (
          /* A guard only: `balance()` throws when the chain could not be read, and neither that nor null is an empty wallet. */
          <EmptyState text="The balance could not be read." actionLabel="Try again" onAction={balance.reload} />
        ) : rows.length === 0 || total === 0 ? (
          <EmptyState text="Nothing held yet." />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30 }}
          >
            <View style={{ paddingBottom: space.s16 }}>
              <Text variant="footnote" color={colors.ink55}>
                TOTAL
              </Text>
              <Price variant="screenTitle" style={{ marginTop: space.s6 }}>
                {money(total)}
              </Price>
            </View>

            {rows
              .slice()
              .sort((a, b) => b.usd - a.usd)
              .map((r) => {
                const share = r.usd / total;
                return (
                  <View key={r.symbol} style={{ marginTop: space.s16 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10 }}>
                      <AssetMark
                        gradient={assetGradient(r.symbol)}
                        {...logoProps(logos, r.symbol)}
                        size={size.markSm}
                      />
                      <Text variant="rowPrimary" style={{ flex: 1 }}>
                        {r.symbol}
                      </Text>
                      <Price variant="rowPrimary">{money(r.usd)}</Price>
                    </View>

                    {/*
                      Static, and drawn from the same number as the label beside it. A bar whose
                      width came from anywhere other than the figure it sits under is a bar that can
                      disagree with it.
                    */}
                    <View
                      style={{
                        height: BAR_H,
                        borderRadius: BAR_H / 2,
                        backgroundColor: colors.control,
                        marginTop: space.s10,
                        overflow: 'hidden',
                      }}
                    >
                      <View
                        style={{
                          width: `${share * 100}%`,
                          height: '100%',
                          borderRadius: BAR_H / 2,
                          backgroundColor: colors.ink,
                        }}
                      />
                    </View>

                    <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s6 }}>
                      {pct(share * 100, { digits: 1, explicitSign: false })}
                    </Text>
                  </View>
                );
              })}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
