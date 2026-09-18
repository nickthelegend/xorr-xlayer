/**
 * Screen 19 — Swap. screens.md Group B; rebuilt for PLAN.md 3.9.
 *
 * Pay card (surface, radius 26): eyebrow + balance, the amount as typed + USD line, token pill. A 40pt circle
 * with a 3pt ring OVERLAPS THE SEAM (margin −14, zIndex 2) and flips the pair. Receive card mirrors it. Rows:
 * Route / You receive at least / Price impact / Max slippage.
 *
 * It was a fixed WETH → USDC card whose token pills, direction circle and settings gear did nothing, and whose
 * "Review swap" opened a sell ticket at the stop tolerance. Now the pair is picked from what this executor settles
 * (with the tokens' own logos), the amount is typed, the tolerance is chosen and quoted at, and confirming sends the
 * swap itself — `POST /swap`, under the same permission as every other trade — and shows what arrived and where it
 * settled.
 */
import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import { Icon } from '@/design/Icon';
import { assetGradient } from '@/design/gradients';
import {
  AssetMark,
  Button,
  CloseButton,
  EmptyState,
  ErrorState,
  Eyebrow,
  Fill,
  IconButton,
  Keypad,
  Pill,
  Press,
  Price,
  Row,
  Screen,
  Text,
  colors,
  money,
  quantity,
  radius,
  size,
  space,
  SignInButton,
  useSpokenFigure,
  type FigureKind,
  type KeypadKey,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { percent } from '@/format';
import { SWAP_SLIPPAGES, keypadPress, swapRequest, swapSpendable } from '@/state/derived';
import { usePrice } from '@/data/usePrices';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { useIntentKeys } from '@/data/useIntentKeys';
import { apiReason } from '@/data/api';
import { errorText } from '@/data/apiError';
import { logoProps, useLogos } from '@/data/useLogos';
import { useSwapQuote, type SwapQuoteResult } from '@/data/useSwapQuote';
import { system, type SwapOutcome } from '@/data/system';

const CARD_PAD = space.s18;
/** The seam circle. 40pt with a 3pt ring in the screen background, pulled −14 into both cards. */
const SEAM = 40;
const SEAM_RING = 3;
const SEAM_PULL = -14;

export default function Swap() {
  const goBack = useGoBack();
  const [pay, setPay] = useState('USDC');
  const [receive, setReceive] = useState('NVDAx');
  const [amount, setAmount] = useState('0');
  const [slippagePct, setSlippagePct] = useState<number>(0.3);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [picking, setPicking] = useState<'pay' | 'receive' | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [outcome, setOutcome] = useState<SwapOutcome>();

  /*
   * What can be swapped here is what this executor settles. A native coin is left out: the permission moves ERC-20s,
   * and a listed "ETH" would be WETH's alias. Where nothing settles the list is empty, and the screen
   * says so instead of offering a swap that could only be refused.
   *
   * A list that did not load says that, with a retry. It used to leave an empty picker under the default pair,
   * which still looked ready to swap.
   */
  const tradable = useAsync(() => system.tradable(), []);
  const symbols = useMemo(
    () => (tradable.data ?? []).map((t) => t.symbol).filter((s) => s !== 'ETH'),
    [tradable.data],
  );
  const logos = useLogos(symbols);
  const nothingSettles = tradable.data !== undefined && symbols.length === 0;
  // The default pair is a starting point, not something the executor listed: it swaps once the list says both sides do.
  const pairListed = symbols.includes(pay) && symbols.includes(receive);

  // The chain's balance, not the ledger's: what can be paid is what the wallet holds.
  const balance = useAsync(() => repos.portfolio.balance(), []);
  const signedOut = useSignedOut();
  const spendable = swapSpendable(balance.data, pay);
  // A read that failed for someone signed in. Signed out there is no balance to show, and the button already asks for a sign-in.
  const balanceUnread = !signedOut && balance.data === undefined && balance.error !== undefined;
  /*
   * While balances are hidden (FEATURES.md #47) what the wallet holds hides: the balance over the amount, what each
   * token in the picker holds, and a swap once it has filled. What is typed, and the quote for it, stay.
   */
  const say = useSpokenFigure();

  const typed = Number(amount) || 0;
  const quote = useSwapQuote(pay, receive, typed, slippagePct);
  const { quote: payPrice, error: payPriceError } = usePrice(pay);
  const request = swapRequest({ pay, receive, amount, slippagePct });
  const overBalance = spendable !== undefined && typed > spendable;

  /** Any change to what is being swapped ends a review and clears the last result: they described another swap. */
  const edit = (change: () => void) => {
    change();
    setReviewing(false);
    setOutcome(undefined);
  };
  const pressKey = (key: KeypadKey) => edit(() => setAmount((a) => keypadPress(a, key)));
  const flip = () =>
    edit(() => {
      setPay(receive);
      setReceive(pay);
      // An amount of one token is not an amount of the other.
      setAmount('0');
    });
  const choose = (symbol: string) =>
    edit(() => {
      if (picking === 'pay') {
        if (symbol === receive) setReceive(pay);
        if (symbol !== pay) setAmount('0');
        setPay(symbol);
      } else if (picking === 'receive') {
        if (symbol === pay) setPay(receive);
        setReceive(symbol);
      }
      setPicking(null);
    });

  /*
   * The swap's Idempotency-Key (FEATURES.md #29). The request is the ask — pair, amount and tolerance — so Confirm after a
   * timeout sends the same key, and an edit, which ends the review, makes whatever is confirmed next another swap.
   */
  const keys = useIntentKeys();

  async function confirm() {
    if (!request || placing) return;
    setPlacing(true);
    try {
      const result = await keys.send(request, (idempotencyKey) => system.swap(request, { idempotencyKey }));
      setOutcome(result);
      if (result.status === 'filled') {
        setAmount('0');
        balance.reload();
      }
    } catch (e) {
      setOutcome({ status: 'failed', error: errorText(e) });
    } finally {
      setPlacing(false);
      setReviewing(false);
    }
  }

  const q = quote.data;
  const cta =
    outcome?.status === 'filled'
      ? `Swapped ${quantity(outcome.sold)} ${outcome.from} for ${outcome.received === null ? outcome.to : `${quantity(outcome.received)} ${outcome.to}`}`
      : reviewing && q
        ? 'Confirm swap'
        : 'Review swap';

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
          {/* A sheet from the tab bar's centre, so it closes rather than going back. */}
          <CloseButton onPress={() => goBack()} accessibilityLabel="Close swap" />
          <Text variant="cardTitle">Swap</Text>
        </View>
        <IconButton
          name="gear"
          accessibilityLabel={settingsOpen ? 'Hide swap settings' : 'Swap settings'}
          onPress={() => setSettingsOpen((o) => !o)}
        />
      </View>

      {settingsOpen ? (
        <View style={{ marginTop: space.s14, gap: space.s8 }}>
          <Eyebrow small>Max slippage</Eyebrow>
          <View style={{ flexDirection: 'row', gap: space.s8 }}>
            {SWAP_SLIPPAGES.map((pct) => (
              <Pill
                key={pct}
                label={percent(pct, { digits: 1, explicitSign: false })}
                selected={pct === slippagePct}
                onPress={() => edit(() => setSlippagePct(pct))}
              />
            ))}
          </View>
        </View>
      ) : null}

      {tradable.error ? (
        <Fill style={{ justifyContent: 'center' }}>
          <ErrorState error={tradable.error} onRetry={tradable.reload} />
        </Fill>
      ) : nothingSettles ? (
        <Fill style={{ justifyContent: 'center' }}>
          <EmptyState text="Swaps aren’t available on this network." />
        </Fill>
      ) : (
        <Fill style={{ marginTop: space.s18 }}>
          <View style={{ backgroundColor: colors.surface, borderRadius: radius.panelXl, padding: CARD_PAD, gap: space.s12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Eyebrow small>You pay</Eyebrow>
              {signedOut ? null : (
                <Press
                  onPress={balanceUnread ? () => balance.reload() : undefined}
                  accessibilityRole={balanceUnread ? 'button' : undefined}
                  accessibilityLabel={balanceUnread ? `Retry reading your ${pay} balance` : undefined}
                >
                  <Text variant="footnote" color={colors.ink55} figure="units">
                    {/* A dash while the balance loads, never a zero: see the note on `swapSpendable`. An em dash, not a minus sign, which read as a negative balance. */}
                    {balanceUnread
                      ? 'Balance — · tap to retry'
                      : `Balance ${spendable === undefined ? '—' : units(spendable)}`}
                  </Text>
                </Press>
              )}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexShrink: 1 }}>
                <Price variant="amountLg" figure="input">
                  {amount}
                </Price>
                <Text variant="secondarySm" style={{ marginTop: space.s4 }}>
                  {/* A price read that failed is unknown, a dash; "No price" is for a token nothing prices. */}
                  {payPrice?.price !== undefined ? money(typed * payPrice.price) : payPriceError ? '—' : 'No price'}
                </Text>
              </View>
              <TokenPill symbol={pay} onPress={() => setPicking(picking === 'pay' ? null : 'pay')} label="Choose the token you pay" />
            </View>
          </View>

          <View style={{ alignItems: 'center', marginVertical: SEAM_PULL, zIndex: 2 }}>
            <Press
              onPress={flip}
              accessibilityRole="button"
              accessibilityLabel={`Pay ${receive} and receive ${pay} instead`}
              style={{
                width: SEAM,
                height: SEAM,
                borderRadius: radius.full,
                backgroundColor: colors.control,
                borderWidth: SEAM_RING,
                borderColor: colors.bg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="swap" size={18} color={colors.ink} />
            </Press>
          </View>

          <View style={{ backgroundColor: colors.surface, borderRadius: radius.panelXl, padding: CARD_PAD, gap: space.s12 }}>
            <Eyebrow small>You receive</Eyebrow>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexShrink: 1 }}>
                <Price variant="amountLg" figure="market">
                  {q ? quantity(q.outAmount) : '—'}
                </Price>
                <Text variant="secondarySm" numberOfLines={2} style={{ marginTop: space.s4 }}>
                  {q
                    ? `Min ${quantity(q.minimumOut)}`
                    : !(typed > 0)
                      ? 'Enter an amount'
                      : quote.loading
                        ? 'Quoting…'
                        : (apiReason(quote.error) ?? 'No quote')}
                </Text>
              </View>
              <TokenPill
                symbol={receive}
                onPress={() => setPicking(picking === 'receive' ? null : 'receive')}
                label="Choose the token you receive"
              />
            </View>
          </View>

          {picking ? (
            <View style={{ marginTop: space.s18, gap: space.s8 }}>
              <Eyebrow small>{picking === 'pay' ? 'Pay with' : 'Receive'}</Eyebrow>
              {symbols.map((symbol) => {
                const held = swapSpendable(balance.data, symbol);
                return (
                  <Press
                    key={symbol}
                    onPress={() => choose(symbol)}
                    accessibilityRole="button"
                    accessibilityLabel={say(`${symbol}${held === undefined ? '' : `, ${quantity(held)} held`}`, 'units')}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.s12,
                      padding: space.s12,
                      borderRadius: radius.card,
                      backgroundColor: symbol === (picking === 'pay' ? pay : receive) ? colors.control : colors.surface,
                    }}
                  >
                    <AssetMark gradient={assetGradient(symbol)} {...logoProps(logos, symbol)} size={size.markSm} />
                    <Text variant="rowPrimary" style={{ flex: 1 }}>
                      {symbol}
                    </Text>
                    <Text variant="footnote" color={colors.ink55} figure="units">
                      {held === undefined ? '—' : `${units(held)} held`}
                    </Text>
                  </Press>
                );
              })}
            </View>
          ) : (
            <>
              {/* The rows arrive with a quote: four dashes before anything is typed say nothing. */}
              {q ? (
                <View style={{ marginTop: space.s14 }}>
                  <Row
                    title="Minimum received"
                    // The floor, not a fee: xorr charges none, and this is the number the fill is held to on chain.
                    value={<Price figure="market">{`${quantity(q.minimumOut)} ${receive}`}</Price>}
                    height={46}
                  />
                  <Row
                    title="Price impact"
                    value={
                      <Price figure="market">
                        {q.priceImpactPct !== null ? percent(q.priceImpactPct, { digits: 3, explicitSign: false }) : '—'}
                      </Price>
                    }
                    height={46}
                  />
                  <Row
                    title="Network fee"
                    // What sending it costs, and who pays: the executor that sends the swap does (PLAN.md 3.13).
                    value={<Price figure="market">{networkFee(q?.gas)}</Price>}
                    height={46}
                  />
                  <Row
                    title="Max slippage"
                    value={<Price figure="input">{percent(slippagePct, { digits: 1, explicitSign: false })}</Price>}
                    height={46}
                    divider={false}
                  />
                </View>
              ) : null}
              <Fill style={{ justifyContent: 'center' }}>
                <Keypad onPress={pressKey} />
              </Fill>
            </>
          )}
        </Fill>
      )}

      {signedOut ? (
        <SignInButton label="Sign in to swap" style={{ marginTop: space.s14 }} />
      ) : !nothingSettles && !tradable.error ? (
        <Button
          label={cta}
          figure="units"
          variant={outcome?.status === 'filled' ? 'success' : 'primary'}
          style={{ marginTop: space.s14 }}
          loading={placing}
          disabled={outcome?.status !== 'filled' && (!request || overBalance || !q || !pairListed)}
          onPress={() => {
            if (outcome?.status === 'filled') return setOutcome(undefined);
            if (reviewing) return void confirm();
            setReviewing(true);
          }}
        />
      ) : null}

      <SwapNote
        outcome={outcome}
        overBalance={overBalance}
        spendable={spendable}
        pay={pay}
        receive={receive}
        unlisted={tradable.data !== undefined && !nothingSettles && !pairListed}
      />
    </Screen>
  );
}

