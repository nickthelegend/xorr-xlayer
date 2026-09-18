/**
 * Every claim this product makes, checked against the running system, on demand.
 *
 * The executor has had `/verify` since early on: twenty checks that each name a claim, the exact
 * call they make to test it, and what came back. It was reachable with curl and from nowhere in the
 * app — which is a strange place to leave the one endpoint that answers "is any of this real".
 *
 * The screen shows `how` and `observed` for every row, not just a tick. A green tick is a claim
 * about a claim; "eth_getCode 0xabe6… → 3926 bytes" is something a reader can go and check
 * themselves, which is the only kind of verification worth putting on screen.
 *
 * `skip` is rendered as its own state, deliberately. Most checks need a wallet on the request, so
 * an anonymous report skips a third of them — painting those red would put a wall of failure in
 * front of someone whose setup is fine.
 *
 * And the wallet IS passed when there is one, which this screen did not do.
 *
 * It called `verifyReport()` with no argument while signed in, so six checks it could have run
 * stayed "Not asked" and the header read **14 Passed · 0 Failed · 6 Not asked**. The same endpoint
 * asked about that wallet answers 18 / 1 / 1 — the audit chain forks at entry 2 for it, which is a
 * real, permanent failure the screen was reporting as zero.
 *
 * Reassurance that comes from not having asked is the one thing a verification console must never
 * produce. `/judge` had this right from the start.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  EmptyState,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  Press,
  Screen,
  SheetCard,
  Text,
  colors,
  radius,
  size,
  space,
} from '@/ui';
import { when } from '@/format';
import { useAuth } from '@/auth/useAuth';
import { useAsync } from '@/data/useAsync';
import { useHasHydrated, useStore } from '@/state/store';
import { system, type VerifyCheck, type VerifyReport } from '@/data/system';
import { linkedOwner } from '@/export/proofLink';
import { linkTo, useShareLink } from '@/export/shareLink';

const DOT = 8;

/** Green passes, red fails, and grey is "not asked" — three states, because there are three. */
function toneFor(status: VerifyCheck['status']): string {
  if (status === 'pass') return colors.up;
  if (status === 'fail') return colors.down;
  return colors.ink30;
}

export default function Verify() {
  const goBack = useGoBack();
  /*
   * `owner` is undefined for a signed-out reader, which keeps the anonymous behaviour the note
   * above describes — the wallet checks skip rather than fail. Signed in, it is the wallet on file,
   * or Privy's own address in a session that never ran onboarding.
   *
   * A link's owner comes before both (FEATURES.md #22): `/verify?owner=0x…` asks about that wallet,
   * whoever is reading. An owner the executor would refuse is dropped without a word.
   */
  const params = useLocalSearchParams<{ owner?: string }>();
  const linked = linkedOwner(params.owner);
  const auth = useAuth();
  const storedOwner = useStore((s) => s.wallet?.address);
  const owner = linked ?? storedOwner ?? (auth.authenticated ? auth.address : undefined);
  /*
   * Asked once the store has loaded, not before.
   *
   * Before hydration the wallet reads as absent, so the screen ran an anonymous report and then a
   * second one for the wallet a moment later — and kept the first on screen while the second ran:
   * seconds of rows about nobody, with nothing saying the real answer was still coming. Until the
   * store has loaded there is no question to ask yet, so the request waits rather than guessing.
   *
   * A link's owner is not in the store, so a linked report has nothing to wait for.
   */
  const hydrated = useHasHydrated();
  const ready = hydrated || linked !== undefined;
  const { data, loading, error, reload } = useAsync(
    () => (ready ? system.verifyReport(owner) : new Promise<VerifyReport>(() => undefined)),
    [owner, ready],
  );
  const link = linkTo('/verify', owner);
  const shared = useShareLink(link);

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar
          onBack={goBack}
          title={<Text variant="screenTitle">Verification</Text>}
          right={
            link ? (
              <Press
                onPress={shared.share}
                accessibilityRole="button"
                accessibilityLabel="Share a link to these checks"
                hitHeight={size.hit}
              >
                <Text variant="control" color={colors.ink}>
                  {shared.label}
                </Text>
              </Press>
            ) : null
          }
        />
        {/* A linked report names its wallet. A reader who is signed in would otherwise take it for their own. */}
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          {linked
            ? `For ${linked.slice(0, 6)}…${linked.slice(-4)}.`
            : 'Each claim, how it was tested, and what came back.'}
        </Text>
      </View>

      <Fill style={{ marginTop: space.s16 }}>
        {/*
          Loading whenever a report is running, not only before the first one. `useAsync` keeps the
          previous answer while a new one is fetched, and a report for a different owner is not this
          one — it is not shown while the right one runs.
        */}
        {loading ? (
          <View style={{ paddingHorizontal: space.gutter, gap: space.s12 }}>
            <Text variant="secondarySm" color={colors.ink55}>
              Running every check…
            </Text>
            <LoadingRows count={7} height={size.rowLg} />
          </View>
        ) : error ? (
          <View style={{ paddingHorizontal: space.gutter }}>
            <ErrorState error={error} onRetry={reload} />
          </View>
        ) : !data || data.checks.length === 0 ? (
          <EmptyState text="The report came back with nothing in it." />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: space.gutter,
              paddingBottom: space.s30,
              gap: space.s10,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                gap: space.s16,
                paddingBottom: space.s12,
              }}
            >
              <Tally label="Passed" value={data.passed} tone={colors.up} />
              <Tally label="Failed" value={data.failed} tone={data.failed > 0 ? colors.down : colors.ink40} />
              <Tally label="Not asked" value={data.skipped} tone={colors.ink40} />
            </View>

            <Text variant="footnote" color={colors.ink55}>
              {data.chain} · {when(new Date(data.at).getTime())}
            </Text>

            {data.checks.map((c) => (
              <SheetCard key={c.id} bordered borderRadius={radius.panel} padding={space.s14}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.s10 }}>
                  <View
                    style={{
                      width: DOT,
                      height: DOT,
                      borderRadius: DOT / 2,
                      backgroundColor: toneFor(c.status),
                      marginTop: space.s6,
                    }}
                  />
                  <View style={{ flex: 1, gap: space.s6 }}>
                    <Text variant="rowPrimary">{c.claim}</Text>
                    {/*
                      The call, then the result. Monospace-ish framing matters less than the fact
                      that both are here: a claim with only a verdict is an assertion, and a claim
                      with the method and the observation is a receipt.
                    */}
                    <Text variant="footnote" color={colors.ink55}>
                      {c.how}
                    </Text>
                    <Text
                      variant="secondarySm"
                      color={c.status === 'skip' ? colors.ink35 : colors.ink65}
                    >
                      {c.observed}
                    </Text>
                  </View>
                </View>
              </SheetCard>
            ))}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}

function Tally({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <View style={{ gap: space.s2 }}>
      <Text variant="screenTitle" color={tone}>
        {String(value)}
      </Text>
      <Text variant="footnote" color={colors.ink55}>
        {label}
      </Text>
    </View>
  );
}
