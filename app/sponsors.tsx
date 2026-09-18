/**
 * What each piece of technology actually does here, with the evidence.
 *
 * Every hackathon project claims its integrations. The claim is worth nothing without a number behind it, so this screen
 * makes none it cannot show. The venue rows count fills from `/metrics` `fillsByVenue`, which is the venue each filled run
 * recorded when it settled (`server/src/executor/settle.ts` writes `uniswap-v3`, `okx-dex` or `aave`); the xStocks row
 * counts the catalog the executor serves; the Privy row reports what Privy is enforcing right now.
 *
 * Only what the code uses (2026-09-19): X Layer is the chain, Uniswap v3 settles every trade, OKX DEX competes for a
 * trade only on a deployment holding an OKX API key (`okxConfigured()`), Aave v3 is where idle cash is supplied, the
 * xStocks are Backed's tokenized shares, and Privy holds the keys. No logos: the names are the claim.
 *
 * It is deliberately capable of saying an integration is NOT live here. Zero OKX fills is the honest state of a
 * deployment without the key, and a screen that painted it green anyway would be exactly the overclaim this product
 * argues against.
 *
 * Each track stands on its own read. One `/metrics` failure used to replace the whole screen with an error; now the
 * track whose read failed says so in place, and the others show what they read. A read that failed is "Unknown", never
 * "Not here".
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  ErrorState,
  Fill,
  HeaderBar,
  Placeholder,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  space,
} from '@/ui';
import { shortAddress } from '@/format';
import { chainLabel } from '@/chain';
import { useAsync } from '@/data/useAsync';
import { repos } from '@/data';
import { system } from '@/data/system';
import { NotSignedIn } from '@/data/apiError';

const DOT = 8;

/** Live, degraded, not wired here, or not known because its read failed — four states, because all four occur. */
type Level = 'live' | 'partial' | 'off' | 'unknown';

const LEVEL_LABEL: Record<Level, string> = {
  live: 'Live',
  partial: 'Partly',
  off: 'Not here',
  unknown: 'Unknown',
};

function toneFor(level: Level): string {
  if (level === 'live') return colors.up;
  if (level === 'partial') return colors.warn;
  return colors.ink40;
}

/** "one fill", "3 fills". */
function fills(n: number, noun = 'fill'): string {
  return n === 1 ? `one ${noun}` : `${n} ${noun}s`;
}

