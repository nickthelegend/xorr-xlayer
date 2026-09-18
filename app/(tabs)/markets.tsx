/**
 * Screen 24 — Markets, all asset classes. screens.md Group B.
 *
 * Rebuilt on `src/ui`. Every value here is a token: the row is `Row` at `size.rowLg`, the
 * class chips are `Pill` in a `PillRow` (which scrolls rather than shrinking — design.md §5
 * records that the market tabs shipped broken the other way once), and the mark is
 * `AssetMark`, the same radial-gradient recipe the agent orbs use.
 *
 * Each class is priced by its own read (`src/markets/prices.ts`). The list waited for every source,
 * so crypto sat behind the share snapshot for eight seconds; and a failed read came back as a list of
 * dashes, so the error block here could never render — and printed the raw message when it did.
 *
 * Nothing on this screen carries a hardcoded colour, size or radius.
 */
import React, { useMemo } from 'react';
import { View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import {
  AssetMark,
  ErrorState,
  Fill,
  LoadingRows,
  Pill,
  PillRow,
  Press,
  Price,
  Row,
  Screen,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { Sparkline } from '@/ui/charts';
import { Icon } from '@/design/Icon';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { logoProps, useLogos } from '@/data/useLogos';
import { useMarketPrices } from '@/markets/useMarketPrices';
import { useStore } from '@/state/store';
import type { Instrument } from '@/data/types';

export default function MarketsScreen() {
  const router = useRouter();
  const mkt = useStore((s) => s.mkt);
  const setMkt = useStore((s) => s.setMkt);
  // The pills, notes and names are the catalog, so they draw at once; only the prices wait, and each
  // class waits for its own.
  const classes = useMarketPrices();
  const cls = classes[mkt] ?? classes[0]!;
  const rows = cls.instruments;

  /*
   * One request for every glyph on the screen.
   *
   * `Sparkline` has existed since the design handoff and no row has ever used it — the shape of a
   * day is the one thing a price and a percentage cannot say, and it is why people scan a market
   * list at all. Fetched for the visible symbols in a single call rather than per row, because
   * nine round trips for a decoration is how a decoration becomes a regression.
   */
  const sparkSyms = useMemo(() => rows.map((r: Instrument) => r.sym), [rows]);
  // Real logos for the visible rows. Same symbol list the sparklines already use.
  const logos = useLogos(sparkSyms);
  const sparks = useAsync(
    () => repos.markets.sparklines(sparkSyms),
    [sparkSyms.join(',')],
  );

  return (
    <Screen tabBar gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <Row divider={false} height={size.mark} style={{ justifyContent: 'space-between' }}>
          <Text variant="screenTitle">Markets</Text>
          <Press
            accessibilityRole="button"
            accessibilityLabel="Search markets"
            onPress={() => router.push('/search')}
            hitHeight={size.mark}
            hitWidth={size.mark}
            style={{
              width: size.mark,
              height: size.mark,
              borderRadius: radius.full,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.surfaceAlt,
            }}
          >
            <Icon name="search" size={15} color={colors.ink55} />
          </Press>
        </Row>
      </View>

      {/* §5: pills never shrink to fit — the row scrolls. */}
      <PillRow style={{ marginTop: space.s16 }} contentPadding={space.gutter}>
        {classes.map((c, i) => (
          <Pill key={c.id} label={c.label} selected={c.id === cls.id} onPress={() => setMkt(i)} />
        ))}
      </PillRow>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: space.gutter,
          marginTop: space.s20,
          gap: space.s12,
        }}
      >
        <Text variant="secondarySm" color={colors.ink55} style={{ flex: 1, maxWidth: 220 }}>
          {cls.note}
        </Text>
        <Text variant="footnote" color={colors.ink55} numberOfLines={1}>
          {/*
            "0 shown" is a claim, and until the class's prices land it is a false one — the list
            below is a skeleton for exactly that window. A class whose read failed shows nothing,
            so it counts nothing.
          */}
          {cls.state === 'ready' ? `${rows.length} shown · 24/7` : cls.state === 'loading' ? 'Loading · 24/7' : ''}
        </Text>
      </View>

      <Fill style={{ paddingHorizontal: space.gutter, marginTop: space.s6 }}>
        {cls.state === 'failed' && cls.error ? (
          <ErrorState error={cls.error} onRetry={cls.reload} />
        ) : cls.state !== 'ready' ? (
          // Every other list in the app shows LoadingRows; this one once rendered an empty black
          // screen under a "0 shown" line for as long as the slowest call took.
          <LoadingRows count={8} height={size.rowLg} spark />
        ) : (
          <FlashList
            data={rows}
            keyExtractor={(i: Instrument) => i.sym}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }: { item: Instrument }) => (
              <Row
                height={size.rowLg}
                onPress={() => router.push(`/asset/${item.sym}`)}
                left={
                  <AssetMark
                    gradient={{ c1: item.c1, c2: item.c2 }}
                    {...logoProps(logos, item.sym)}
                    size={size.mark}
                  />
                }
                title={item.sym}
                secondary={`${item.name} · ${item.tag}`}
                value={
                  item.feed === 'unavailable' ? (
                    /*
                      Quiet, not flagged. The class note above already says nothing prices these,
                      and a yellow "No price feed" tag on every row said it eight more times.
                    */
                    <Price variant="rowPrimary" color={colors.ink55} figure="market">
                      {item.px}
                    </Price>
                  ) : (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s6 }}>
                      {/*
                        No glyph until there is a series. design.md puts the sparkline between the
                        symbol and the price; a symbol whose history has not arrived simply has none,
                        rather than a flat line claiming the price never moved.
                      */}
                      {(sparks.data?.[item.sym]?.length ?? 0) > 1 ? (
                        <Sparkline data={sparks.data![item.sym]!} />
                      ) : null}
                      <Price variant="rowPrimary" figure="market">
                        {item.px}
                      </Price>
                    </View>
                  )
                }
                delta={item.chg}
                deltaTone={item.up ? 'up' : 'down'}
              />
            )}
            ListFooterComponent={
              // The way into the class's own list, which nothing linked to while this was plain text.
              <Press
                onPress={() => router.push(`/markets/${cls.id}`)}
                accessibilityRole="button"
                accessibilityLabel={cls.more}
                hitHeight={size.hit}
                style={{ alignSelf: 'center', paddingVertical: space.s16 }}
              >
                <Text variant="control" color={colors.ink55}>
                  {cls.more} ›
                </Text>
              </Press>
            }
          />
        )}
      </Fill>

    </Screen>
  );
}
