/**
 * Screen 14 — Order ticket. screens.md Group B. WHITE SHEET, radius 30 30 0 0.
 *
 * Title + close. Buy/Sell segmented on `sheet.fill`. 52/700 amount + unit conversion.
 * Quick pills $100 / $500 / Max. 3×4 numeric keypad. Minimum received and network fee, from the
 * route. CTA "{side} ${amount} of NVDAx" in `candleUp` / `candleDown`, with the reason under it when
 * the wallet cannot cover the order.
 *
 * Keypad rules live in state.md and are implemented in state/derived.ts#keypadPress:
 * max 7 chars, one decimal point, backspace pops, a leading 0 is REPLACED.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  CloseButton,
  FailureNote,
  Fill,
  Keypad,
  Pill,
  Press,
  Price,
  Screen,
  Segmented,
  Text,
  colors,
  money,
  quantity,
  size,
  space,
  SignInButton,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { orderCta } from '@/state/derived';
import { api } from '@/data/api';
import { unitsFor, usePrice } from '@/data/usePrices';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { useIntentKeys } from '@/data/useIntentKeys';
import { useDebounced } from '@/data/useDebounced';
import { useStore } from '@/state/store';
import { DEFAULT_BUY } from '@/data/tradable';
import { useSettleable } from '@/data/useSettleable';
import { ApiError, wasReplayed } from '@/data/apiError';
import { placementOf } from '@/markets/placed';
import type { SwapQuoteResult } from '@/data/useSwapQuote';
import { waitOutWarming } from '@/data/warming';
import { sellMax, ticketLimit } from '@/markets/ticket';

type Side = 'buy' | 'sell';

/**
 * A refusal the executor ANSWERED with, as the error it is.
 *
 * `/orders` and `/positions/close` answer a blocked attempt 409 with a body — `{ status, reason, detail }` —
 * which `repos` hands back as a value rather than throwing. Wrapping it in the same `ApiError` a thrown
 * refusal arrives as means one component reads both, and `failures.ts` finds the code either way.
 */
function refusalOf(
  res: { status?: string; reason?: string; error?: string; detail?: string },
  fallback: string,
  replayed: boolean,
) {
  return new ApiError(409, fallback, { error: res.reason ?? res.error, detail: res.detail ?? fallback }, undefined, undefined, replayed);
}

const SIDES = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
] as const satisfies readonly { value: Side; label: string }[];

const QUICK = ['$100', '$500', 'Max'] as const;

