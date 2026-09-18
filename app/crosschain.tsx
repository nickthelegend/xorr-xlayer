/**
 * Cross-chain quote — PLAN.md 3.16. Styled after Swap (screen 19).
 *
 * What USDC or WETH sent from Base would arrive as on another chain, quoted by 1inch Fusion+. The destination is a pill
 * row drawn from the executor's own registry, the token a two-way switch, and the amount is typed on the keypad. Each
 * auction preset shows what arrives — the most, at the auction's opening price, and the least the price may fall to —
 * how long the auction runs, and what 1inch estimates filling costs.
 *
 * There is no button to send it. Submitting a Fusion+ order locks real funds on Base mainnet, which this app does not
 * do, so the screen says so in a sentence rather than leaving a disabled control to explain itself.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  ErrorState,
  Eyebrow,
  Fill,
  Keypad,
  LoadingRows,
  Pill,
  PillRow,
  Placeholder,
  Price,
  Row,
  Screen,
  Segmented,
  Text,
  colors,
  money,
  quantity,
  radius,
  size,
  space,
  type KeypadKey,
  type SegmentedOption,
} from '@/ui';
import { shortAddress } from '@/format';
import { keypadPress } from '@/state/derived';
import { useAsync } from '@/data/useAsync';
import { useDebounced } from '@/data/useDebounced';
import { usePrice } from '@/data/usePrices';
import { ApiError } from '@/data/apiError';
import {
  crosschainDestinations,
  crosschainQuote,
  type CrosschainPreset,
  type CrosschainToken,
} from '@/data/crosschain';

const CARD_PAD = space.s18;
/** Wide enough for USDC and WETH side by side at the small thumb height. */
const TOKEN_SWITCH_W = 140;
const TOKEN_OPTIONS: readonly SegmentedOption<CrosschainToken>[] = [
  { value: 'USDC', label: 'USDC' },
  { value: 'WETH', label: 'WETH' },
];
/** Digits an amount that arrives is shown to: cents for USDC, and five places for WETH, where the fifth is still cents. */
const DIGITS: Record<CrosschainToken, number> = { USDC: 2, WETH: 5 };
/** Digits for a cost 1inch sent no price for, which can be far below a cent's worth of the token. */
const COST_DIGITS: Record<CrosschainToken, number> = { USDC: 4, WETH: 8 };
const PRESET_LABEL: Record<CrosschainPreset['name'], string> = { fast: 'Fast', medium: 'Medium', slow: 'Slow' };

/** The typed amount as the executor takes it — without a trailing point — or null while it is zero. */
function askable(typed: string): string | null {
  const s = typed.endsWith('.') ? typed.slice(0, -1) : typed;
  return Number(s) > 0 ? s : null;
}

