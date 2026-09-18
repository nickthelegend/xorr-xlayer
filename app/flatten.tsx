/**
 * Sell everything, now.
 *
 * The safety screen already had "Stop all agents", and stopping is not the same as getting
 * out. A person who wants their money in cash had to revoke the permission and then place
 * every sell by hand on a screen designed for one considered trade at a time — at exactly
 * the moment they were least able to do that carefully.
 *
 * The screen's job is to make the consequences legible BEFORE the tap, and then to be
 * completely honest about the outcome. Two things it deliberately does:
 *
 *   - It shows what it would sell, priced, before you commit. A destructive action that will
 *     not tell you what it is about to destroy is not a confirmation, it is a dare.
 *   - It reports each position separately afterwards. A flatten that sold three of four and
 *     said "done" would be lying about the fourth, and the fourth is the one still exposed.
 *
 * Distilled 2026-09-14 (PLAN.md O3): the same facts, a line each.
 */
import React, { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  CloseButton,
  Eyebrow,
  Fill,
  Price,
  Screen,
  SheetCard,
  Tag,
  Text,
  colors,
  divider,
  money,
  quantity,
  radius,
  size,
  space,
  SignInPrompt,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { repos } from '@/data';
import { api } from '@/data/api';
import { useAsync } from '@/data/useAsync';
import { useIntentKeys } from '@/data/useIntentKeys';
import { errorText } from '@/data/apiError';
import { useStore } from '@/state/store';
import { delegationOrUnknown, delegationScope } from '@/accounts/delegationScope';
import { sellBlocked } from '@/wallet/withdrawEverything';

type Leg = { symbol: string; units: number; usd: number };
/* The last three are absent for a wallet the executor has no row for, which has only `legs` and `totalUsd`. */
type Preview = {
  legs: Leg[];
  totalUsd: number;
  dustBelowUsd?: number;
  skipped?: string[];
  slippagePct?: number;
};
type ResultLeg = Leg & { status: 'sold' | 'failed' | 'skipped'; detail: string; explorer?: string };
type Result = { legs: ResultLeg[]; sold: number; failed: number };

export default function Flatten() {
  const goBack = useGoBack();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<string>();

  const preview = useAsync(() => api.get<Preview>('/panic/preview'), []);
  const signedOut = useSignedOut();
  /*
   * Whether the bot can sell at all. Every leg is a `closePosition`, which reverts on a revoked or expired permission
   * (XorrDelegation.sol), so after "Stop all agents" this button could only fail. The chain is asked here; the store's
   * copy, from whatever this session last read, stands in until it answers, and nothing read yet is no claim.
   */
  const permission = useAsync(() => repos.wallet.delegation(), []);
  /*
   * The cached permission ONLY when it belongs to the address in use.
   *
   * A switch re-points every executor call at another account; carrying the old grant across would
   * show one account's cap while the executor acts on another. `undefined` is "not read yet",
   * which is what every reader here already treats as still-loading — `null` is a claim that this
   * address has granted nothing, and must never stand in for not having looked.
   */
  const storedPermission = delegationOrUnknown(
    delegationScope({
      cached: useStore((s) => s.delegation),
      cachedFor: useStore((s) => s.delegationAddress),
      active: useStore((s) => s.wallet?.address),
    }),
  );
  const blocked = sellBlocked(permission.data !== undefined ? permission.data : (storedPermission ?? undefined));

  /*
   * Selling everything is the one press that must never happen twice. It went out with no key, so a timeout followed by a
   * second press could sell what the first had already sold into. The same press after an unknown outcome now carries the
   * same key, and the executor answers it with the first attempt instead of a second run.
   */
  const keys = useIntentKeys();
  const flatten = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await keys.send('flatten', (idempotencyKey) => api.post<Result>('/panic/flatten', {}, { idempotencyKey })));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [keys]);

  const p = preview.data;
  const nothingToDo = !!p && p.legs.length === 0;

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text variant="screenTitle">Sell everything</Text>
      <CloseButton onPress={() => goBack()} />
    </View>
  );

  // Signed out there are no positions to preview and nothing a button could sell.
  if (signedOut) {
    return (
      <Screen>
        {header}
        <SignInPrompt text="Sign in to sell." />
      </Screen>
    );
  }

  return (
    <Screen>
      {header}

      <Text variant="body" color={colors.ink55} style={{ marginTop: space.s10 }}>
        Every position to USDC, in your own wallet. Your permission is untouched.
      </Text>

      <Fill style={{ marginTop: space.s16 }}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {result ? (
            <Outcome result={result} />
          ) : preview.loading && !p ? (
            <Text variant="body" color={colors.ink55}>
              Reading your positions…
            </Text>
          ) : preview.error ? (
            <SheetCard borderRadius={radius.note} padding={space.s16}>
              <Text variant="rowPrimary" color={colors.down}>
                Could not read your positions.
              </Text>
              <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s6 }}>
                {errorText(preview.error)}
              </Text>
              <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
                Nothing was sold.
              </Text>
            </SheetCard>
          ) : nothingToDo ? (
            <SheetCard borderRadius={radius.note} padding={space.s16}>
              <Text variant="rowPrimary">Nothing to sell.</Text>
              {p.dustBelowUsd !== undefined ? (
                <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s6 }}>
                  No positions above {money(p.dustBelowUsd)}. It is already cash.
                </Text>
              ) : null}
            </SheetCard>
          ) : p ? (
            <>
              <SheetCard borderRadius={radius.note} padding={space.s16}>
                <Eyebrow small>Would sell</Eyebrow>
                {p.legs.map((l) => (
                  <View
                    key={l.symbol}
                    style={[
                      {
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        paddingVertical: space.s10,
                      },
                      divider,
                    ]}
                  >
                    <View>
                      <Text variant="rowPrimary">{l.symbol}</Text>
                      {/*
                        `quantity`, not toFixed. The screen layer formats through one place so
                        grouping and the U+2212 minus are consistent everywhere — and the
                        audit test in src/qa enforces it, which is how this got caught.
                      */}
                      <Text variant="footnote" color={colors.ink55} figure="units">
                        {quantity(l.units, 6)} {l.symbol}
                      </Text>
                    </View>
                    <Price>{money(l.usd)}</Price>
                  </View>
                ))}
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    paddingTop: space.s12,
                  }}
                >
                  <Text variant="rowPrimary" color={colors.ink55}>
                    Roughly
                  </Text>
                  <Price>{money(p.totalUsd)}</Price>
                </View>
              </SheetCard>

              {/*
                The two things people are surprised by afterwards, said before.
                Slippage, because a panic exit accepts more of it than a scheduled buy — on
                purpose, since not executing is the worse outcome. And dust, because a
                leftover $0.40 of something looks like the flatten failed.
              */}
              <View style={{ marginTop: space.s14, gap: space.s8 }}>
                {p.slippagePct !== undefined ? (
                  <Text variant="secondarySm" color={colors.ink55}>
                    Market orders, up to {p.slippagePct}% slippage, so the exit fills.
                  </Text>
                ) : null}
                {p.skipped && p.skipped.length > 0 && p.dustBelowUsd !== undefined ? (
                  <Text variant="secondarySm" color={colors.ink55}>
                    Leaving {p.skipped.join(', ')}: under {money(p.dustBelowUsd)}, not worth the gas.
                  </Text>
                ) : null}
              </View>
            </>
          ) : null}

          {error ? (
            <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s14 }}>
              {error}
            </Text>
          ) : null}
        </ScrollView>
      </Fill>

      {result ? (
        <Button label="Done" height={size.buttonLg} onPress={() => goBack()} />
      ) : (
        <>
          {/* Said before the button that it switches off, not after four sales that each revert. */}
          {blocked && !nothingToDo ? (
            <Text variant="secondarySm" color={colors.warn} style={{ marginBottom: space.s10 }}>
              {blocked}
            </Text>
          ) : null}
          <Button
            label={p && p.legs.length > 0 ? `Sell ${money(p.totalUsd)} into USDC` : 'Sell everything'}
            figure="own"
            variant="destructive"
            height={size.buttonLg}
            // Not on a failed preview: a sale nobody could show you first is the dare this screen exists to refuse.
            disabled={nothingToDo || preview.loading || Boolean(preview.error) || Boolean(blocked)}
            loading={busy}
            onPress={flatten}
          />
        </>
      )}
      <Text
        variant="footnote"
        color={colors.ink55}
        align="center"
        style={{ marginTop: space.s12 }}
      >
        Lands in your wallet. Doesn’t use your daily cap.
      </Text>
    </Screen>
  );
}