export default function Sponsors() {
  const goBack = useGoBack();
  const router = useRouter();

  const metrics = useAsync(() => system.metrics(), []);
  const catalog = useAsync(() => system.xstocks(), []);
  const policy = useAsync(() => repos.wallet.privyPolicy(), []);
  const wallet = useAsync(() => repos.wallet.current(), []);

  const byVenue = metrics.data?.fillsByVenue ?? {};
  const uniswapFills = byVenue['uniswap-v3'] ?? 0;
  const okxFills = byVenue['okx-dex'] ?? 0;
  const aaveFills = byVenue['aave'] ?? 0;
  const metricsLoading = metrics.loading && !metrics.data;
  const tradeFills = uniswapFills + okxFills;

  const xstockRows = catalog.data?.rows ?? [];
  const priced = xstockRows.filter((r) => r.feed === 'live').length;

  /* Signed out is an answer about this session — there is no wallet on it — not a read that failed. */
  const signedOut = wallet.error instanceof NotSignedIn;
  const walletError = signedOut ? undefined : wallet.error;
  const policyFailed = policy.error !== undefined && !(policy.error instanceof NotSignedIn);

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">How it works</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          What each one does here, and the evidence it is doing it.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s16 }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: space.gutter,
            paddingBottom: space.s30,
            gap: space.s12,
          }}
        >
          {/* ── X Layer ───────────────────────────────────────────────────────── */}
          <Track
            name="X Layer"
            does="OKX's EVM chain, and where the money moves. The permission you sign, every trade and every withdrawal settle on it; gas is paid in OKB, by the bot for its own trades."
            level={metrics.error ? 'unknown' : tradeFills + aaveFills > 0 ? 'live' : 'partial'}
            loading={metricsLoading}
            error={metrics.error}
            onRetry={metrics.reload}
            evidence={
              tradeFills + aaveFills > 0
                ? `${fills(tradeFills + aaveFills)} settled on ${chainLabel}, counted from the runs that filled.`
                : `Nothing has settled on ${chainLabel} for this deployment yet.`
            }
            onOpen={() => router.push('/network')}
            openLabel="The network"
          />

          {/* ── Uniswap v3 ────────────────────────────────────────────────────── */}
          <Track
            name="Uniswap v3"
            does="Every trade has a Uniswap v3 route. The executor quotes the pools, builds the swap, and the delegation contract enforces the quote's floor — the price is the pool's, not a feed's."
            level={metrics.error ? 'unknown' : uniswapFills > 0 ? 'live' : 'partial'}
            loading={metricsLoading}
            error={metrics.error}
            onRetry={metrics.reload}
            evidence={
              uniswapFills > 0
                ? `${fills(uniswapFills)} settled through Uniswap v3.`
                : 'No fills through Uniswap v3 on this deployment yet.'
            }
            onOpen={() => router.push('/venues')}
            openLabel="Where fills may go"
          />

          {/* ── OKX DEX ───────────────────────────────────────────────────────── */}
          <Track
            name="OKX DEX API"
            does="A second route. Where this deployment holds an OKX API key, the aggregator is asked too, and its route is taken only when it delivers more than Uniswap's."
            level={metrics.error ? 'unknown' : okxFills > 0 ? 'live' : 'off'}
            loading={metricsLoading}
            error={metrics.error}
            onRetry={metrics.reload}
            evidence={
              okxFills > 0
                ? `${fills(okxFills)} settled through OKX DEX, where its route beat Uniswap's.`
                : 'No fills through OKX DEX on this deployment.'
            }
            extra={okxFills > 0 ? undefined : 'Either no key is set here, or Uniswap has delivered more every time.'}
            onOpen={() => router.push('/venues')}
            openLabel="Where fills may go"
          />

          {/* ── Aave v3 ───────────────────────────────────────────────────────── */}
          <Track
            name="Aave v3"
            does="Where idle cash earns. A supply goes through the same permission and daily cap as a trade, and the receipt token is paid to you, never to us."
            level={metrics.error ? 'unknown' : aaveFills > 0 ? 'live' : 'partial'}
            loading={metricsLoading}
            error={metrics.error}
            onRetry={metrics.reload}
            evidence={
              aaveFills > 0 ? `${fills(aaveFills, 'supply')} to Aave v3.` : 'Nothing supplied to Aave v3 on this deployment yet.'
            }
            onOpen={() => router.push('/yield')}
            openLabel="What idle cash earns"
          />

          {/* ── xStocks ───────────────────────────────────────────────────────── */}
          <Track
            name="xStocks by Backed"
            does="The shares themselves: tokenized equities issued by Backed, each tracking a listed share. What the app buys and sells is the token, and a holding is a balance in your wallet."
            level={catalog.error ? 'unknown' : priced > 0 ? 'live' : xstockRows.length > 0 ? 'partial' : 'off'}
            loading={catalog.loading && !catalog.data}
            error={catalog.error}
            onRetry={catalog.reload}
            evidence={
              xstockRows.length > 0
                ? `${xstockRows.length} xStocks listed, ${priced} priced right now.`
                : 'No xStocks listed on this deployment.'
            }
            onOpen={() => router.push('/xstocks')}
            openLabel="Every xStock"
          />

          {/* ── Privy ─────────────────────────────────────────────────────────── */}
          <Track
            name="Privy"
            does="Sign-in, keys and signing. You own the wallet; the executor never holds a key that can move funds, and a policy on Privy's side refuses a destination we did not name."
            level={
              walletError
                ? 'unknown'
                : !wallet.data
                  ? 'off'
                  : policy.data?.enforced
                    ? 'live'
                    : policyFailed
                      ? 'unknown'
                      : 'partial'
            }
            loading={wallet.loading && !wallet.data}
            error={walletError}
            onRetry={wallet.reload}
            evidence={
              wallet.data
                ? /* Its kind, as the executor records it: Privy creates some wallets, and people bring others. */
                  `Signed in, ${wallet.data.kind === 'embedded' ? 'embedded' : 'connected'} wallet ${shortAddress(wallet.data.address)}.`
                : signedOut
                  ? 'Not signed in.'
                  : 'No wallet on this session.'
            }
            extra={
              !wallet.data
                ? undefined
                : policyFailed
                  ? 'The wallet policy could not be read.'
                  : !policy.data
                    ? undefined
                    : policy.data.enforced
                      ? `Policy enforcing, owned by key quorum ${policy.data.ownedByQuorum ?? '—'} — which the executor is not a member of, so it cannot widen it.`
                      : `The policy exists and names ${policy.data.wouldAllow.length} destinations, but attaching it is authorised by the wallet's owner, which is you rather than us.`
            }
            onOpen={() => router.push('/policy')}
            openLabel="What Privy refuses"
          />

          <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
            <Text variant="secondarySm" color={colors.ink55}>
              Every figure here is read live.
            </Text>
          </SheetCard>

          <Button label="Check every claim" variant="ghost" onPress={() => router.push('/verify')} />
        </ScrollView>
      </Fill>
    </Screen>
  );
}

function Track({
  name,
  does,
  level,
  loading = false,
  error,
  onRetry,
  evidence,
  extra,
  onOpen,
  openLabel,
}: {
  name: string;
  does: string;
  level: Level;
  /** The track's own read has not answered yet. */
  loading?: boolean;
  /** The track's own read failed. Shown in place of its evidence, and nowhere else. */
  error?: Error;
  onRetry?: () => void;
  evidence: string;
  extra?: string;
  onOpen: () => void;
  openLabel: string;
}) {
  const tone = loading ? colors.ink40 : toneFor(level);
  return (
    <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10 }}>
        <View
          style={{
            width: DOT,
            height: DOT,
            borderRadius: DOT / 2,
            backgroundColor: tone,
          }}
        />
        <Text variant="rowPrimaryLg" style={{ flex: 1 }}>
          {name}
        </Text>
        <Text variant="control" color={tone}>
          {loading ? '· · ·' : LEVEL_LABEL[level]}
        </Text>
      </View>

      <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s12 }}>
        {does}
      </Text>

      {/* The number, set apart from the prose — this is the half that is checkable. */}
      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : loading ? (
        <Placeholder height={20} style={{ marginTop: space.s14 }} />
      ) : (
        <>
          <Text variant="rowPrimary" style={{ marginTop: space.s14 }}>
            {evidence}
          </Text>
          {extra ? (
            <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
              {extra}
            </Text>
          ) : null}
        </>
      )}

      <Button
        label={openLabel}
        variant="ghost"
        style={{ marginTop: space.s14 }}
        onPress={onOpen}
      />
    </SheetCard>
  );
}