export default function CrosschainQuoteScreen() {
  const goBack = useGoBack();
  const [picked, setPicked] = useState<number>();
  const [token, setToken] = useState<CrosschainToken>('USDC');
  const [amount, setAmount] = useState('0');

  // The chains the route accepts, from the route: a pill on screen is a chain the executor will quote.
  const destinations = useAsync(() => crosschainDestinations(), []);
  const chains = destinations.data?.destinations ?? [];
  /*
   * Where the quote starts, as the executor names it. It was written here as "Base", and "here" would be
   * wrong the other way: on a test build the quoter still prices the mainnet this is sent from.
   */
  const origin = destinations.data?.from.name;
  const chain = chains.find((d) => d.chainId === picked) ?? chains[0];

  const { quote: price, error: priceError } = usePrice(token);
  const typed = askable(amount);
  // Asked once the amount stops changing. Every keypress would otherwise be a call against the shared 1inch key.
  const debounced = useDebounced(amount);
  const settled = askable(debounced);
  const quote = useAsync(
    () =>
      chain && settled !== null
        ? crosschainQuote({ to: chain.chainId, token, amount: settled })
        : Promise.resolve(null),
    [chain?.chainId, token, settled],
  );
  // Only ever the answer for the amount on screen — never the last amount's quote while the new one is asked.
  const pending = typed !== null && (!chain || typed !== settled || quote.loading);
  const q = pending ? undefined : (quote.data ?? undefined);
  // 1inch saying no says it again until the question changes, so only "did not answer" offers to ask again.
  const refused =
    quote.error instanceof ApiError &&
    (quote.error.body as { error?: unknown } | undefined)?.error === 'quoter_refused';

  const chooseToken = (next: CrosschainToken) => {
    if (next === token) return;
    setToken(next);
    // An amount of one token is not an amount of the other.
    setAmount('0');
  };

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
        <BackButton onPress={() => goBack()} />
        <Text variant="cardTitle">Cross-chain quote</Text>
      </View>

      {destinations.error && !destinations.data ? (
        <Fill style={{ justifyContent: 'center' }}>
          <ErrorState error={destinations.error} onRetry={destinations.reload} />
        </Fill>
      ) : (
        <>
          <View style={{ marginTop: space.s14, gap: space.s8 }}>
            <Eyebrow small>{origin ? `From ${origin} to` : 'To'}</Eyebrow>
            {chains.length > 0 ? (
              <PillRow>
                {chains.map((d) => (
                  <Pill
                    key={d.chainId}
                    label={d.name}
                    selected={d.chainId === chain?.chainId}
                    onPress={() => setPicked(d.chainId)}
                  />
                ))}
              </PillRow>
            ) : (
              <Placeholder height={size.pillH} width="70%" />
            )}
          </View>

          <View
            style={{
              marginTop: space.s14,
              backgroundColor: colors.surface,
              borderRadius: radius.panelXl,
              padding: CARD_PAD,
              gap: space.s12,
            }}
          >
            <Eyebrow small>{origin ? `You send on ${origin}` : 'You send'}</Eyebrow>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s12 }}>
              <View style={{ flexShrink: 1 }}>
                {/* Being typed, so never masked; the dollars under it and the quotes below are for this size, not a balance. */}
                <Price variant="amountLg" figure="input">
                  {amount}
                </Price>
                <Text variant="secondarySm" style={{ marginTop: space.s4 }}>
                  {/* A price read that failed is unknown, a dash; "No price" is for a token nothing prices. */}
                  {price?.price !== undefined ? money((Number(amount) || 0) * price.price) : priceError ? '—' : 'No price'}
                </Text>
              </View>
              <Segmented
                options={TOKEN_OPTIONS}
                value={token}
                onChange={chooseToken}
                height={size.segThumbSm}
                style={{ width: TOKEN_SWITCH_W }}
              />
            </View>
          </View>

          <Fill style={{ marginTop: space.s14 }}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Eyebrow small>{chain ? `Arrives on ${chain.name}` : 'Arrives'}</Eyebrow>
                {chain ? (
                  <Text variant="footnote" color={colors.ink55}>
                    {`${token} ${shortAddress(chain.tokens[token].address)}`}
                  </Text>
                ) : null}
              </View>
              {typed === null ? (
                <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s8 }}>
                  Enter an amount.
                </Text>
              ) : pending ? (
                <LoadingRows count={3} height={size.row} />
              ) : quote.error ? (
                <ErrorState error={quote.error} onRetry={refused ? undefined : quote.reload} />
              ) : q ? (
                q.presets.map((p, i) => (
                  <PresetRow key={p.name} preset={p} token={token} last={i === q.presets.length - 1} />
                ))
              ) : null}
            </ScrollView>
          </Fill>

          <Keypad
            onPress={(key: KeypadKey) => setAmount((a) => keypadPress(a, key))}
            style={{ marginTop: space.s10 }}
          />
        </>
      )}

      <Text variant="footnote" color={colors.ink55} align="center" style={{ marginTop: space.s10 }}>
        Quotes only.
      </Text>
    </Screen>
  );
}

/** One auction preset: its pace and cost on the left, what arrives on the right. */
function PresetRow({ preset, token, last }: { preset: CrosschainPreset; token: CrosschainToken; last: boolean }) {
  const digits = DIGITS[token];
  return (
    <Row
      title={`${PRESET_LABEL[preset.name]} · ${span(preset.auctionSeconds)} auction`}
      secondary={`${preset.recommended ? 'Recommended · ' : ''}Est. cost ${costText(preset, token)}`}
      value={`${quantity(preset.receiveMost, digits)} ${token}`}
      delta={`at least ${quantity(preset.receiveLeast, digits)}`}
      figure="market"
      divider={!last}
    />
  );
}

/** "3 min". 1inch's auctions run in whole minutes; anything shorter reads in seconds. */
function span(seconds: number): string {
  return seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds}s`;
}

/** 1inch's estimate of the fill cost: in dollars at 1inch's price, or in the token when it sent no price. */
function costText(p: CrosschainPreset, token: CrosschainToken): string {
  if (p.costUsd === null) return `${quantity(p.costInToken, COST_DIGITS[token])} ${token}`;
  // A cent is the smallest step `money` shows, and "$0.00" would read as free.
  return p.costUsd < 0.01 ? `under ${money(0.01)}` : money(p.costUsd);
}
