/**
 * Futures — every live perpetual contract, from Hyperliquid (2026-09-13).
 *
 * The busiest first, or the day's biggest moves either way. Each row opens the contract: its chart,
 * funding, open interest and volume. Market data only — xorr does not trade futures, and the screen
 * says so once, at the bottom, rather than on every row.
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  AssetMark,
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Placeholder,
  Row,
  Screen,
  Segmented,
  Text,
  colors,
  size,
  space,
} from '@/ui';
import { compactMoney, percent, price as fmtPrice } from '@/format';
import { assetGradient } from '@/design/gradients';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { perpLogoProps, useLogos } from '@/data/useLogos';
import type { PerpMarket } from '@/data/repositories';

type Sort = 'top' | 'gainers' | 'losers';

const SORTS = [
  { value: 'top', label: 'Top' },
  { value: 'gainers', label: 'Gainers' },
  { value: 'losers', label: 'Losers' },
] as const satisfies readonly { value: Sort; label: string }[];

/** A long tail of thin contracts says less than the busiest few dozen. */
const ROWS = 50;

/** What an empty sort means. Gainers on a day nothing rose drew a blank page. */
const EMPTY: Readonly<Record<Sort, string>> = {
  top: 'No contracts listed right now.',
  gainers: 'Nothing is up today.',
  losers: 'Nothing is down today.',
};

function sorted(markets: readonly PerpMarket[], sort: Sort): PerpMarket[] {
  if (sort === 'top') return markets.slice(0, ROWS);
  const moved = markets.filter((m) => m.change24hPct !== null && (sort === 'gainers' ? m.change24hPct > 0 : m.change24hPct < 0));
  return moved
    .sort((a, b) => (sort === 'gainers' ? b.change24hPct! - a.change24hPct! : a.change24hPct! - b.change24hPct!))
    .slice(0, ROWS);
}

export default function Futures() {
  const goBack = useGoBack();
  const router = useRouter();
  const [sort, setSort] = useState<Sort>('top');
  const { data, loading, error, reload } = useAsync(() => repos.perps.markets(), []);

  const rows = useMemo(() => sorted(data?.markets ?? [], sort), [data, sort]);
  const symbols = useMemo(() => rows.map((m) => m.symbol), [rows]);
  const logos = useLogos(symbols);

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Futures</Text>} />
        {data ? (
          <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
            {/* The venue is named once, in the footnote. */}
            {`${data.markets.length} contracts`}
          </Text>
        ) : loading ? (
          <Placeholder width={170} height={14} style={{ marginTop: space.s10 }} />
        ) : null}
        <Segmented options={SORTS} value={sort} onChange={setSort} style={{ marginTop: space.s16 }} />
      </View>

      <Fill style={{ marginTop: space.s8, paddingHorizontal: space.gutter }}>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <LoadingRows count={8} height={size.rowLg} />
        ) : rows.length === 0 ? (
          <EmptyState text={EMPTY[sort]} />
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.s30 }}>
            {rows.map((m, i) => (
              <Row
                key={m.symbol}
                height={size.rowLg}
                divider={i < rows.length - 1}
                onPress={() => router.push(`/perp/${m.symbol}`)}
                left={<AssetMark gradient={assetGradient(m.symbol)} {...perpLogoProps(logos, m.symbol)} size={size.mark} />}
                title={m.symbol}
                secondary={`${m.maxLeverage}x · OI ${compactMoney(m.openInterestUsd)}`}
                value={fmtPrice(m.markPx)}
                figure="market"
                delta={m.change24hPct === null ? undefined : percent(m.change24hPct, { digits: 2, explicitSign: true })}
                deltaTone={m.change24hPct === null || m.change24hPct === 0 ? 'neutral' : m.change24hPct > 0 ? 'up' : 'down'}
              />
            ))}
            <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s14 }}>
              {`Market data from ${data?.venue ?? 'the venue'}. xorr does not trade futures.`}
            </Text>
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