/** An amount of a token: cents above one unit, four places below it. */
const units = (n: number) => quantity(n, n >= 1 ? 2 : 4);

/** The route's gas, which the executor pays — in dollars when the gas token has a price. */
function networkFee(gas: SwapQuoteResult['gas']): string {
  if (!gas) return '—';
  return gas.feeUsd !== null ? `On us · ≈ ${money(gas.feeUsd)}` : 'On us';
}

/** The one line under the button, only when something is wrong. */
function SwapNote({
  outcome,
  overBalance,
  spendable,
  pay,
  receive,
  unlisted,
}: {
  outcome: SwapOutcome | undefined;
  overBalance: boolean;
  spendable: number | undefined;
  pay: string;
  receive: string;
  /** The pair on screen is not in what this executor lists, so the button stays off; this says why. */
  unlisted: boolean;
}) {
  // What is held hides while balances are hidden; the executor's own sentences are drawn as they came.
  const note: { text: string; color: string; figure?: FigureKind } | null =
    outcome?.status === 'blocked'
      ? { text: outcome.detail, color: colors.down }
      : outcome?.status === 'failed'
        ? { text: outcome.error, color: colors.down }
        : overBalance
          ? {
              text: spendable === 0 ? `You hold no ${pay}.` : `You hold ${quantity(spendable ?? 0)} ${pay}.`,
              color: colors.down,
              figure: 'units',
            }
          : unlisted
            ? { text: `${pay} for ${receive} can’t be swapped here.`, color: colors.ink55 }
            : null;
  if (!note) return null;
  return (
    <Text variant="footnote" color={note.color} align="center" style={{ marginTop: space.s10 }} figure={note.figure}>
      {note.text}
    </Text>
  );
}

function TokenPill({ symbol, onPress, label }: { symbol: string; onPress: () => void; label: string }) {
  return (
    <Press
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.s6,
        height: 36,
        paddingHorizontal: space.s12,
        borderRadius: radius.card,
        backgroundColor: colors.control,
      }}
    >
      <Text variant="control">{symbol}</Text>
      <Icon name="chevron" size={11} color={colors.ink55} />
    </Press>
  );
}
