/**
 * What this chain can actually settle, with the addresses.
 *
 * `/market/tradable` is the most load-bearing list in the app and the least visible. Everything on
 * Markets is a chart; only what is in this list is an order. The route exists precisely because the
 * app once offered "Buy $50 of SOL weekly" on a Base build — a strategy no signed transaction could
 * ever fill — and the fix was a list nobody could see.
 *
 * Addresses in full. A token is identified by its address and nothing else, and a symbol is a label
 * anyone can reuse; a reader checking that `NVDAx` is the contract they think it is needs the whole
 * thing, not the first six characters of it.
 */
import React, { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  AssetMark,
  EmptyList,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Press,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { assetGradient } from '@/design/gradients';
import { useAsync } from '@/data/useAsync';
import { logoProps, useLogos } from '@/data/useLogos';
import { system } from '@/data/system';
import { routesInto } from '@/markets/route';

export default function Tokens() {
  const goBack = useGoBack();
  const router = useRouter();
  const { data, loading, error, reload } = useAsync(() => system.tradable(), []);

  // Memoised together: `data ?? []` is a fresh array every render, so deriving the symbol list
  // from it directly would rebuild the list — and re-run the logo fetch — on every single render.
  const rows = useMemo(() => data ?? [], [data]);
  const symbols = useMemo(() => rows.map((t) => t.symbol), [rows]);
  const logos = useLogos(symbols);

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Tokens</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          What can be traded here.
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
          <EmptyList list="tradable" />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: space.gutter,
              paddingBottom: space.s30,
              gap: space.s10,
            }}
          >
            {rows.map((t) => (
              <View key={t.address} style={{ gap: space.s6 }}>
              <Press
                onPress={() => router.push(`/asset/${t.symbol}`)}
                accessibilityRole="button"
                accessibilityLabel={`${t.symbol}, ${t.decimals} decimals`}
              >
                <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s12 }}>
                    <AssetMark
                      gradient={assetGradient(t.symbol)}
                      {...logoProps(logos, t.symbol)}
                      size={size.markSm}
                    />
                    <Text variant="rowPrimary" style={{ flex: 1 }}>
                      {t.symbol}
                    </Text>
                    <Text variant="footnote" color={colors.ink55}>
                      {t.decimals} dp
                    </Text>
                  </View>
                  {/*
                    In full. A token IS its address; six characters of it identifies nothing, and
                    this screen exists so someone can check the contract is the one they expect.
                  */}
                  <Text variant="footnoteSm" color={colors.ink55} style={{ marginTop: space.s10 }}>
                    {t.address}
                  </Text>
                </SheetCard>
              </Press>

              {/*
                The two per-symbol inspectors live here.
                
                They are tools for a token and their natural home would be the asset screen, which
                predates this work and is not mine to redesign. Hanging them off the token registry
                is the honest alternative — and arguably the better one, since this is the screen
                that already answers "what exactly is this contract".
              */}
              <View style={{ flexDirection: 'row', gap: space.s16, paddingHorizontal: space.s14 }}>
                {/* No route into USDC: buys are paid in it, so the quote was USDC for USDC and could only fail. */}
                {routesInto(t.symbol) ? (
                  <Press
                    onPress={() => router.push(`/route/${t.symbol}`)}
                    accessibilityRole="button"
                    accessibilityLabel={`Inspect the route into ${t.symbol}`}
                    hitHeight={size.hit}
                  >
                    <Text variant="control" color={colors.ink55}>
                      Route ›
                    </Text>
                  </Press>
                ) : null}
                <Press
                  onPress={() => router.push(`/crosscheck/${t.symbol}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`Cross-check the price of ${t.symbol}`}
                  hitHeight={size.hit}
                >
                  <Text variant="control" color={colors.ink55}>
                    Cross-check ›
                  </Text>
                </Press>
              </View>
              </View>
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
