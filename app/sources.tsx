/**
 * Where every number on screen comes from.
 *
 * The product's claim is that it does not invent figures. That claim is only checkable if someone
 * can find out which upstream produced which number — and until now that lived in code comments.
 *
 * Each row names a real dependency and what it is authoritative for, and the live ones are probed
 * rather than asserted: the chain row reads the executor's RPC probe, the database row its Postgres
 * probe. A page that listed its sources without checking any of them
 * would be making the same unfalsifiable claim it exists to replace.
 *
 * Our own database is one of them, and says so. The header read "None of them are us" and the chain
 * card "Nothing about your money is taken from our database" — while positions, their cost basis,
 * realised profit, runs, alerts and the stock readings are the executor's own records, and the
 * futures figures came from a venue the list never named. A sources page that hides one of its
 * sources is the thing it was written against.
 *
 * Deliberately not exhaustive about libraries. This is about where DATA comes from, not what the
 * app is built with.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  Fill,
  HeaderBar,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  space,
} from '@/ui';
import { useAsync } from '@/data/useAsync';
import { system } from '@/data/system';

type Source = {
  name: string;
  /** What it is the authority for. */
  owns: string;
  /** How the app reaches it. */
  how: string;
};

const SOURCES: Source[] = [
  {
    name: 'The chain',
    owns: 'Balances, the permission, approvals and every transaction',
    how: 'Read directly over RPC.',
  },
  {
    name: 'xorr',
    owns: 'Positions and their cost, realised profit, runs, alerts, stock readings and the audit trail',
    how: 'The executor’s own database. The audit trail in it is hash-chained and anchored on the chain.',
  },
  {
    name: 'Uniswap v3',
    owns: 'Swap routes, fill prices and xStock prices',
    how: 'Quoted from the pools that would fill the trade; the xStocks are priced by quoting a real buy, because they have no feed.',
  },
  {
    name: 'OKX DEX',
    owns: 'A second route for a trade, where this deployment has an API key',
    how: 'Its aggregator is asked alongside Uniswap, and its route is used only when it delivers more.',
  },
  {
    name: 'CoinGecko',
    owns: 'Crypto prices and charts',
    how: 'One batched request per refresh, cached — the public tier rate-limits hard.',
  },
  {
    name: 'Hyperliquid',
    owns: 'Futures prices, funding rates, open interest and volume',
    how: 'Its public market data. xorr does not trade futures.',
  },
  {
    name: 'Aave v3',
    owns: 'The rate idle cash earns',
    how: '`currentLiquidityRate`, read from the lending pool. It floats; it is not a promise.',
  },
  {
    name: 'EDGAR',
    owns: 'Earnings dates for the tokenized equities',
    how: "The regulator's own filing record. The next date is a projection from the cadence, and says so.",
  },
  {
    name: 'Privy',
    owns: 'Keys, signing, and the policy that refuses a bad destination',
    how: 'Enforced by their signer. A compromised executor cannot widen it.',
  },
];

export default function Sources() {
  const goBack = useGoBack();
  const router = useRouter();
  /* Probed, not asserted. A list of sources that checked none of them would be the same
     unfalsifiable claim this screen exists to replace. */
  const health = useAsync(() => system.health(), []);

  /* Undefined until `/health` answers: a probe nobody has read is not a dependency that is down. */
  const up = (name: string): boolean | undefined =>
    health.data ? health.data.dependencies.find((d) => d.name === name)?.status === 'up' : undefined;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Sources</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          Where every number comes from.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: space.s30, gap: space.s10 }}
        >
          {SOURCES.map((s) => {
            /* Only the two the app can actually probe get a live state. Claiming to know
               CoinGecko is up because a price rendered ten minutes ago would be a guess. The
               executor not answering `/health` at all is its database not answering us. */
            const live =
              s.name === 'The chain'
                ? up('rpc')
                : s.name === 'xorr'
                  ? health.error
                    ? false
                    : up('postgres')
                  : undefined;

            return (
              <SheetCard key={s.name} bordered borderRadius={radius.panel} padding={space.s16}>
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                  }}
                >
                  <Text variant="rowPrimary">{s.name}</Text>
                  {live === undefined ? null : (
                    <Text variant="footnote" color={live ? colors.up : colors.down}>
                      {live ? 'reachable' : 'not answering'}
                    </Text>
                  )}
                </View>
                <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s8 }}>
                  {s.owns}
                </Text>
                <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s8 }}>
                  {s.how}
                </Text>
              </SheetCard>
            );
          })}

          <Button
            label="Check every claim"
            variant="ghost"
            style={{ marginTop: space.s6 }}
            onPress={() => router.push('/verify')}
          />
        </ScrollView>
      </Fill>
    </Screen>
  );
}
