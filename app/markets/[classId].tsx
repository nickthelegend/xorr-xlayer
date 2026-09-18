/**
 * One market class in full — PLAN.md 10.5 [G14]. Screen 24's footer link had no destination, and opens this now.
 * The full list for one class, paginated so a 300-instrument class stays scrollable.
 *
 * Priced by the class's own read (`src/markets/prices.ts`). Through `listClasses` a failed read came
 * back as a list of dashes, so the error state below could never show.
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  AssetMark,
  BackButton,
  Button,
  EmptyState,
  ErrorState,
  Fill,
  LoadingRows,
  Price,
  Row,
  Screen,
  Text,
  colors,
  size,
  space,
} from '@/ui';
import { assetClasses } from '@/data/fixtures/markets';
import { logoProps, useLogos } from '@/data/useLogos';
import { sourceOf } from '@/markets/prices';
import { useMarketPrices } from '@/markets/useMarketPrices';
import type { Instrument } from '@/data/types';

const PAGE = 25;

export default function ClassList() {
  const { classId } = useLocalSearchParams<{ classId: string }>();
  const router = useRouter();
  const goBack = useGoBack();
  const [page, setPage] = useState(1);

  const listed = assetClasses.find((c) => c.id === classId);
  // Only the read this class needs. The share snapshot is the slow one, and no other class uses it.
  const classes = useMarketPrices({ stocks: listed !== undefined && sourceOf(listed) === 'stocks' });
  const cls = classes.find((c) => c.id === classId);

  const rows = useMemo(() => (cls?.instruments ?? []).slice(0, page * PAGE), [cls, page]);
  const logos = useLogos(useMemo(() => rows.map((r) => r.sym), [rows]));
  const hasMore = (cls?.instruments.length ?? 0) > rows.length;

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8, flex: 1 }}>
          <BackButton onPress={() => goBack()} />
          <Text variant="screenTitle" numberOfLines={1}>
            {cls?.label ?? 'Markets'}
          </Text>
        </View>
        <Text variant="footnote" color={colors.ink55}>
          {/*
            "0 of 0 markets" is a claim, and while the prices are loading it is a false one — this
            screen showed it for a full twenty seconds before rendering nine. Nor is it a true one for
            a class that does not exist, or one whose read failed: there is nothing here to count.
          */}
          {cls?.state === 'ready'
            ? `${rows.length} of ${cls.instruments.length} markets`
            : cls?.state === 'loading'
              ? 'Loading markets'
              : ''}
        </Text>
      </View>

      <Text variant="secondary" style={{ marginTop: space.s10 }}>
        {cls?.note ?? ''}
      </Text>

      <Fill style={{ marginTop: space.s10 }}>
        {!cls ? (
          /*
            No class by that name.

            Rendering the list anyway gave a black screen under the word "Markets" with "0 of 0
            markets" in the corner — indistinguishable from a class that exists and happens to be
            empty, and from a failed load. A stale link or a typo lands here, so it says which it is
            and offers the way back to the classes that do exist.
          */
          <EmptyState
            text={`There is no "${classId}" class.`}
            actionLabel="Browse markets"
            onAction={() => router.replace('/(tabs)/markets')}
          />
        ) : cls.state === 'failed' && cls.error ? (
          <ErrorState error={cls.error} onRetry={cls.reload} />
        ) : cls.state !== 'ready' ? (
          <LoadingRows count={8} />
        ) : (
          <FlashList
            data={rows}
            keyExtractor={(i: Instrument) => i.sym}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }: { item: Instrument }) => (
              <Row
                left={
                  <AssetMark
                    gradient={{ c1: item.c1, c2: item.c2 }}
                    {...logoProps(logos, item.sym)}
                    size={size.mark}
                  />
                }
                title={item.sym}
                secondary={`${item.name} · ${item.tag}`}
                // Quiet where nothing prices it: the class note says so once, above.
                value={
                  <Price color={item.feed === 'unavailable' ? colors.ink55 : undefined} figure="market">
                    {item.px}
                  </Price>
                }
                delta={item.chg}
                deltaTone={item.up ? 'up' : 'down'}
                onPress={() => router.push(`/asset/${item.sym}`)}
              />
            )}
            ListFooterComponent={
              hasMore ? (
                <Button
                  label="Show more"
                  variant="ghost"
                  height={size.ghostSm}
                  style={{ marginVertical: space.s16 }}
                  onPress={() => setPage((p) => p + 1)}
                />
              ) : null
            }
          />
        )}
      </Fill>
    </Screen>
  );
}
