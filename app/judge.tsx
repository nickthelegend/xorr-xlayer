/**
 * The verification console.
 *
 * Every claim this project makes about itself, re-checked live, with the observed value and
 * the call that produced it. It exists because the product's whole argument is "you do not
 * have to trust us" — and a README that asserts a contract address is asking for exactly the
 * trust the contract was built to remove.
 *
 * Three rules it holds itself to:
 *
 *   - It shows what was OBSERVED, never just a green tick. A pass with nothing behind it is
 *     the same unfalsifiable claim in a nicer colour.
 *   - It shows failures. A console that only renders when everything is fine is marketing.
 *   - It shows the call, so the reader can repeat it somewhere this code cannot reach.
 *
 * Reachable without an account, like the endpoint behind it. Paste any address to run the
 * wallet-specific checks against it; they read public on-chain facts about an address anyone
 * could already look up on an explorer.
 *
 * Or open a link that names one: `/judge?owner=0x…` runs straight for that wallet, and Share hands
 * the same link on (FEATURES.md #22).
 */
import React, { useCallback, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  Button,
  Eyebrow,
  Fill,
  Press,
  Price,
  Screen,
  SheetCard,
  Tag,
  Text,
  colors,
  divider,
  radius,
  size,
  space,
  typeScale,
} from '@/ui';
import { clock } from '@/format';
import { api } from '@/data/api';
import { ApiError, TimedOut, errorRef, errorText, isRetryable } from '@/data/apiError';
import { useAsync } from '@/data/useAsync';
import { useHasHydrated, useStore } from '@/state/store';
import { linkedOwner } from '@/export/proofLink';
import { linkTo, useShareLink } from '@/export/shareLink';

type Check = {
  id: string;
  claim: string;
  status: 'pass' | 'fail' | 'skip';
  observed: string;
  how: string;
  ms: number;
};

type Report = {
  checks: Check[];
  passed: number;
  failed: number;
  skipped: number;
  chain: string;
  at: string;
};

/** PASS / FAIL / SKIP. `skip` is deliberately neutral — skipped is not passed. */
const TONE = {
  pass: { tone: 'up', label: 'Pass' },
  fail: { tone: 'down', label: 'Fail' },
  skip: { tone: 'neutral', label: 'Skip' },
} as const;

const FIELD_H = 46;

/**
 * Which failure it was, in words.
 *
 * Every error read "The executor did not answer." with the raw message under it — a 400 refusing the
 * owner field, a 502 and a dropped connection alike, status line and JSON body included. They are
 * three different events and each changes what a reader does next: fix the address, wait, or check
 * the connection.
 */
function failureTitle(e: Error): string {
  if (e instanceof TimedOut) return 'The checks did not finish in time.';
  if (e instanceof ApiError) {
    return e.status >= 500 ? 'The executor could not run the checks.' : 'The executor refused this.';
  }
  return 'Couldn’t reach the executor.';
}

/**
 * The executor's own sentence where it wrote one. A timeout's message is written for trades ("check
 * Activity before trying again"), which is the wrong advice for a read that changes nothing.
 */
function failureDetail(e: Error): string | undefined {
  if (e instanceof ApiError) return errorText(e);
  if (e instanceof TimedOut) return 'Running them changes nothing, so running them again is safe.';
  return undefined;
}

