/**
 * What Base has been told about this trail — the claim, and the block that holds it.
 *
 * `/audit/chain` answers "has this log been edited?" by re-hashing our own rows with our own code
 * and reporting the result. That is a real check with one honest limit: every part of it is ours.
 * A reader who does not trust the operator has no reason to trust the operator's report that the
 * operator's log is intact.
 *
 * This screen is the part that does not need trusting. The head hash was published to a contract
 * on Base at a named block by a named key, and everything needed to repeat the read without us —
 * contract, key, block — is on screen. Rewriting history stays possible; producing a rewrite that
 * hashes to a value Base has been holding since before the rewrite does not.
 *
 * The four states are deliberately not four shades of green:
 *
 *   MATCH     the head on-chain is the head we hold.
 *   AHEAD     rows written since the last anchor. Ordinary, and checked rather than assumed —
 *             the server re-hashes the row at the anchored position before it says this.
 *   DIVERGED  the trail changed underneath a commitment. The alarm, and the reason to build this.
 *   NONE      nothing committed yet, which is a claim of nothing rather than a claim of safety.
 *
 * Those four are still the executor's verdict, and a sceptic has no more reason to accept this one than the last. So the
 * screen asks again without it (FEATURES.md #12): the trail's export re-hashed on this device, against the head read from
 * the contract through the build's own RPC. One line comes back — matches, does not match, or could not check — with the
 * block the head was anchored at. There is no repair, here or anywhere.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { isAddress } from 'viem';
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
import { useAsync } from '@/data/useAsync';
import { errorText } from '@/data/apiError';
import { system } from '@/data/system';
import type { AnchorReport, AuditAnchor } from '@/data/types';
import { checkTrail, checkWords, type TrailCheck } from '@/audit/anchorCheck';
import { useAuth } from '@/auth/useAuth';
import { useHasHydrated, useStore } from '@/state/store';
import { readLatestAnchor } from '@/wallet/chainAccess';

/** The head is 32 bytes; a reader compares the ends, so show the ends. */
const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-8)}`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const STATE: Record<
  AnchorReport['state'],
  { label: string; tone: string; line: (r: AnchorReport) => string }
> = {
  /*
   * "The chain", never "Base". A fork build anchors to a fork, and the screen said Base whatever
   * `data.chain` was; the one place the network is named is the check-it-yourself line, from the data.
   */
  match: {
    label: 'COMMITTED',
    tone: colors.up,
    line: (r) =>
      `All ${r.entryCount.toLocaleString('en-US')} entries are covered by the hash the chain is holding.`,
  },
  ahead: {
    label: 'COMMITTED · NEWER ENTRIES',
    tone: colors.up,
    line: (r) =>
      `${(r.entryCount - (r.latest?.entryCount ?? 0)).toLocaleString('en-US')} entries have been ` +
      'written since the last anchor. The entry that was anchored still hashes to what the chain holds.',
  },
  diverged: {
    label: 'DIVERGED',
    tone: colors.down,
    line: () =>
      'The trail no longer hashes to the value published on the chain. Something changed underneath a ' +
      'commitment that was already made.',
  },
  none: {
    label: 'NOT YET ANCHORED',
    tone: colors.ink40,
    line: () =>
      'Nothing has been published for this wallet yet, so nothing here is committed to the chain.',
  },
};

/**
 * Why the device could not check, in the words its card shows. The reads' own errors are for a log: viem's spell out the
 * ABI and the calldata, and the transport's carry a status line.
 */
class Unchecked extends Error {}

/**
 * The trail, checked here: the export re-hashed on this device, against `latest()` read from the contract.
 *
 * The executor still names where to read — the contract and its key, both printed in full below for anyone who would
 * rather not take that either — and says nothing about what is there.
 */
async function checkOnDevice(report: AnchorReport, subject: string | undefined): Promise<TrailCheck> {
  // A deployment with no contract has anchored nothing; there is no head to hold the trail to.
  if (!report.configured) return { result: 'unchecked', reason: 'not-anchored' };
  const { contract, anchoredBy } = report;
  if (!subject || !isAddress(subject)) throw new Unchecked('No wallet address on this device.');
  if (!isAddress(contract) || !isAddress(anchoredBy)) throw new Unchecked('The anchor’s address did not read.');
  const [trail, anchor] = await Promise.all([
    system.auditTrail().catch(() => {
      throw new Unchecked('The trail did not load.');
    }),
    readLatestAnchor(contract, anchoredBy, subject).catch(() => {
      throw new Unchecked('The chain did not answer.');
    }),
  ]);
  return checkTrail(trail.rows, anchor);
}

/** The device's result is a verdict of its own, so it takes the verdict colours the state above uses. */
const DEVICE_TONE = { up: colors.up, down: colors.down, quiet: colors.ink40 } as const;

export default function AuditAnchorScreen() {
  const goBack = useGoBack();
  const { data, loading, error, reload, settledAt } = useAsync(() => system.auditAnchor(), []);
  /*
   * The wallet the anchor is about, as this device knows it: the one on file, or Privy's own address in a session that
   * never ran onboarding — the owner `/verify` asks about. Not the executor's say-so, which is what is being checked.
   */
  const auth = useAuth();
  const stored = useStore((s) => s.wallet?.address);
  const subject = stored ?? (auth.authenticated ? auth.address : undefined);
  const hydrated = useHasHydrated();
  const onDevice = useAsync(
    () => (data && hydrated ? checkOnDevice(data, subject) : new Promise<TrailCheck>(() => undefined)),
    // Again whenever the report is read again — after an anchor above all, which moves the head.
    [settledAt, subject, hydrated],
  );
  const deviceWords = onDevice.loading
    ? undefined
    : onDevice.error
      ? {
          title: 'Couldn’t check',
          line: onDevice.error instanceof Unchecked ? onDevice.error.message : 'Something went wrong.',
          tone: 'quiet' as const,
        }
      : onDevice.data
        ? checkWords(onDevice.data)
        : undefined;
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<{ text: string; failed: boolean }>();

  async function anchorNow() {
    setBusy(true);
    setNote(undefined);
    try {
      const out = await system.anchorNow();
      setNote({
        text: out.anchored
          ? `Published entry ${out.entryCount} to the chain.`
          : /*
             * "Already anchored" is a success, not a failure, and saying so plainly matters:
             * pressing this twice should read as "there was nothing new to say", never as an error.
             */
            out.detail,
        failed: false,
      });
      reload();
    } catch (e) {
      // The executor's sentence. `e.message` carried the status line and the raw JSON body.
      setNote({ text: errorText(e), failed: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <HeaderBar onBack={goBack} title={<Text variant="screenTitle">On-chain anchor</Text>} />

      <Fill style={{ marginTop: space.s20 }}>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <Placeholder height={200} />
        ) : !data ? null : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30, gap: space.s12 }}
          >
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <Text variant="footnote" color={colors.ink55}>
                STATE
              </Text>
              <Text variant="screenTitle" color={STATE[data.state].tone} style={{ marginTop: space.s6 }}>
                {STATE[data.state].label}
              </Text>
              <Text variant="secondarySm" color={colors.ink65} style={{ marginTop: space.s8 }}>
                {STATE[data.state].line(data)}
              </Text>
            </SheetCard>

            {/*
              The same question without the executor. "Checking…" until the trail is hashed, then one line — and a way to
              ask again only where a read failed. A result is not something to retry until it says something else.
            */}
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <Text variant="footnote" color={colors.ink55}>
                ON THIS DEVICE
              </Text>
              <Text
                variant="screenTitle"
                color={deviceWords ? DEVICE_TONE[deviceWords.tone] : colors.ink40}
                style={{ marginTop: space.s6 }}
              >
                {deviceWords?.title ?? 'Checking…'}
              </Text>
              {deviceWords ? (
                <Text variant="secondarySm" color={colors.ink65} style={{ marginTop: space.s8 }}>
                  {deviceWords.line}
                </Text>
              ) : null}
              {onDevice.error ? (
                <Button
                  label="Check again"
                  variant="ghost"
                  onPress={onDevice.reload}
                  style={{ marginTop: space.s12 }}
                />
              ) : null}
            </SheetCard>

            {data.latest ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
                <Text variant="footnote" color={colors.ink55}>
                  WHAT THE CHAIN HOLDS
                </Text>
                <Text variant="rowPrimary" style={{ marginTop: space.s6 }}>
                  {shortHash(data.latest.head)}
                </Text>
                <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s6 }}>
                  {`entry ${data.latest.entryCount.toLocaleString('en-US')} · block ${data.latest.blockNo.toLocaleString('en-US')}`}
                </Text>
                <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s2 }}>
                  {`since ${new Date(data.latest.at * 1000).toUTCString().replace(' GMT', ' UTC')}`}
                </Text>
              </SheetCard>
            ) : null}

            {/*
              The address of the contract and the key that signed, because the point of this screen
              is that the reader does not have to take any of it from us. These two values plus a
              public RPC reproduce everything above.
            */}
            <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
              <Text variant="footnote" color={colors.ink55}>
                CHECK IT YOURSELF
              </Text>
              <Text variant="secondarySm" color={colors.ink65} style={{ marginTop: space.s6 }}>
                {`Read latest(${shortAddr(data.anchoredBy)}, your address) on ${shortAddr(data.contract)}, on ${data.chain}. The signing key is the bot's key, the same one on the safety screen.`}
              </Text>
              <View style={{ marginTop: space.s10, gap: space.s4 }}>
                <Text variant="footnote" color={colors.ink55}>
                  {`contract  ${data.contract}`}
                </Text>
                <Text variant="footnote" color={colors.ink55}>
                  {`anchored by  ${data.anchoredBy}`}
                </Text>
              </View>
            </SheetCard>

            {data.history.length > 1 ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s18}>
                <Text variant="footnote" color={colors.ink55}>
                  {`EVERY COMMITMENT (${data.history.length})`}
                </Text>
                {[...data.history].reverse().map((a: AuditAnchor) => (
                  <View key={`${a.blockNo}-${a.head}`} style={{ marginTop: space.s10 }}>
                    <Text variant="secondarySm">{shortHash(a.head)}</Text>
                    <Text variant="footnote" color={colors.ink55}>
                      {`entry ${a.entryCount.toLocaleString('en-US')} · block ${a.blockNo.toLocaleString('en-US')}`}
                    </Text>
                  </View>
                ))}
              </SheetCard>
            ) : null}

            {note ? (
              <Text variant="footnote" color={note.failed ? colors.down : colors.ink55}>
                {note.text}
              </Text>
            ) : null}

            <Button
              label={data.state === 'ahead' || data.state === 'none' ? 'Anchor now' : 'Anchor again'}
              loading={busy}
              onPress={anchorNow}
            />
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