export default function OrderTicket() {
  const { symbol = DEFAULT_BUY, side: sideParam } = useLocalSearchParams<{
    symbol: string;
    side?: string;
  }>();
  const goBack = useGoBack();
  /*
   * An order ticket for something this chain cannot settle is a ticket that can never be filled.
   * The asset screen already refuses to offer a Buy for one; the ticket itself was still reachable
   * directly and happily said "Buy $250 of NOPE".
   *
   * Asked of the EXECUTOR, not of the static list. The two disagree on the tokenized equities:
   * their addresses are real on X Layer mainnet and do not exist on the testnet, so the constant said
   * tradable while the chain said otherwise, and this screen rendered a live price and an enabled
   * Buy for a fill that reverts.
   *
   * The pre-answer default used to be the static list, on the reasoning that refusing a perfectly
   * good trade for the second before the fetch lands would be its own bug. That second is not a
   * second against this executor — the Buy pair stayed live for several visible seconds on a
   * simulator — and an enabled Buy is a promise. So the wait is now a state of its own: drawn in
   * place, disabled, live only once the answer says so.
   */
  // 'checking' is rendered, not guessed through — see useSettleable. The CTA is drawn in place
  // and disabled until the executor confirms this symbol can settle here.
  const settleable = useSettleable(symbol);
  const tradable = settleable !== 'no';

  const orderAmt = useStore((s) => s.orderAmt);
  const pressKey = useStore((s) => s.pressKey);
  const setOrderAmt = useStore((s) => s.setOrderAmt);
  const side = useStore((s) => s.side);
  const setSide = useStore((s) => s.setSide);

  React.useEffect(() => {
    if (sideParam === 'buy' || sideParam === 'sell') setSide(sideParam);
  }, [sideParam, setSide]);

  /*
   * The bot can only trade what has settled, so the ticket has to know the balance. "Max"
   * used to be the string '4862' — the handoff's design total — which was both a hardcoded
   * number and the wrong one, and nothing stopped a user composing an order past their holdings.
   *
   * It then read `repos.wallet.balance().usd`, which is the wallet's TOTAL value — cash plus
   * open positions plus USDC supplied to Aave. None of the last two can pay for a swap. On a
   * wallet holding $24,207 of cash inside $24,993 of value, "Max" composed a $24,993 buy, passed
   * the over-balance guard, and could only fail at the venue. `cash` is the number that can
   * actually be spent, and it is the one the home screen's "Available to trade" row already uses.
   */
  const balanceRead = useAsync(() => repos.portfolio.balance(), []);
  const signedOut = useSignedOut();
  const availableUsd = balanceRead.data?.cash;
  // A cash read that failed, for someone signed in. Max stays off without the number, and that should not be a mystery.
  const cashUnread = !signedOut && balanceRead.data === undefined && balanceRead.error !== undefined;

  // A SELL is not a spend. It reduces a position the user already holds, so what caps it is
  // the position, not the balance — and it goes through the same close path screen 22 uses
  // rather than a second implementation of selling.
  const positions = useAsync(() => repos.portfolio.positions(), []);
  const held = (positions.data ?? []).find((p) => p.symbol === symbol);
  const heldUsd = held?.notional;
  /*
   * What a sale is checked against: the position's value once the book has answered — no position is
   * 0 — and nothing before it has. With no position the ceiling used to be `undefined`, which read as
   * "no limit", so "Sell $250 of WETH" stayed live for a token the wallet did not hold.
   */
  const heldRead: number | 'loading' | 'unread' = positions.error
    ? 'unread'
    : positions.data === undefined
      ? 'loading'
      : (heldUsd ?? 0);

  const amount = parseFloat(orderAmt || '0') || 0;

  /*
   * The REAL cost of this trade, from the route that would fill it.
   *
   * This row said "Fee (0.1%)" and showed `amount * 0.001` — a number nobody charges. xorr takes
   * no fee, and the venue's cost is whatever the route costs, which varies by size and by venue.
   * A confident $0.25 on the ticket is the same class of invention as a stale price: specific,
   * plausible and untrue.
   *
   * `/swap/quote` is a real Uniswap v3 quote, read from the pools. It is asked for the amount actually entered, so the
   * number moves with the size the way a real cost does — and when it cannot be answered the row
   * says so rather than falling back to arithmetic.
   */
  /*
   * Debounced, and that is not a nicety — see useDebounced. Every keypress fired a real venue
   * quote, and the executor serialised them in one lane, so the swap the ORDER needed queued
   * behind the quotes drawn for the "At worst" line. One measured buy waited 153 seconds and then
   * failed on slippage, because the price had moved while it waited for its own decoration.
   */
  const quoted = useDebounced(amount);
  const quoteFor = quoted > 0 && symbol ? `${side}:${symbol}:${quoted}:${held?.mark ?? 0}` : '';
  // A quote the executor could not get in time is `warming`: waited out, as the swap screen waits it out (E187).
  const routeQuote = useAsync(
    () =>
      quoted > 0 && (side === 'buy' || (held?.mark ?? 0) > 0)
        ? waitOutWarming(() =>
            api.get<{ minimumOut: number; venues: string[]; slippagePct: number; gas?: SwapQuoteResult['gas'] }>(
              side === 'buy'
                ? `/swap/quote?in=USDC&out=${encodeURIComponent(symbol)}&amount=${quoted}`
                : // A sell is entered in dollars; the route is quoted in units, so it needs the
                  // mark. Only a held position can be sold, and a held position has one.
                  `/swap/quote?in=${encodeURIComponent(symbol)}&out=USDC&amount=${quoted / (held?.mark || 1)}`,
            ),
          )
        : Promise.resolve(null),
    [quoteFor],
  );
  /*
   * `text` as well as the parsed amount: `0.001` and `0.00` are different states and `parseFloat` makes
   * them one. The first is an order under the executor's floor and the second is an empty field.
   */
  const limit = ticketLimit({
    side,
    symbol,
    amountUsd: amount,
    cashUsd: availableUsd,
    held: heldRead,
    text: orderAmt,
  });
  /** What Max inserts: the cash for a buy, and for a sale the holding — which Max used to ignore, composing a sale of the cash. */
  const maxUsd = side === 'sell' ? (typeof heldRead === 'number' ? heldRead : undefined) : availableUsd;

  // The conversion a user acts on must come from the market, not from a design constant.
  const { quote, error: priceError } = usePrice(symbol);

  const [placing, setPlacing] = useState(false);
  /*
   * What the attempt came back with, kept as it came.
   *
   * This used to be `errorText(e)` — a string, assigned at the catch — which threw away everything except the
   * sentence: whether repeating it could answer differently, whether a transaction may have gone out, and
   * which screen fixes it. `FailureNote` reads all three off the error itself (`failures.ts`), so it is the
   * error that is kept. A refusal the executor answered with rather than threw is wrapped as one, so both
   * arrive here in the same shape.
   */
  const [refusal, setRefusal] = useState<unknown>();
  /*
   * What came back, once something did.
   *
   * `replayed` is the executor saying this key had already been answered: the order filled once, a while
   * ago, and this tap placed nothing. Without it the ticket rendered the first attempt's confirmation a
   * second time, so the mechanism that prevented a double spend looked exactly like one. See
   * `markets/placed.ts`.
   */
  const [filled, setFilled] = useState<{ units: number; price: number; replayed: boolean }>();
  /*
   * The order's Idempotency-Key (FEATURES.md #29). An order that timed out may have filled; the same order tapped again
   * carries the same key, and the executor answers with what the first one did rather than filling it twice.
   */
  const keys = useIntentKeys();

  async function place() {
    if (amount <= 0 || placing) return;
    setPlacing(true);
    setRefusal(undefined);
    try {
      if (side === 'sell') {
        if (!held || !heldUsd) {
          setRefusal(`You do not hold any ${symbol}.`);
          return;
        }
        // A USD amount, expressed as the fraction of the holding it represents — which is
        // what the executor needs to compute an exact on-chain balance to sell.
        const fraction = Math.min(1, amount / heldUsd);
        // The key follows the dollars entered, not the fraction: that is worked out from the position's value as last
        // read, and the same sale asked for again must stay one sale whatever that value does.
        const res = await keys.send({ side, symbol, usd: amount }, (idempotencyKey) =>
          repos.portfolio.close({ symbol, fraction }, { idempotencyKey }),
        );
        if (res.status === 'closed') {
          setFilled({
            units: res.units ?? 0,
            price: (res.usd ?? 0) / (res.units || 1),
            replayed: wasReplayed(res),
          });
          // A replay is read, not glanced at: it says the tap did nothing, which takes longer than a fill.
          setTimeout(() => goBack(), wasReplayed(res) ? 2600 : 1200);
        } else {
          setRefusal(refusalOf(res, `The sale came back "${res.status}".`, wasReplayed(res)));
        }
        return;
      }

      const res = await keys.send({ side, symbol, usd: amount }, (idempotencyKey) =>
        repos.orders.place({ symbol, usd: amount }, { idempotencyKey }),
      );
      if (res.status === 'filled') {
        setFilled({ units: res.units ?? 0, price: res.price ?? 0, replayed: wasReplayed(res) });
        // Let the fill land on screen before the sheet goes; a ticket that closes the
        // instant you tap it leaves you unsure whether anything happened. An "already filled" has a
        // sentence under it and takes longer to read, so it gets longer.
        setTimeout(() => goBack(), wasReplayed(res) ? 2600 : 1200);
      } else {
        // The policy engine's own sentence — "the daily cap is spent", not "409" — and its code with it, so
        // the note below can offer the screen that fixes it.
        setRefusal(refusalOf(res, `The order came back "${res.status}".`, wasReplayed(res)));
      }
    } catch (e) {
      setRefusal(e);
    } finally {
      setPlacing(false);
    }
  }

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

      <View style={{ alignItems: 'center', marginTop: space.s26, gap: space.s6 }}>
        {/* Being typed, so never masked: an order its author cannot read is not private, it is unusable. */}
        <Price variant="heroAmount" color={colors.sheet.ink} figure="input">
          ${orderAmt}
        </Price>
        <Text variant="body" color={colors.sheet.muted}>
          {unitsFor(amount, quote, symbol, priceError !== undefined)}
        </Text>
      </View>

      <View
        style={{
          flexDirection: 'row',
          gap: space.s8,
          marginTop: space.s20,
          justifyContent: 'center',
        }}
      >
        {QUICK.map((q) => {
          /*
           * "Max" with no balance yet used to CLEAR the field.
           *
           * `availableUsd === undefined ? ''` — so on a ticket opened before `/wallet/balance`
           * answered, which against this executor is the first twenty seconds, tapping Max wiped
           * the $250 the screen had just proposed and disabled the button. A control that destroys
           * the user's input because our own data is late is worse than one that does nothing, so
           * it is disabled until the number it inserts is actually known.
           */
          const maxUnknown = q === 'Max' && maxUsd === undefined;
          return (
            <Pill
              key={q}
              label={q}
              light
              disabled={maxUnknown}
              onPress={
                maxUnknown
                  ? undefined
                  : () =>
                      setOrderAmt(
                        q !== 'Max'
                          ? q.slice(1)
                          : side === 'sell'
                            ? sellMax(maxUsd!)
                            : String(Math.floor(maxUsd!)),
                      )
              }
            />
          );
        })}
      </View>

      <Fill style={{ marginTop: space.s12, justifyContent: 'center' }}>
        <Keypad light onPress={pressKey} />
      </Fill>

      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingVertical: space.s12,
        }}
      >
        <Text variant="secondary" color={colors.sheet.muted}>
          Minimum received
        </Text>
        {/* The route's quote for the amount typed, not a holding: it stays while balances are hidden. */}
        <Price variant="secondary" color={colors.sheet.ink} figure="market">
          {routeQuote.loading
            ? '…'
            : routeQuote.data
              ? `${quantity(routeQuote.data.minimumOut)} ${side === 'buy' ? symbol : 'USDC'}`
              : '—'}
        </Price>
      </View>
      {/* What sending it costs, and who pays it: the executor, which sends every order (PLAN.md 3.13). */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingBottom: space.s12 }}>
        <Text variant="secondary" color={colors.sheet.muted}>
          Network fee
        </Text>
        <Price variant="secondary" color={colors.sheet.ink} figure="market">
          {routeQuote.loading
            ? '…'
            : typeof routeQuote.data?.gas?.feeUsd === 'number'
              ? `On us · ≈ ${money(routeQuote.data.gas.feeUsd)}`
              : '—'}
        </Price>
      </View>

      {signedOut ? (
        <SignInButton
          label="Sign in to trade"
          backgroundColor={side === 'buy' ? colors.candleUp : colors.candleDown}
          color={colors.ink}
        />
      ) : tradable ? (
        <Button
          label={
            filled
              ? placementOf({ side, symbol, units: filled.units, replayed: filled.replayed }).label
              : orderCta(side, orderAmt, symbol)
          }
          // What filled is the person's money and hides while balances are hidden; the order being typed does not.
          figure={filled ? 'units' : undefined}
          backgroundColor={side === 'buy' ? colors.candleUp : colors.candleDown}
          color={colors.ink}
          disabled={
            settleable === 'checking' || limit.state !== 'ok' || amount <= 0 || filled !== undefined
          }
          loading={placing}
          onPress={place}
        />
      ) : (
        <View style={{ paddingVertical: space.s14, alignItems: 'center' }}>
          <Text variant="secondary" color={colors.sheet.muted} align="center">
            {/* "Here", not a chain's name: an equity trades on X Layer mainnet and its fork but not on the testnet, and no network is named off the money screens. */}
            Not tradable here
          </Text>
        </View>
      )}
      {/*
        A duplicate submit, said in as many words.

        The executor answered this key before and handed back what that attempt did, so nothing was placed
        here. The button already says "Already bought"; this is the sentence that makes it unambiguous.
      */}
      {filled?.replayed ? (
        <Text
          variant="footnote"
          color={colors.sheet.muted}
          align="center"
          style={{ marginTop: space.s10 }}
          accessibilityLiveRegion="polite"
        >
          {placementOf({ side, symbol, units: filled.units, replayed: true }).note}
        </Text>
      ) : null}
      {refusal !== undefined ? (
        <FailureNote error={refusal} light style={{ marginTop: space.s10 }} />
      ) : null}
      {/*
        Why the order cannot go, on the ticket: nothing held, more than is held, more than the cash, and now
        the amount's own rules — under a cent, over the executor's ceiling, finer than a cent.

        Only the balance sentences are the person's money. "You have $1,234.00." hides while balances are
        hidden (FEATURES.md #47); "The smallest order is $0.01." is a property of the executor and masking it
        would hide the one number that says what to type instead.
      */}
      {limit.state === 'refused' && tradable && !signedOut && filled === undefined ? (
        <Text
          variant="footnote"
          color={colors.down}
          align="center"
          style={{ marginTop: space.s10 }}
          figure={limit.code === undefined || limit.code === 'insufficient' ? 'own' : undefined}
          accessibilityLiveRegion="polite"
        >
          {limit.reason}
        </Text>
      ) : null}
      {side === 'buy' && cashUnread && tradable && filled === undefined ? (
        <Press
          onPress={balanceRead.reload}
          accessibilityRole="button"
          accessibilityLabel="Read your balance again"
          hitHeight={size.hit}
          style={{ marginTop: space.s10, alignSelf: 'center' }}
        >
          <Text variant="footnote" color={colors.sheet.muted} align="center">
            Your balance did not load. Try again ›
          </Text>
        </Press>
      ) : null}

    </Screen>
  );
}