export default function Judge() {
  const goBack = useGoBack();
  /*
   * The signed-in wallet, once the store has loaded it. This was `useState(wallet?.address ?? '')`, read on the first
   * render, before the store had hydrated: the field started empty and the first run checked no wallet for a person who
   * has one. Both values now follow the stored address until the reader types or runs something else, and the first
   * run waits for the store, as Verify's does.
   *
   * A link's owner comes before the stored one (FEATURES.md #22). `/judge?owner=0x…` is someone saying "check this
   * wallet", so it seeds the field and the first run, and that run does not wait for a store it does not read. An owner
   * the executor would refuse is dropped without a word, and the screen opens as if the link had named no one.
   */
  const params = useLocalSearchParams<{ owner?: string }>();
  const linked = linkedOwner(params.owner);
  const hydrated = useHasHydrated();
  const stored = useStore((s) => s.wallet?.address) ?? '';
  const [typed, setTyped] = useState<string>();
  const owner = typed ?? linked ?? stored;
  // The address the last run used, so editing the field does not silently relabel the results
  // above it as being about an address they were never run against.
  const [asked, setAsked] = useState<string>();
  const ranFor = asked ?? linked ?? stored;
  const [nonce, setNonce] = useState(0);
  const ready = hydrated || linked !== undefined;

  const report = useAsync(
    // No auth needed — the route is public on purpose, so this works signed out.
    () =>
      ready
        ? api.get<Report>(`/verify${ranFor ? `?owner=${encodeURIComponent(ranFor)}` : ''}`)
        : new Promise<Report>(() => undefined),
    [ranFor, nonce, ready],
  );

  const rerun = useCallback(() => {
    setAsked(owner.trim());
    setNonce((n) => n + 1);
  }, [owner]);

  /*
   * The link is to the wallet the rows below were run for, not to whatever is in the field: an address typed and not yet
   * run is not what the person opening the link would see. No link, no control — `linkOrigin` says when a build has none.
   */
  const link = linkTo('/judge', ranFor);
  const shared = useShareLink(link);

  const d = report.data;

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10, flex: 1 }}>
          <BackButton onPress={() => goBack()} />
          <Text variant="screenTitle" numberOfLines={1}>
            Check it yourself
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s16 }}>
          {link ? (
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
          ) : null}
          <Press
            onPress={rerun}
            disabled={report.loading}
            accessibilityRole="button"
            accessibilityLabel="Run the checks again"
            hitHeight={size.hit}
          >
            <Text variant="control" color={report.loading ? colors.ink32 : colors.ink}>
              {report.loading ? 'Running…' : 'Re-run'}
            </Text>
          </Press>
        </View>
      </View>

      <Text variant="body" color={colors.ink55} style={{ marginTop: space.s10 }}>
        Every claim this app makes about itself, checked against the chain and the
        feeds right now — not when this was written.
      </Text>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.s8,
          marginTop: space.s16,
          backgroundColor: colors.control,
          borderRadius: radius.tile,
          paddingHorizontal: space.s14,
          height: FIELD_H,
        }}
      >
        <Eyebrow small>Owner</Eyebrow>
        <TextInput
          value={owner}
          onChangeText={setTyped}
          onSubmitEditing={rerun}
          placeholder="0x… (optional)"
          placeholderTextColor={colors.ink30}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Wallet address to check"
          style={[typeScale.body, { color: colors.ink, flex: 1 }]}
        />
      </View>

      <Fill style={{ marginTop: space.s14 }}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {/*
            Loading, failed-to-reach, and a report full of failures are three different
            states. The middle one is the easiest to get wrong: a console that renders
            nothing when the server is down looks identical to one where everything passed.
          */}
          {report.loading && !d ? (
            <Text variant="body" color={colors.ink55}>
              Running the checks…
            </Text>
          ) : report.error ? (
            <SheetCard borderRadius={radius.note} padding={space.s16}>
              <Text variant="rowPrimary" color={colors.down}>
                {failureTitle(report.error)}
              </Text>
              {failureDetail(report.error) ? (
                <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s6 }}>
                  {failureDetail(report.error)}
                </Text>
              ) : null}
              {/* The request's reference under a server fault or a timeout, as the error state shows it: what a report quotes. */}
              {errorRef(report.error) ? (
                <Text variant="footnote" color={colors.ink55} selectable style={{ marginTop: space.s6 }}>
                  {`Ref ${errorRef(report.error)}`}
                </Text>
              ) : null}
              <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
                This is the console failing, not the claims.
              </Text>
              {/* Only where asking again could get a different answer: a refusal will refuse again. */}
              {isRetryable(report.error) ? (
                <Button
                  label="Run them again"
                  variant="ghost"
                  onPress={rerun}
                  style={{ marginTop: space.s12 }}
                />
              ) : null}
            </SheetCard>
          ) : d ? (
            <>
              <Tally d={d} />
              {d.checks.map((c) => (
                <CheckRow key={c.id} check={c} />
              ))}
              <Text
                variant="footnote"
                color={colors.ink55}
                style={{ marginTop: space.s16, marginBottom: space.s8 }}
              >
                Run at {clock(new Date(d.at).getTime())} against {d.chain}. Every row above
                is a live read; nothing here is cached from a previous run or written into the
                app.
              </Text>
            </>
          ) : null}
        </ScrollView>
      </Fill>
    </Screen>
  );
}

