/**
 * Which pools a fill would actually go through, at a size you choose.
 *
 * The order ticket shows the route as one line because that is all it has room for, and the route
 * is the part of a swap that decides what you pay. Size changes it — a hundred dollars and five
 * thousand dollars take different paths through different venues — and there was nowhere to see
 * that happen.
 *
 * This is a quote, not an order. It calls the same endpoint the ticket calls and places nothing.
 *
 * The size steps rather than free-types. The interesting thing here is how the route CHANGES across
 * sizes, and a text field invites someone to type one number and learn nothing.
 *
 * The venues are X Layer's two — Uniswap v3, and OKX DEX where this deployment holds its API key — each with what it
 * would deliver or why it could not say, and the pair named once more at the foot. A failed quote offers a retry wherever asking again could answer differently —
 * a timeout included, which used to leave this screen with no way back.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  Pill,
  PillRow,
  Placeholder,
  Press,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { money, percent, quantity } from '@/format';
import { api } from '@/data/api';
import { NotSignedIn } from '@/data/apiError';
import { useAsync } from '@/data/useAsync';
import { system } from '@/data/system';
import { settlementSymbol } from '@/data/tradable';
import type { SwapQuoteResult } from '@/data/useSwapQuote';
import { FILL_PATH, PAYS_WITH, routesInto } from '@/markets/route';

/** Sizes chosen to straddle where routing usually changes, not to be round for their own sake. */
const SIZES = [100, 500, 2_500, 10_000] as const;

const fillPath = (venue: string) => FILL_PATH[venue] ?? venue;

export default function RouteInspector() {
  const goBack = useGoBack();
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  const [usd, setUsd] = useState<number>(SIZES[1]);

  /*
   * The token the symbol actually settles as. Asking for a route into "BTC" would quote a market
   * this chain does not have; the buy is XBTC, and that is what the router is asked about.
   */
  const into = settlementSymbol(symbol ?? '');
  // A route into what pays for it is USDC for USDC, and can only fail.
  const routable = routesInto(into);

  /*
   * Read here rather than through `useSwapQuote`, which has nothing to retry with. The sizes are
   * pills, not keystrokes, so there is nothing to debounce either.
   */
  const quote = useAsync(
    () =>
      routable
        ? api.get<SwapQuoteResult>(
            `/swap/quote?in=${PAYS_WITH}&out=${encodeURIComponent(into)}&amount=${usd}`,
          )
        : Promise.resolve(null),
    [into, usd, routable],
  );
  // Only the answer for the size on screen: the last size's route under a new pill is another quote.
  const data = quote.loading ? undefined : quote.data;

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Route</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          {`${PAYS_WITH} into ${into}. Quote only.`}
        </Text>
      </View>

      {routable ? (
        <PillRow style={{ marginTop: space.s14 }} contentPadding={space.gutter}>
          {SIZES.map((s) => (
            <Pill key={s} label={money(s)} selected={s === usd} onPress={() => setUsd(s)} />
          ))}
        </PillRow>
      ) : null}

      <Fill style={{ marginTop: space.s12, paddingHorizontal: space.gutter }}>
        {!routable ? (
          <EmptyState text={`Buys are paid in ${PAYS_WITH}, so there is no route into it.`} />
        ) : quote.error ? (
          <ErrorState error={quote.error} onRetry={quote.reload} />
        ) : !data ? (
          <Placeholder height={180} />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30, gap: space.s10 }}
          >
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <Text variant="footnote" color={colors.ink55}>
                YOU WOULD RECEIVE
              </Text>
              <Text variant="screenTitle" style={{ marginTop: space.s6 }}>
                {quantity(data.outAmount)} {into}
              </Text>
              <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
                {`At worst ${quantity(data.minimumOut)}, at ${percent(data.slippagePct, { digits: 1, explicitSign: false })} slippage.`}
              </Text>
            </SheetCard>

            <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
              <Text variant="footnote" color={colors.ink55}>
                ROUTE
              </Text>
              {/* How the fill is split, not whose pools: the router names venues, and this screen does not. */}
              <Text variant="rowPrimary" style={{ marginTop: space.s4 }}>
                {data.venues.length === 0
                  ? 'Direct'
                  : data.venues.length === 1
                    ? 'One venue'
                    : `Split across ${data.venues.length} venues`}
              </Text>
            </SheetCard>

            <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
              <Text variant="footnote" color={colors.ink55}>
                PRICE IMPACT
              </Text>
              {/*
                A dash where it cannot be measured, never a zero. Zero impact is a claim about the
                depth of a pool; "we could not measure it" is a claim about the quote.
              */}
              <Text variant="rowPrimary" style={{ marginTop: space.s4 }}>
                {data.priceImpactPct === null
                  ? '—'
                  : percent(data.priceImpactPct, { digits: 2, explicitSign: false })}
              </Text>
            </SheetCard>

            {/*
              The other two ways to fill, asked the same question.
              `settle.ts` chooses between them in a documented order, and the trail names whichever
              filled — so "the maker book filled this" was a label with nothing behind it. What makes
              it a claim is what the others would have done, refusals included: a maker quotes what
              they hold, and "cannot fill this size" is information rather than an absence.
            */}
            <FillComparison inSymbol={PAYS_WITH} outSymbol={into} amount={usd} />
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}

