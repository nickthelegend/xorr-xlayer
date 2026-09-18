/**
 * What an xStock order costs, shown before anyone agrees to it.
 *
 * The order ticket has always shown a size and a button. Between them is everything that decides
 * what the person ends up holding — the venue's price impact at this size, the tolerance the swap
 * would be sent with, the pools it routes through — and none of it was on screen. A ticket that
 * hides those asks somebody to agree to a number it has not shown them.
 *
 * Every figure here comes from a real Uniswap v3 quote for the real size, re-asked as the size changes
 * and debounced so the quoter is not asked on every keypress. A figure the venue did not
 * report says "Not reported"; it never becomes a zero, which on this screen would read as a cost
 * that was measured and found to be nothing.
 *
 * The confirm is deliberately not here. `executor/place.ts` is the only path that can spend, and no
 * HTTP route reaches it for an xStock yet — so this screen says what the order would cost and
 * says plainly that it cannot yet be placed from the phone. A button that did nothing would be the
 * worse answer, and a button that pretended would be the worst.
 */
import React, { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  CloseButton,
  FailureNote,
  Keypad,
  Pill,
  Price,
  Screen,
  Segmented,
  Text,
  colors,
  money,
  price as fmtPrice,
  quantity,
  size,
  space,
} from '@/ui';
import { useAsync } from '@/data/useAsync';
import { useDebounced } from '@/data/useDebounced';
import { useStore } from '@/state/store';
import { system } from '@/data/system';
import { breakdownRows, worstCase } from '@/markets/breakdown';

const SIDES = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
] as const;

const QUICK = ['$100', '$250', '$500'] as const;

const FORMAT = { money, quantity, price: fmtPrice };

export default function XStockTicket() {
  const { symbol = '' } = useLocalSearchParams<{ symbol: string }>();
  const goBack = useGoBack();

  // The same store the order ticket types into, so moving between the two keeps the amount.
  const orderAmt = useStore((s) => s.orderAmt);
  const pressKey = useStore((s) => s.pressKey);
  const setOrderAmt = useStore((s) => s.setOrderAmt);
  const side = useStore((s) => s.side);
  const setSide = useStore((s) => s.setSide);

  const amount = parseFloat(orderAmt || '0') || 0;

  /*
   * Debounced, and not as a nicety.
   *
   * Every keypress would otherwise be a real quote at the aggregator, and the order ticket learned
   * this the expensive way: the swap an order needed queued behind the quotes drawn for its own
   * decoration, and one measured buy waited 153 seconds before failing on a price that had moved.
   */
  const quoted = useDebounced(amount);
  const quote = useAsync(
    () =>
      quoted > 0 && symbol
        ? system.xstockQuote({ symbol, side, usd: quoted })
        : Promise.resolve(null),
    [symbol, side, quoted],
  );

  const rows = useMemo(
    () => (quote.data ? breakdownRows(quote.data, FORMAT) : []),
    [quote.data],
  );

  return (
    <Screen light gutter="sheet">
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="sheetTitle" color={colors.sheet.ink}>
          {symbol}
        </Text>
        <CloseButton onPress={() => goBack()} light />
      </View>

      <Segmented
        options={SIDES}
        value={side}
        onChange={setSide}
        light
        height={size.segThumb}
        style={{ marginTop: space.s18 }}
      />

      <View style={{ alignItems: 'center', marginTop: space.s20, gap: space.s6 }}>
        {/* Being typed, so never masked: an order its author cannot read is not private, it is unusable. */}
        <Price variant="heroAmount" color={colors.sheet.ink} figure="input">
          ${orderAmt}
        </Price>
        <Text variant="body" color={colors.sheet.muted}>
          {quote.data ? worstCase(quote.data, FORMAT) : `${side === 'buy' ? 'Buying' : 'Selling'} ${symbol}`}
        </Text>
      </View>

      <View
        style={{ flexDirection: 'row', gap: space.s8, marginTop: space.s16, justifyContent: 'center' }}
      >
        {QUICK.map((q) => (
          <Pill key={q} label={q} light onPress={() => setOrderAmt(q.slice(1))} />
        ))}
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingVertical: space.s12 }}
        style={{ flex: 1, marginTop: space.s12 }}
      >
        {amount <= 0 ? (
          <Text variant="secondary" color={colors.sheet.muted} align="center" style={{ paddingVertical: space.s20 }}>
            Enter an amount to see what it costs.
          </Text>
        ) : quote.error ? (
          /*
            No quote is a real answer, and `failures.ts` already knows how to say which kind it is —
            nobody would price this, or the ask never landed. A breakdown of zeroes in its place
            would read as a free trade.
          */
          <FailureNote error={quote.error} light style={{ marginTop: space.s10 }} />
        ) : quote.loading || !quote.data ? (
          <Text variant="secondary" color={colors.sheet.muted} align="center" style={{ paddingVertical: space.s20 }}>
            Asking the venue…
          </Text>
        ) : (
          rows.map((r) => (
            <View
              key={r.label}
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                paddingVertical: space.s10,
                gap: space.s12,
              }}
            >
              <Text variant="secondary" color={colors.sheet.muted}>
                {r.label}
              </Text>
              <View style={{ alignItems: 'flex-end', flexShrink: 1 }}>
                {/* Market figures, not this person's money: they stay legible while balances are hidden. */}
                <Price
                  variant="secondary"
                  color={r.cost ? colors.down : colors.sheet.ink}
                  figure="market"
                  numberOfLines={1}
                >
                  {r.value}
                </Price>
                {r.note ? (
                  <Text
                    variant="footnote"
                    color={colors.sheet.muted}
                    align="right"
                    style={{ marginTop: space.s2 }}
                    figure="market"
                  >
                    {r.note}
                  </Text>
                ) : null}
              </View>
            </View>
          ))
        )}
      </ScrollView>

      <Keypad light onPress={pressKey} />

      {/*
        Said once, plainly, where a CTA would be.

        The executor can spend — `guardAndSpend` does, and the on-chain proofs run through it — but
        nothing serves that path over HTTP for an equity yet. Offering a button here would promise a
        thing the app cannot do; leaving the space blank would leave someone waiting for one.
      */}
      <Text
        variant="footnote"
        color={colors.sheet.muted}
        align="center"
        style={{ paddingVertical: space.s14 }}
      >
        Costs only. Placing an xStock order from the phone is not wired up yet.
      </Text>
    </Screen>
  );
}
