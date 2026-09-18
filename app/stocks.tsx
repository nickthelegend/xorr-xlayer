/**
 * The tokenized equities, priced by probing a real route.
 *
 * There is no market-data feed behind these. Every price here is the answer to "what would a
 * hundred dollars of USDC actually buy right now", asked of the Uniswap v3 pools — which is a stranger and more
 * honest number than a quote, because it is the price you would get rather than the price someone
 * says the stock is at.
 *
 * `feed: 'unavailable'` is a real row, not an omission. On a chain where the equities do not
 * function the probe fails, and a screen that quietly dropped those would hide the fact that the
 * app cannot trade them here.
 *
 * Distilled 2026-09-14 (PLAN.md O3): no venue on the rows and no network in the notes — How it works names them.
 */
import React, { useMemo } from 'react';
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
  Price,
  Row,
  Screen,
  Text,
  colors,
  size,
  space,
} from '@/ui';
import { assetGradient } from '@/design/gradients';
import { price as fmtPrice } from '@/format';
import { useAsync } from '@/data/useAsync';
import { logoProps, useLogos } from '@/data/useLogos';
import { system } from '@/data/system';

export default function Stocks() {
  const goBack = useGoBack();
  const router = useRouter();
  const { data, loading, error, reload } = useAsync(() => system.stocks(), []);

  const rows = useMemo(() => data ?? [], [data]);
  const symbols = useMemo(() => rows.map((r) => r.symbol), [rows]);
  const logos = useLogos(symbols);
  const unavailable = rows.filter((r) => r.feed !== 'live').length;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Stocks</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          Priced by what a real buy would cost.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s12, paddingHorizontal: space.gutter }}>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <LoadingRows count={8} height={size.rowLg} />
        ) : rows.length === 0 ? (
          <EmptyState text="No tokenized stocks here." />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30 }}
          >
            {unavailable > 0 ? (
              <Text variant="secondarySm" color={colors.warn} style={{ paddingVertical: space.s10 }}>
                {/*
                  Counted and stated. On a fork these tokens carry one byte of code and the probe
                  reverts; a screen that dropped those rows would hide that the app cannot trade
                  them here.
                */}
                {unavailable === rows.length
                  ? 'None of these can be bought here right now.'
                  : `${unavailable} of these can’t be bought here right now.`}
              </Text>
            ) : null}

            {rows.map((s) => (
              <Row
                key={s.address}
                height={size.rowLg}
                /*
                 * To the readings, not the asset screen.
                 *
                 * These have no market-data feed — the only history that exists is what this
                 * executor recorded by probing, and `/oracle` is the only screen that shows it.
                 * The asset screen is one tap further and predates this work.
                 */
                onPress={() => router.push(`/oracle/${s.symbol}`)}
                left={
                  <AssetMark
                    gradient={assetGradient(s.symbol)}
                    {...logoProps(logos, s.symbol)}
                    size={size.mark}
                  />
                }
                title={s.symbol}
                secondary={s.name}
                value={
                  s.price === null ? (
                    <Text variant="rowPrimary" color={colors.ink55}>
                      No route
                    </Text>
                  ) : (
                    <Price variant="rowPrimary" figure="market">
                      {fmtPrice(s.price)}
                    </Price>
                  )
                }
              />
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
