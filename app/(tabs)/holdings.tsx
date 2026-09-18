/**
 * Assets tab — NEW. PLAN.md 10.2 / §3.5.
 *
 * The handoff's "Assets" tab was never designed [G13]. Built from parts that already exist:
 * the stacked proportion bar from screen 10, holdings rows, the realised card, and the
 * wallet. No new visual language — and no design values of its own; everything is `src/ui`.
 */
import React, { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { assetGradient } from '@/design/gradients';
import {
  AssetMark,
  EmptyList,
  Eyebrow,
  FigureSpan,
  LoadingRows,
  Price,
  Row,
  Screen,
  SheetCard,
  Text,
  colors,
  money,
  percent,
  pnlTone,
  quantity,
  radius,
  size,
  space,
  ErrorState,
  NoteStrip,
  SignInPrompt,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { signedMoney } from '@/format';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { useFreshOnReturn } from '@/data/useFreshOnReturn';
import { logoProps, useLogos } from '@/data/useLogos';
import { walletTokens } from '@/data/walletTokens';
import { useRefreshControl } from '@/ui/useRefreshControl';
import { useStore } from '@/state/store';
import { driftSentence, holdingDrift, weightBarPct } from '@/state/derived';

const BAR_H = 8;

/*
 * A balance too small for four places, or a value under a cent, is still held (PLAN.md 3.10). `quantity` prints dust as
 * "0.0000" and `money` as "$0.00", both of which read as holding nothing, so these say how small instead.
 */
const SMALLEST_UNITS = 0.0001;
const CENT = 0.01;

function tokenUnits(units: number): string {
  return units > 0 && units < SMALLEST_UNITS ? `< ${quantity(SMALLEST_UNITS)}` : quantity(units, units >= 1 ? 2 : 4);
}

function tokenUsd(usd: number): string {
  return usd > 0 && usd < CENT ? `< ${money(CENT)}` : money(usd);
}

/** Said rather than left out, because a list that silently omits a held token reads as the whole wallet. */
function undescribedNote(count: number): string {
  return `${count} more ${count === 1 ? 'token' : 'tokens'} held, not listed.`;
}

/** Below a cent, a position is left over from a sale rather than held. */
const DUST_USD = 0.01;

export default function Assets() {
  const router = useRouter();
  const wallet = useStore((s) => s.wallet);
  const balance = useAsync(() => repos.portfolio.balanceUsd(), []);
  const sleeves = useAsync(() => repos.portfolio.sleeves(), []);
  // The chain's word on this wallet (PLAN.md 3.10).
  const tokens = useAsync(() => walletTokens(), []);
  const positions = useAsync(() => repos.portfolio.positions(), []);
  const realised = useAsync(() => repos.portfolio.realised(), []);
  /*
   * Read again when the tab is come back to (FEATURES.md #27): every read here that can change, which is all but the
   * target mix — product config with no request behind it.
   */
  useFreshOnReturn(balance, tokens, positions, realised);
  /*
   * Every read on the screen, because a trade changes all of them at once. Holdings and Realised were left out, so a
   * pull after a sale refreshed the balance and went on listing the position it had just sold.
   */
  const refresh = useRefreshControl(() =>
    Promise.all([balance.reload(), sleeves.reload(), tokens.reload(), positions.reload(), realised.reload()]),
  );

  /*
   * The mix the user APPROVED, not the fixture defaults.
   *
   * `sleeves()` returns product config — the three sleeve names, colours and starting weights —
   * and the proposal screen lets the user move those weights before approving them. This screen
   * read the fixture, so a user who had rebalanced to 70/20/10 was shown 55/30/15.
   */
  const approvedWeights = useStore((st) => st.weights);
  const weights = (sleeves.data ?? []).map((sleeve, i) => approvedWeights[i] ?? sleeve.weight);
  // Real holdings from the position book. This previously listed watchlist FIXTURES, so it
  // showed assets the user did not own at prices that never moved.
  const holdings = useMemo(() => (positions.data ?? []).filter((p) => p.notional >= DUST_USD), [positions.data]);
  const logos = useLogos(useMemo(() => holdings.map((h) => h.symbol), [holdings]));
  const tokenRows = useMemo(() => tokens.data?.tokens ?? [], [tokens.data]);
  /*
   * The marks use the logo the executor sent with each token instead of asking `/market/logos` by symbol, which knows
   * only the registry, and a ticker is a label two tokens can share. Keyed by address for the same reason. Every entry
   * is a settled answer, so no mark is left waiting.
   */
  const tokenLogos = useMemo(
    () => Object.fromEntries(tokenRows.map((t) => [t.address, t.logo])),
    [tokenRows],
  );

  // Signed out, every section below is a question nobody asked: one way in, not a dash, two errors and "No wallet".
  const signedOut = useSignedOut();
  if (signedOut) {
    return (
      <Screen tabBar>
        <Text variant="screenTitle">Assets</Text>
        <SignInPrompt />
      </Screen>
    );
  }

  return (
    <Screen tabBar>
      <Text variant="screenTitle">Assets</Text>

      <ScrollView refreshControl={refresh.control} showsVerticalScrollIndicator={false} style={{ flex: 1, marginTop: space.s20 }}>
        {/* A pull that failed says so, over the rows it could not replace. A success says nothing. */}
        {refresh.notice}
        <Eyebrow small>Portfolio value</Eyebrow>
        {/* `money(balance.data ?? 0)` reported "$0.00" whenever the executor was
            unreachable — a confident number for a question we never got to ask. An em dash
            says the same thing the code actually knows.

            And only that. Loading is "not back yet", which is a different state from an error's
            "could not be read", and collapsing them showed the could-not-read dash for the twenty
            seconds this executor takes to answer. Sixth site with this conflation. The failure is
            said under the dash now that the read reports one: it used to be swallowed into `null`,
            so the line below could never appear. */}
        <Price variant="heroBalance" style={{ marginTop: space.s8 }}>
          {balance.data !== null && balance.data !== undefined
            ? money(balance.data)
            : balance.loading
              ? '· · ·'
              : '—'}
        </Price>
        {/* With a figure above it, the failure is a re-read on return (FEATURES.md #27): that figure is the last one
            read, which is not the same as a balance that never loaded. */}
        {balance.error ? (
          <Text variant="secondary" style={{ marginTop: space.s6 }}>
            {balance.data !== null && balance.data !== undefined
              ? 'Couldn’t refresh your balance.'
              : 'Couldn’t load your balance.'}
          </Text>
        ) : null}

        <SheetCard borderRadius={radius.panel} padding={space.s16} style={{ marginTop: space.s20 }}>
          {/*
            "Allocation" was a claim about what the wallet HOLDS, and these numbers are not that.
            They are the target mix — product config the user adjusts and approves on the proposal
            screen — sitting directly above the real Holdings list. So a wallet holding no
            tokenized equities displayed "Tokenized equities 30%" as though it did. The numbers are
            fine; the word was wrong, and the caption now says which of the two this is.
          */}
          <Eyebrow small>Target mix</Eyebrow>
          {/* The 8pt stacked proportion bar from screen 10, reused verbatim. */}
          <View style={{ flexDirection: 'row', gap: space.s2, height: BAR_H, marginTop: space.s12 }}>
            {(sleeves.data ?? []).map((s, i) => (
              <View
                key={s.name}
                style={{
                  width: `${weightBarPct(weights, i)}%`,
                  backgroundColor: s.color,
                  borderRadius: BAR_H / 2,
                }}
              />
            ))}
          </View>
          <View style={{ marginTop: space.s14, gap: space.s10 }}>
            {(sleeves.data ?? []).map((s, i) => (
              <View
                key={s.name}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10 }}
              >
                <View
                  style={{
                    width: BAR_H,
                    height: BAR_H,
                    borderRadius: BAR_H / 2,
                    backgroundColor: s.color,
                  }}
                />
                <Text variant="body" style={{ flex: 1 }}>
                  {s.name}
                </Text>
                <Price color={colors.ink55}>{weights[i] ?? s.weight}%</Price>
              </View>
            ))}
          </View>
        </SheetCard>

        <Text variant="cardTitle" style={{ marginTop: space.s26, marginBottom: space.s6 }}>
          Holdings
        </Text>
        {positions.loading ? (
          <LoadingRows count={2} height={size.rowLg} />
        ) : positions.error ? (
          /*
           * "Nothing held yet" is a claim about a wallet, and an unanswered read is not one.
           *
           * PORTFOLIO VALUE above already refuses to print a number it does not have, and this
           * said "Nothing held yet" beside it — so a signed-out visitor, or one whose read failed,
           * was told their holdings were empty in the same breath as being told the total was
           * unknown.
           */
          <ErrorState error={positions.error} onRetry={positions.reload} />
        ) : holdings.length === 0 ? (
          <EmptyList list="positions" />
        ) : (
          holdings.map((h) => (
            <Row
              key={h.id}
              left={<AssetMark gradient={assetGradient(h.symbol)} {...logoProps(logos, h.symbol)} size={32} />}
              title={h.symbol}
              /*
                While balances are hidden (FEATURES.md #47) the units hide and the average beside them stays: what was
                paid for one is a price, and says nothing of how much is held.
              */
              secondary={[
                <FigureSpan key="units" figure="units">
                  {quantity(h.units)}
                </FigureSpan>,
                ` · avg ${money(h.entry)}`,
              ]}
              secondaryFigure="market"
              value={<Price>{money(h.notional)}</Price>}
              delta={percent(h.unrealisedPct)}
              deltaTone={pnlTone(h.unrealised)}
              height={size.rowLg}
              onPress={() => router.push(`/asset/${h.symbol}`)}
            />
          ))
        )}
        {/* Where the ledger and the wallet disagree, said beside the numbers it changes (PLAN.md 2.7). */}
        {holdings.map((h) => {
          const drift = holdingDrift(h);
          return drift ? (
            <NoteStrip key={`drift-${h.id}`} kind="risk" style={{ marginTop: space.s10 }}>
              {driftSentence(h.symbol, drift)}
            </NoteStrip>
          ) : null;
        })}

        {/*
          The chain's word, beside the ledger's (PLAN.md 3.10).

          Holdings above are the book the executor keeps from its own fills. A wallet holds more than that — the ETH
          that pays for gas, a deposit, a token sent in — so this lists what is actually at the address: 1inch's
          Balance API on Base, the chain itself on a fork or a testnet. Where the two disagree, this one is the wallet.
        */}
        <Text variant="cardTitle" style={{ marginTop: space.s26, marginBottom: space.s6 }}>
          Tokens
        </Text>
        {tokens.error ? (
          /* A failed read says so. An empty list here would be a claim that the wallet holds nothing. */
          <ErrorState error={tokens.error} onRetry={tokens.reload} />
        ) : tokens.loading && !tokens.data ? (
          <LoadingRows count={2} height={size.rowLg} />
        ) : tokenRows.length === 0 ? (
          <EmptyList list="walletTokens" />
        ) : (
          tokenRows.map((t) => (
            <Row
              key={t.address}
              left={<AssetMark gradient={assetGradient(t.symbol)} {...logoProps(tokenLogos, t.address)} size={32} />}
              title={t.symbol}
              // The units hide while balances are hidden; the token's name beside them is words.
              secondary={[
                <FigureSpan key="units" figure="units">
                  {tokenUnits(t.units)}
                </FigureSpan>,
                t.name ? ` · ${t.name}` : null,
              ]}
              secondaryFigure="market"
              value={<Price>{t.usd === null ? '—' : tokenUsd(t.usd)}</Price>}
              height={size.rowLg}
            />
          ))
        )}
        {tokens.data && tokens.data.undescribed.length > 0 ? (
          <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
            {undescribedNote(tokens.data.undescribed.length)}
          </Text>
        ) : null}

        {/*
          Money actually taken, kept apart from money on paper.
          `Holdings` above shows what the open book is worth today, which is an opinion that
          changes every minute. This is the other number — what selling has actually realised
          — and it used to exist nowhere: a position that closed took its profit out of the
          app with it, because the holdings query correctly filters to units > 0.

          A read that failed says so where the card goes. Leaving the card out read as nothing
          having been sold, a claim about the wallet the screen had not got to make.
        */}
        {realised.error ? (
          <SheetCard borderRadius={radius.panel} padding={space.s16} style={{ marginTop: space.s26 }}>
            <Eyebrow small>Realised</Eyebrow>
            <Text variant="secondary" style={{ marginTop: space.s8 }}>
              Couldn’t load realised profit.
            </Text>
          </SheetCard>
        ) : realised.data && realised.data.bySymbol.length > 0 ? (
          <SheetCard
            borderRadius={radius.panel}
            padding={space.s16}
            style={{ marginTop: space.s26 }}
          >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}
            >
              <Eyebrow small>Realised</Eyebrow>
              <Price tone={pnlTone(realised.data.total)}>{signedMoney(realised.data.total)}</Price>
            </View>
            {realised.data.bySymbol.map((r) => (
              <View
                key={r.symbol}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  marginTop: space.s10,
                }}
              >
                <Text variant="body" color={colors.ink55} figure="units">
                  {r.symbol} · {quantity(r.unitsSold)} sold
                  {/* Said inline: a sale with no recorded cost counts as no gain or loss, so
                      this figure leaves it out, and a figure should say what it leaves out. */}
                  {r.basisIncomplete ? ' · cost incomplete' : ''}
                </Text>
                <Price variant="body" tone={pnlTone(r.realised)}>
                  {signedMoney(r.realised)}
                </Price>
              </View>
            ))}
            <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s12 }}>
              At average cost.
            </Text>
          </SheetCard>
        ) : null}

        <SheetCard
          borderRadius={radius.panel}
          padding={space.s16}
          style={{ marginTop: space.s26, marginBottom: space.s26 }}
        >
          <Eyebrow small>Wallet</Eyebrow>
          <Text variant="body" style={{ marginTop: space.s8 }} numberOfLines={1}>
            {wallet?.address ?? 'No wallet connected'}
          </Text>
          <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s6 }}>
            {wallet ? (wallet.kind === 'embedded' ? 'Created in xorr' : 'Connected') : 'Connect a wallet to start.'}
          </Text>
        </SheetCard>
      </ScrollView>
    </Screen>
  );
}
