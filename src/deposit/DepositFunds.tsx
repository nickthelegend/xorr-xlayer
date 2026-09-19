/**
 * What the wallet holds of a deposit, read from the chain every few seconds, and the way to turn USDT0 into USDC
 * (PLAN.md P4.7, P4.12). Shared by Deposit and onboarding's Fund step.
 *
 * The balances are `GET /wallet/tokens`: USDC, USDT0 where this chain has it, and OKB for gas. A placeholder before the
 * first answer; a first read that fails, the failure with a retry. After that the last answer stays through a failed read,
 * with when it was read. A balance that could not be read is never shown as a number.
 *
 * Each answer is set beside the one before it (`src/state/moneyIn.ts`). A balance that rose rolls in at its new figure
 * and the phone taps once — for that arrival, and never for the first answer.
 *
 * Converting is offered when USDT0 is held and never done without the person: a preview with the rate and the minimum
 * received, then their signature.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import type { Address } from 'viem';
import {
  Button,
  ErrorState,
  Eyebrow,
  LoadingRows,
  Price,
  Row,
  SheetCard,
  Text,
  colors,
  quantity,
  radius,
  size,
  space,
} from '@/ui';
import { RollingNumber } from '@/ui/RollingNumber';
import { successTap } from '@/ui/haptics';
import { shortAddress } from '@/format';
import { CHAIN_KEY } from '@/chain';
import { ETH_DIGITS, NO_ARRIVALS, USDC_DIGITS, noteFunds } from '@/state/moneyIn';
import { usePoll } from '@/data/usePoll';
import { walletTokens } from '@/data/walletTokens';
import { acceptedTokens, asFundsRead, depositBalances, isUnfunded } from './stablecoins';
import { canConvert, rateText } from './convert';
import { useConvertUsdt0 } from './useConvertUsdt0';

/** Often enough to see a deposit land while you wait for it; each read also prices what it lists, so not faster. */
const POLL_MS = 8_000;

export function DepositFunds({ address }: { address: string | undefined }) {
  const funds = usePoll(walletTokens, POLL_MS);
  const { data, dataAt, error } = funds;
  const balances = useMemo(() => (data ? depositBalances(data, CHAIN_KEY) : undefined), [data]);
  // The balances are of the wallet the executor has on file. If that is not this address, say so.
  const elsewhere =
    balances !== undefined && address !== undefined && balances.owner.toLowerCase() !== address.toLowerCase();

  /*
   * Noted while rendering, the way React has state follow a prop, so a figure and the arrivals it rolls for always come
   * from the same answer.
   */
  const [arrivals, setArrivals] = useState(NO_ARRIVALS);
  const [seen, setSeen] = useState<typeof data>(undefined);
  /** A conversion just finished, so its confirmation is kept on screen after the USDT0 it converted is gone. */
  const [converted, setConverted] = useState(false);
  if (balances !== undefined && data !== seen) {
    setSeen(data);
    setArrivals(noteFunds(arrivals, asFundsRead(balances, CHAIN_KEY)));
  }

  // One tap for each arrival. A render that repeats the count taps for nothing.
  const tapped = useRef(0);
  useEffect(() => {
    if (arrivals.count <= tapped.current) return;
    tapped.current = arrivals.count;
    successTap();
  }, [arrivals.count]);

  return (
    <View>
      <Eyebrow small>Balance</Eyebrow>
      {balances ? (
        <View style={{ marginTop: space.s6 }}>
          <Row
            title="USDC"
            value={<Holding figure={quantity(balances.usdc.amount, USDC_DIGITS)} arrivals={arrivals.usdc} />}
            height={size.rowSm}
          />
          {balances.usdt0 ? (
            <Row
              title="USDT0"
              value={<Holding figure={quantity(balances.usdt0.amount, USDC_DIGITS)} arrivals={arrivals.usdt0} />}
              height={size.rowSm}
            />
          ) : null}
          <Row
            title="OKB"
            secondary="For gas"
            value={<Holding figure={quantity(balances.gas.amount, ETH_DIGITS)} arrivals={arrivals.eth} />}
            height={size.rowSm}
            divider={false}
          />
          {isUnfunded(balances) ? (
            <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s8 }}>
              {`Nothing here yet. Send ${acceptedTokens(CHAIN_KEY)} to the address above.`}
            </Text>
          ) : null}
          {error ? (
            <Text variant="footnote" color={colors.down} style={{ marginTop: space.s8 }}>
              {`Couldn’t refresh · last read ${clock(dataAt)}`}
            </Text>
          ) : null}
          {elsewhere ? (
            <Text variant="footnote" color={colors.down} style={{ marginTop: space.s6 }}>
              {`Showing ${shortAddress(balances.owner)}, not this address.`}
            </Text>
          ) : null}
          {/*
            The card outlives the balance that opened it.
            A conversion ends with the USDT0 at zero, and the refresh that proves it also removed the only card that
            could say so: the swap settled, the confirmation unmounted mid-sentence, and the screen simply had one
            section fewer than before. It stays until the person dismisses it, which is what `Done` is for.
          */}
          {canConvert(CHAIN_KEY) && ((balances.usdt0 && balances.usdt0.amount > 0) || converted) && !elsewhere ? (
            <ConvertUsdt0
              owner={address as Address | undefined}
              hasGas={balances.gas.amount > 0}
              onConverted={() => {
                setConverted(true);
                void funds.refresh();
              }}
              onDismiss={() => setConverted(false)}
            />
          ) : null}
        </View>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void funds.refresh()} />
      ) : (
        <LoadingRows count={3} height={size.rowSm} />
      )}
    </View>
  );
}

