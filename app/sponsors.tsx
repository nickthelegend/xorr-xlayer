/**
 * What each sponsor's technology actually does here, with the evidence.
 *
 * Every hackathon project claims its integrations. The claim is worth nothing without a number
 * behind it, so this screen makes none it cannot show: the 1inch row counts fills that settled
 * through 1inch, read from the audit trail; the Graph row reports the index's own `_meta` and
 * whether it describes the contract this deployment actually spends through; the Privy row reports
 * what Privy is enforcing right now.
 *
 * It is deliberately capable of saying an integration is NOT live here. A subgraph indexing a
 * different deployment is the honest state of the fork build, and a screen that painted it green
 * anyway would be exactly the overclaim this whole product argues against — and the first thing a
 * judge would catch.
 *
 * Each track stands on its own read. One `/metrics` failure used to replace the whole screen with
 * an error, taking the index and the wallet down with the fill count; now the track whose read
 * failed says so in place, and the others show what they read. A read that failed is "Unknown",
 * never "Not here".
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

export default function Sponsors() {
  const goBack = useGoBack();
  const router = useRouter();

  const metrics = useAsync(() => system.metrics(), []);
  const graph = useAsync(() => system.graphHealth(), []);
  const policy = useAsync(() => repos.wallet.privyPolicy(), []);
  const wallet = useAsync(() => repos.wallet.current(), []);

  const oneInchFills = metrics.data?.fillsByVenue?.['1inch'] ?? 0;
  const aquaFills = metrics.data?.fillsByVenue?.['aqua'] ?? 0;

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
          {/* ── 1inch ─────────────────────────────────────────────────────────── */}
          <Track
            name="1inch"
            does="Every trade. The executor asks the Aggregation router for a route, fills against it, and the price you get is the route's price — not a feed's."
            level={metrics.error ? 'unknown' : oneInchFills > 0 ? 'live' : 'partial'}
            loading={metrics.loading && !metrics.data}
            error={metrics.error}
            onRetry={metrics.reload}
            evidence={
              oneInchFills > 0
                ? `${oneInchFills} fills settled through 1inch, counted from the audit trail.`
                : 'No fills through 1inch on this deployment yet. Routes still quote live.'
            }
            extra={
              aquaFills > 0
                ? `${aquaFills} more settled against our own Aqua book, which is the alternative it is measured against.`
                : undefined
            }
            onOpen={() => router.push('/route/WETH')}
            openLabel="Inspect a live route"
          />

          {/* ── The Graph ─────────────────────────────────────────────────────── */}
          <Track
            name="The Graph"
            does="What the chain recorded, as opposed to what we intended. The bot sizes a trade against spend the subgraph saw, not against our own database — reading our own records for that would be circular."
            level={
              graph.error
                ? 'unknown'
                : graph.data?.indexesThisDeployment && graph.data.healthy
                  ? 'live'
                  : 'partial'
            }
            loading={graph.loading && !graph.data}
            error={graph.error}
            onRetry={graph.reload}
            evidence={
              graph.data
                ? `Indexed to block ${graph.data.block.toLocaleString('en-US')}${graph.data.healthy ? ', no indexing errors' : ', with indexing errors'}.`
                : ''
            }
            extra={
              !graph.data
                ? undefined
                : /*
                   * `indexedDelegation` is absent on an executor older than the field.
                   *
                   * That is not hypothetical — it is what a rolling deploy looks like, and it is
                   * how this screen first crashed. Saying "this build cannot tell you" is both
                   * true and more useful than a confident answer derived from a missing field.
                   */
                  graph.data.indexedDelegation === undefined
                  ? 'This executor is older than the field that says which contract the index describes, so that cannot be checked from here.'
                  : graph.data.indexesThisDeployment
                    ? `Indexing ${shortAddress(graph.data.indexedDelegation)} — the contract this deployment spends through.`
                    : `Indexing ${shortAddress(graph.data.indexedDelegation)}, but this deployment spends through ${shortAddress(graph.data.activeDelegation)}. The agent will not read permission from an index of a different contract, so on this build the chain itself is the only authority.`
            }
            onOpen={() => router.push('/graph')}
            openLabel="Open the index"
          />

          {/* ── Privy ─────────────────────────────────────────────────────────── */}
          <Track
            name="Privy"
            does="Keys and signing. You own the wallet; the executor never holds a key that can move funds, and a policy on Privy's side refuses a destination we did not name."
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