function FillComparison({
  inSymbol,
  outSymbol,
  amount,
}: {
  inSymbol: string;
  outSymbol: string;
  amount: number;
}) {
  const { data, loading, error, reload } = useAsync(
    () => system.routeCompare(inSymbol, outSymbol, amount),
    [inSymbol, outSymbol, amount],
  );

  /*
   * A failed comparison is one quiet line with a retry, not the screen's error state.
   *
   * The quote above it is the answer the user came for and is already on screen; turning a
   * secondary panel's failure into a screen-level error would replace working content with a
   * retry button. It used to vanish without a word instead, which read as there being no other
   * way to fill.
   */
  if (error) {
    return error instanceof NotSignedIn ? null : (
      <Press
        onPress={reload}
        accessibilityRole="button"
        accessibilityLabel="Compare the ways to fill again"
        hitHeight={size.hit}
      >
        <Text variant="secondarySm" color={colors.ink55}>
          The comparison did not load. Try again ›
        </Text>
      </Press>
    );
  }
  // Loading for this size. The last size's comparison is not this one.
  if (loading || !data) return <Placeholder height={140} />;

  return (
    <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
      <Text variant="footnote" color={colors.ink55}>
        SAME SIZE, EVERY WAY TO FILL
      </Text>
      {data.venues.map((q) => {
        const served = q.outAmount !== null && q.outAmount > 0;
        return (
          <View key={q.venue} style={{ marginTop: space.s10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.s10 }}>
              {/* The winner in full ink, not green: green is profit and loss, and a better quote is neither. */}
              <Text
                variant="secondary"
                color={q.venue === data.best ? colors.ink : colors.ink65}
                style={{ flexShrink: 1 }}
              >
                {fillPath(q.venue)}
              </Text>
              <Text variant="secondary" color={served ? colors.ink : colors.ink55}>
                {served ? `${quantity(q.outAmount!)} ${outSymbol}` : 'Can’t fill this size'}
              </Text>
            </View>
            {/* Why a venue could not answer, in its own words — a missing key reads differently from a thin pool. */}
            {!served && q.unavailable ? (
              <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s2 }}>
                {q.unavailable}
              </Text>
            ) : null}
          </View>
        );
      })}
      {/*
        The margin, only when there was something to beat. `edgeBps` is null when a single venue
        answered, because "0% more" reads as a tie rather than as no competition.
      */}
      <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s12 }}>
        {data.edgeBps !== null && data.best
          ? `${fillPath(data.best)} gives ${percent(data.edgeBps / 100, { digits: 2, explicitSign: false })} more.`
          : data.best
            ? `Only ${fillPath(data.best)} can fill this size.`
            : 'Nothing can fill this size right now.'}
      </Text>
      <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
        Quotes from Uniswap v3 and OKX DEX.
      </Text>
    </SheetCard>
  );
}