/**
 * USDT0 to USDC, as the person decides: a button, then a preview with the rate and the minimum received, then their
 * signature (one or two — an approval first when the router may not yet move the USDT0).
 */
function ConvertUsdt0({
  owner,
  hasGas,
  onConverted,
  onDismiss,
}: {
  owner: Address | undefined;
  hasGas: boolean;
  onConverted: () => void;
  /** Dismissing the confirmation is what lets the card go, now that it is kept open past the balance it converted. */
  onDismiss: () => void;
}) {
  const { state, preview, convert, reset } = useConvertUsdt0(owner, onConverted);
  const shown = 'preview' in state ? state.preview : undefined;

  return (
    <SheetCard bordered borderRadius={radius.panel} padding={space.s16} style={{ marginTop: space.s16 }}>
      <Text variant="body">Convert USDT0 to USDC</Text>
      <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s6 }}>
        Trading uses USDC. You sign this swap yourself, through Uniswap on X Layer, and pay a little OKB for gas.
      </Text>

      {shown && state.step !== 'done' ? (
        <View style={{ marginTop: space.s12 }}>
          <Row title="You pay" value={`${quantity(shown.amountIn, 2)} USDT0`} height={size.rowSm} figure="units" />
          <Row title="You get about" value={`${quantity(shown.outAmount, 2)} USDC`} height={size.rowSm} figure="units" />
          <Row title="Rate" value={rateText(shown.amountIn, shown.outAmount)} height={size.rowSm} />
          <Row
            title="Minimum received"
            value={`${quantity(shown.minimumOut, 2)} USDC`}
            height={size.rowSm}
            figure="units"
            divider={false}
          />
        </View>
      ) : null}

      <View style={{ marginTop: space.s12, gap: space.s10 }}>
        {state.step === 'done' ? (
          <>
            <Text variant="footnote" color={colors.ink} figure="units">
              {`Converted ${quantity(state.preview.amountIn, 2)} USDT0 to USDC.`}
            </Text>
            <Button
              label="Done"
              variant="ghost"
              onPress={() => {
                reset();
                onDismiss();
              }}
            />
          </>
        ) : state.step === 'preview' || state.step === 'signing' || (state.step === 'failed' && state.preview) ? (
          <>
            <Button
              label={
                state.step === 'signing' && state.total > 1
                  ? `Signing ${state.of} of ${state.total}`
                  : 'Convert'
              }
              variant="secondary"
              loading={state.step === 'signing'}
              disabled={!hasGas || !owner}
              onPress={convert}
            />
            {state.step !== 'signing' ? <Button label="Cancel" variant="ghost" onPress={reset} /> : null}
          </>
        ) : (
          <Button
            label="Review conversion"
            variant="secondary"
            loading={state.step === 'quoting'}
            disabled={!owner}
            onPress={preview}
          />
        )}
        {!hasGas && state.step !== 'done' ? (
          <Text variant="footnote" color={colors.ink55} align="center">
            You need a little OKB on X Layer to pay for gas.
          </Text>
        ) : null}
        {state.step === 'failed' ? (
          <Text variant="footnote" color={colors.down} align="center">
            {state.error}
          </Text>
        ) : null}
      </View>
    </SheetCard>
  );
}

/**
 * One balance's figure: still until money lands in it, then rolled in at its true value, once for each arrival — each is
 * a new `key`, and `RollingNumber` rolls a figure as it mounts. Money written in its units, without a dollar sign, so the
 * figure hides while balances are hidden.
 */
function Holding({ figure, arrivals }: { figure: string; arrivals: number }) {
  if (arrivals === 0) return <Price figure="units">{figure}</Price>;
  return <RollingNumber key={arrivals} value={figure} figure="units" />;
}

/** A time to the minute. */
const clock = (at: number | undefined) =>
  at === undefined ? 'unknown' : new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