function Tally({ d }: { d: Report }) {
  /* A skip that happened for want of a wallet identifies itself; see the note below. */
  const walletGatedSkips = d.checks.filter(
    (c) => c.status === 'skip' && c.observed.startsWith('No wallet on this request'),
  ).length;
  const allGood = d.failed === 0;
  return (
    <SheetCard
      borderRadius={radius.note}
      padding={space.s16}
      style={{ marginBottom: space.s12 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.s8 }}>
        <Price variant="screenTitle" tone={allGood ? 'up' : 'down'}>
          {d.passed}/{d.checks.length}
        </Price>
        <Text variant="body" color={colors.ink55}>
          {allGood ? 'claims verified' : `verified · ${d.failed} failing`}
        </Text>
      </View>
      {d.skipped > 0 ? (
        <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s6 }}>
          {/*
            Do not invent a reason for the skip.
            
            This said "those need a wallet address, and none was given" for every skip, whatever
            caused it. Signed in with a real wallet, the summary read "19/20 · 1 skipped — those
            need a wallet address, and none was given" while the only skipped row was the tokenized
            equities check, which skips because the tokens do not exist on the testnet and says so at
            length on its own line. Nineteen of the checks had used the wallet to get their answer.
            
            A screen whose entire purpose is that its claims can be trusted cannot afford a
            confidently wrong sentence in its own header. Wallet-gated skips are detectable — those
            checks report "No wallet on this request." — so say that when it is true, and otherwise
            point at the rows, which each carry their own reason.
          */}
          {walletGatedSkips === d.skipped
            ? `${d.skipped} skipped — those need a wallet address, and none was given. Skipped is not passed.`
            : `${d.skipped} skipped — each says why on its own row. Skipped is not passed.`}
        </Text>
      ) : null}
    </SheetCard>
  );
}

function CheckRow({ check }: { check: Check }) {
  const [open, setOpen] = useState(false);
  const tone = TONE[check.status];
  return (
    <Press
      onPress={() => setOpen((v) => !v)}
      accessibilityRole="button"
      accessibilityLabel={`${check.claim} — ${tone.label}. ${open ? 'Hide' : 'Show'} how this was checked.`}
      accessibilityState={{ expanded: open }}
      style={[{ paddingVertical: space.s12 }, divider]}
    >
      <View style={{ flexDirection: 'row', gap: space.s10 }}>
        <Tag label={tone.label} small tone={tone.tone} radius={radius.glyph} />
        <View style={{ flex: 1 }}>
          <Text variant="rowPrimary">{check.claim}</Text>
          {/* The observed value is the point. It gets the same weight as the claim, not less. */}
          <Text
            variant="secondarySm"
            color={check.status === 'fail' ? colors.down : colors.ink55}
            style={{ marginTop: space.s4 }}
          >
            {check.observed}
          </Text>
          {open ? (
            <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s8 }}>
              {check.how} · {check.ms}ms
            </Text>
          ) : null}
        </View>
      </View>
    </Press>
  );
}