function Outcome({ result }: { result: Result }) {
  const failed = result.legs.filter((l) => l.status === 'failed');
  return (
    <>
      <SheetCard borderRadius={radius.note} padding={space.s16}>
        <Text variant="rowPrimaryLg" color={failed.length ? colors.warn : colors.up}>
          {failed.length
            ? `${result.sold} sold, ${failed.length} could not be`
            : result.sold === 0
              ? 'There was nothing to sell'
              : `${result.sold} position${result.sold === 1 ? '' : 's'} closed`}
        </Text>
        {failed.length ? (
          <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s6 }}>
            You still hold the ones below, unchanged.
          </Text>
        ) : null}
      </SheetCard>

      {result.legs.map((l) => (
        <View
          key={l.symbol}
          style={{
            marginTop: space.s10,
            padding: space.s14,
            borderRadius: radius.tile,
            backgroundColor: colors.surface,
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text variant="rowPrimary">{l.symbol}</Text>
            <Tag
              label={l.status}
              small
              tone={l.status === 'sold' ? 'up' : l.status === 'failed' ? 'down' : 'neutral'}
            />
          </View>
          {/*
            A sale's detail is what it sold and for how much — "0.500000 WETH for $1,200.00." — so it hides while balances
            are hidden. Any other detail is the executor's reason, drawn as it came.
          */}
          <Text
            variant="secondarySm"
            color={colors.ink55}
            style={{ marginTop: space.s4 }}
            figure={l.status === 'sold' ? 'units' : undefined}
          >
            {l.detail}
          </Text>
          {l.explorer ? (
            <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s6 }} selectable>
              {l.explorer}
            </Text>
          ) : null}
        </View>
      ))}
    </>
  );
}
