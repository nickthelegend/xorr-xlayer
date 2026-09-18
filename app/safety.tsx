/**
 * Safety — the kill switch. screens.md Group C, distilled 2026-09-14.
 *
 * A state chip, a title and one line, all from the chain's answer; two rings, today's cap and the time left; the two
 * parties to the permission; the approvals that outlive a stop; the rows that guard the wallet; one button. PLAN.md 6.10
 * / 12.5: the button SIGNS AN ON-CHAIN REVOKE from the user's own wallet, so a stop needs no server to reach every
 * device — and, since FEATURES.md #1, none to be offered: when the executor cannot be read, the chain is asked directly.
 * The stop is held, not tapped (FEATURES.md #3).
 */
import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { isAddress } from 'viem';
import { useGoBack } from '@/nav/useGoBack';
import * as LocalAuthentication from 'expo-local-authentication';
import {
  BackButton,
  Button,
  signIn,
  Eyebrow,
  Fill,
  HoldButton,
  NoteStrip,
  Placeholder,
  Press,
  Ring,
  Row,
  Screen,
  SheetCard,
  StopCurtain,
  Text,
  colors,
  quantity,
  radius,
  size,
  space,
} from '@/ui';
import { shortAddress } from '@/format';
import {
  capUsed,
  capUsedFigure,
  delegateUnusable,
  delegationExpired,
  permissionOnChain,
  permissionUnreadable,
  expiryNote,
  expiryState,
  killCta,
  killExplanation,
  killTitle,
  termLeft,
  timeLeft,
} from '@/state/derived';
import { useStore } from '@/state/store';
import { delegationOrUnknown, delegationScope } from '@/accounts/delegationScope';
import { readDelegationIntoStore } from '@/wallet/readDelegation';
import { useNow } from '@/state/useNow';
import { pinnedDelegation } from '@/chain';
import { useAllowlist } from '@/wallet/allowlist';
import { useApprovals, type ApprovalsView } from '@/wallet/useApprovals';
import { planResume, type GrantOptions } from '@/wallet/grantPlan';
import { chainAccess } from '@/wallet/chainAccess';
import { standingOnChain, type ChainStanding } from '@/wallet/delegationChain';
import { useAuth } from '@/auth/useAuth';
import { useGrantDelegation } from '@/auth/useGrantDelegation';
import { repos } from '@/data';
import { api } from '@/data/api';
import { system } from '@/data/system';
import { useAsync } from '@/data/useAsync';
import { useFreshOnReturn } from '@/data/useFreshOnReturn';
import { errorText, NotSignedIn } from '@/data/apiError';

/**
 * What was running, in words, for the curtain that confirms the stop.
 *
 * From the counts this screen already read, and by kind: a live strategy is scheduled against this permission exactly
 * as a hired agent is, and calling the sum "agents" is the conflation `running` was split up to fix.
 */
function stoppedDetail({ agents, strategies }: { agents: number; strategies: number }): string {
  const parts: string[] = [];
  if (agents > 0) parts.push(`${agents} ${agents === 1 ? 'agent' : 'agents'}`);
  if (strategies > 0) parts.push(`${strategies} ${strategies === 1 ? 'strategy' : 'strategies'}`);
  if (parts.length === 0) return 'Nothing was running when you stopped it.';
  return `${parts.join(' and ')} stopped.`;
}

/** The state chip's dot. 7pt — screens.md gives this one exactly. */
const DOT = 7;
const SETTING_ROW = 52;

export default function Safety() {
  const router = useRouter();
  const goBack = useGoBack();
  /*
   * How many things can actually place an order right now, from the server. Counting a boolean in
   * browser state would make the kill switch's own explanation a guess.
   *
   * This counted HIRED AGENTS alone, and that is not the set that can trade. A wallet with no
   * agent hired and five live strategies read "0 agents can place orders inside your limits right
   * now" under a green LIVE badge — while one of those strategies was placing an order. A live
   * strategy is scheduled against this permission exactly as a hired agent is; both stop when the
   * switch below is pulled, so both belong in the sentence that says what the switch stops.
   *
   * Counted by kind, and only once both reads have answered. The sum was then called agents — nine
   * live strategies read "9 agents can trade" — and a roster that failed to load counted as no
   * agents at all, which is "Nothing is running" under a permission that may be trading.
   */
  const roster = useAsync(() => repos.bot.listAgents(), []);
  const strategies = useAsync(() => repos.strategies.list(), []);
  const running =
    roster.data && strategies.data
      ? {
          agents: roster.data.filter((a) => a.hired).length,
          strategies: strategies.data.filter((s) => s.state === 'live').length,
        }
      : undefined;
  /** Still counting, as opposed to unable to count. */
  const counting = running === undefined && !roster.error && !strategies.error;

  const storedKilled = useStore((s) => s.killed);
  const setKilled = useStore((s) => s.setKilled);
  const setDelegation = useStore((s) => s.setDelegation);
  /*
   * The cached permission ONLY when it belongs to the address in use.
   *
   * A switch re-points every executor call at another account; carrying the old grant across would
   * show one account's cap while the executor acts on another. `undefined` is "not read yet",
   * which is what every reader here already treats as still-loading — `null` is a claim that this
   * address has granted nothing, and must never stand in for not having looked.
   */
  const delegation = delegationOrUnknown(
    delegationScope({
      cached: useStore((s) => s.delegation),
      cachedFor: useStore((s) => s.delegationAddress),
      active: useStore((s) => s.wallet?.address),
    }),
  );
  const recoveryBackedUp = useStore((s) => s.recoveryBackedUp);
  const [localError, setLocalError] = useState<string>();
  /*
   * The stop, while it is happening (`StopCurtain`). Real, both of it: `signing` is a revoke actually out
   * for signature, and `stopped` is set only after `signRevoke()` returns — which it does only once the
   * chain shows the policy revoked. A failure clears it, so the curtain never claims a stop that did not
   * land; the error under it says what went wrong.
   */
  const [stopping, setStopping] = useState<'signing' | 'stopped'>();
  /** The revoke's transaction, once the chain has confirmed it. Never set from anything but a real one. */
  const [stopSignature, setStopSignature] = useState<string>();
  // Expiry is judged against a clock that is state, so a render stays a pure function of what it read.
  const now = useNow();

  /*
   * The permission, loaded when the screen opens, with the failure KEPT rather than swallowed: an unreachable executor
   * once left `delegation` null and this screen announced "No permission has been granted" over a live on-chain grant.
   */
  const [delegationError, setDelegationError] = useState<unknown>(undefined);
  /** No session, so the chain was never asked. Distinct from asked-and-absent. */
  const [signedOut, setSignedOut] = useState(false);
  /**
   * Whether the executor has answered on this visit, either way.
   *
   * The store's `delegation` is null both before the first read and after a read that found nothing, so a cold open
   * showed NOT GRANTED · "No agents can trade" until the answer arrived — a claim made before anything was asked.
   */
  const [answered, setAnswered] = useState(false);
  useEffect(() => {
    let alive = true;
    void readDelegationIntoStore()
      .then(() => {
        if (!alive) return;
        setDelegationError(undefined);
      })
      .catch((e: unknown) => {
        // Signed out is its own state — not "no permission", and not a failed read.
        if (!alive) return;
        if (e instanceof NotSignedIn) setSignedOut(true);
        else setDelegationError(e);
      })
      .finally(() => {
        if (alive) setAnswered(true);
      });
    return () => {
      alive = false;
    };
  }, [setDelegation]);

  /*
   * The chain's own answer, for when the executor's could not be had (FEATURES.md #1).
   *
   * With the executor unreachable this screen said "Couldn’t read your permission" and hid the stop — the one control
   * built to need no server, gone exactly when the server was. So a failed read is followed by the chain's: the policy
   * the build's pinned contract holds for the wallet that would sign the stop. Kept beside the failure that asked for
   * it, so a later failure is never answered by an earlier read.
   */
  const { address } = useAuth();
  const owner = address && isAddress(address, { strict: false }) ? address : undefined;
  const [chainRead, setChainRead] = useState<{ after: unknown; owner: string; standing: ChainStanding }>();
  useEffect(() => {
    if (delegationError === undefined || !owner) return;
    let alive = true;
    const after = delegationError;
    void standingOnChain(chainAccess, owner, pinnedDelegation, Date.now()).then((standing) => {
      if (alive) setChainRead({ after, owner, standing });
    });
    return () => {
      alive = false;
    };
  }, [delegationError, owner]);
  /** What this screen last changed on the permission: a stop it sent, or a grant. */
  const [sent, setSent] = useState<'stop' | 'grant'>();

  /*
   * Whose account of the permission governs.
   *
   * The executor's record, read on this visit or held from earlier — until this screen changes the permission and the
   * executor cannot be asked afterwards. The record from before the change no longer describes it; the chain, which the
   * change was confirmed on, does.
   */
  const record = delegation && !(sent && delegationError !== undefined) ? delegation : null;
  /** The chain's answer to the executor's latest failure, for the wallet signed in now. */
  const standing =
    chainRead && chainRead.after === delegationError && chainRead.owner === owner ? chainRead.standing : undefined;
  /** What the chain lets this screen show in the executor's place: a live permission, or the stop sent from here. */
  const fromChain =
    !record && delegationError !== undefined && !signedOut ? permissionOnChain(standing, sent === 'stop') : undefined;
  /** The policy behind it, for the parties and the expiry. */
  const chainPolicy =
    fromChain && standing && (standing.kind === 'live' || standing.kind === 'revoked') ? standing.policy : undefined;

  /*
   * Stopped, according to the chain — not according to a flag we kept.
   *
   * `killed` was a persisted store boolean, set when the user pressed the button in THIS browser. The chain already
   * carries the answer as `revoked`, and the two drift the moment anything happens outside the session: a revoke from
   * another device, a reload after site data is cleared, or simply the store not being written. Measured on the
   * deployed build: the kill switch was pressed and confirmed, /verify read `revoked=true` off the contract, and this
   * screen still showed a green LIVE badge. The chain governs whenever there is a permission to read; the stored flag
   * survives only as the answer before the first fetch lands, and for the case where there is no permission at all.
   */
  const killed = record ? record.revoked : fromChain ? fromChain === 'stopped' : storedKilled;

  /*
   * A granted permission the bot cannot actually use: not revoked, not expired, cap intact — and inert, because it
   * names a delegate key the executor is not. The screen reported LIVE through exactly this, so it gets its own state.
   */
  const unusable = delegateUnusable(record, killed);
  /** Is there a permission at all? Distinct from "is it revoked" — a wallet that never granted has nothing to stop. */
  const granted = record !== null || fromChain !== undefined;
  /** When it ends, from whichever read governs. The chain keeps seconds. */
  const expiresAt = record ? record.expiresAt : chainPolicy ? Number(chainPolicy.expiresAt) * 1000 : undefined;

  /*
   * A permission that ran out. An expired policy showed a green dot reading **Live** over "Agents are live" — seen on
   * the hosted deployment thirteen hours after a grant lapsed, while `/limits` reported `$0 left today`.
   */
  const expired = delegationExpired({ expiresAt }, killed, now);

  // The allowlist is real and the executor holds it; read it.
  const { addresses, loading: allowlistLoading, error: allowlistError } = useAllowlist();

  /*
   * The second lock, read from the party that enforces it. `XorrDelegation` bounds the BOT; the wallet's own policy
   * bounds what this wallet may be asked to sign. It has its own screen; here it is one row that says whether it is on
   * — or that it could not be read, rather than the row quietly not being there.
   */
  const privy = useAsync(() => repos.wallet.privyPolicy(), []);
  // Back from a strategy, the roster or the wallet policy, the count and the policy row are read again (FEATURES.md #27).
  useFreshOnReturn(roster, strategies, privy);

  /*
   * The standing allowances, which survive a revoke. Stopping the agents revokes the DELEGATION; the ERC-20 approvals
   * are a separate grant to the same contract and are untouched by it, so they are shown where someone disengages.
   */
  const { approvals, revoke: revokeApproval, revoking } = useApprovals();

  /** Could not be read — distinct from read and absent, and from read on the chain. Outranks every other state below. */
  const unreadable = fromChain === undefined && permissionUnreadable(delegationError, record, signedOut);
  /** The executor failed and the chain is being asked: still asking, not yet unknown. */
  const askingChain =
    !record && delegationError !== undefined && !signedOut && owner !== undefined && standing === undefined;
  /** Nothing read yet and nothing from earlier in the session to show meanwhile. */
  const asking = (!answered || askingChain) && !granted;
  /** The one sentence that depends on the count: a live permission, as the executor reported it. */
  const needsCount =
    !asking && !signedOut && !unreadable && granted && !killed && !unusable && !expired && fromChain === undefined;
  /** A permission that can trade now, by whichever read governs: what the two rings describe. */
  const live = !asking && !signedOut && !unreadable && granted && !killed && !unusable && !expired;

  // Signed by the user, on-chain: a stop reaches every device without any server needing to be reachable.
  const { grant: signGrant, revoke: signRevoke, busy, error: txError } = useGrantDelegation();
  const error = localError ?? txError;

  /** The grant, called as a resume calls it: with the approvals the plan found missing (PLAN.md 4.7). */
  const grantWith: (dailyCapUsd: number, durationMs: number, options: GrantOptions) => Promise<unknown> =
    signGrant;

  /*
   * What a re-grant signs, planned from fresh reads of the chain (PLAN.md 4.7): the cap the chain holds, the length the
   * last grant ran, and only the approvals no longer enough — read when the button is pressed, since an allowance can
   * move while the screen is open.
   */
  async function planFromChain() {
    const [permission, params, allowances] = await Promise.all([
      repos.wallet.delegation(),
      system.delegationParams(),
      api.get<ApprovalsView>('/approvals'),
    ]);
    return planResume({ permission, params, allowances, now: Date.now() });
  }

  async function toggle() {
    setLocalError(undefined);
    // The stop is what the held button commits; every other state here re-grants.
    const stopping = !(killed || unusable || expired);
    try {
      const plan = stopping ? undefined : await planFromChain();
      // Nothing on record to resume from: the limits are the user's to set, on the screen that sets them.
      if (plan?.kind === 'choose') {
        router.push('/delegate');
        return;
      }
      // Biometrics gate every change to what the bot may do. PLAN.md 12.20.
      const hasHw = await LocalAuthentication.hasHardwareAsync().catch(() => false);
      const enrolled = hasHw
        ? await LocalAuthentication.isEnrolledAsync().catch(() => false)
        : false;
      if (enrolled) {
        const res = await LocalAuthentication.authenticateAsync({
          promptMessage: unusable
            ? 'Reconnect trading'
            : expired
              ? 'Grant a new permission'
              : killed
                ? 'Resume trading'
                : 'Stop all trading',
        });
        if (!res.success) {
          setLocalError('Not confirmed. Nothing changed.');
          return;
        }
      }
      /*
       * A disconnected or expired permission is re-granted, not revoked: revoking would take the user from a permission
       * that does not work to no permission at all — a transaction, a wallet prompt and a fee to change nothing.
       */
      if (plan) await grantWith(plan.dailyCapUsd, plan.durationMs, { approvals: plan.approvals });
      else {
        setStopping('signing');
        /*
         * The transaction the stop went out as, kept. `revoke()` resolves only once `confirmStopped` has seen this
         * hash revoke the policy on-chain, so what the curtain shows is evidence rather than a claim — and it is the
         * one thing on that screen someone can check for themselves.
         */
        setStopSignature(await signRevoke());
        setStopping('stopped');
      }
    } catch (e) {
      // The curtain comes back up: nothing was stopped, and the screen underneath says why.
      setStopping(undefined);
      setLocalError(errorText(e));
      return;
    }
    /*
     * Done: the grant recorded, or the stop confirmed on the chain. What the screen shows next is read again, and a read
     * that fails now is not an error about a change that happened — with the executor down, which is exactly when a stop
     * goes out without it, the chain answers in its place (`permissionOnChain`).
     */
    setSent(stopping ? 'stop' : 'grant');
    setKilled(unusable || expired ? false : !killed);
    try {
      await readDelegationIntoStore();
      setDelegationError(undefined);
    } catch (e) {
      if (e instanceof NotSignedIn) setSignedOut(true);
      else setDelegationError(e);
    }
  }

  const heldApprovals = approvals ? approvals.tokens.filter((t) => !t.none && !t.unread) : [];
  // The rings, from the read that governs. A policy read off the chain alone carries no spend and no start.
  const spent = capUsed(record);
  const term = termLeft(record, now);
  const left = timeLeft(expiresAt, now);
  const ownerShown = record ? record.ownerPubkey : owner;
  const delegateShown = record ? record.delegatePubkey : chainPolicy?.delegate;

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
        <BackButton onPress={() => goBack()} />
        <Text variant="screenTitle">Safety</Text>
      </View>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.s8,
          alignSelf: 'flex-start',
          marginTop: space.s20,
          backgroundColor: colors.surfaceAlt,
          borderRadius: radius.card,
          paddingHorizontal: space.s12,
          paddingVertical: space.s6,
        }}
      >
        <View
          style={{
            width: DOT,
            height: DOT,
            borderRadius: radius.full,
            backgroundColor:
              asking || unreadable
                ? colors.ink30
                : unusable || expired
                  ? colors.down
                  : killed || !granted
                    ? colors.ink30
                    : colors.up,
          }}
        />
        {/* "Unknown" outranks everything: saying "Not granted" because a read failed is the one claim this must never make. */}
        <Text
          variant="tagSm"
          color={
            asking || unreadable
              ? colors.ink55
              : unusable || expired
                ? colors.down
                : killed || !granted
                  ? colors.ink55
                  : colors.up
          }
        >
          {signedOut
            ? 'Not signed in'
            : asking
              ? '· · ·'
              : unreadable
                ? 'Unknown'
                : unusable
                  ? 'Disconnected'
                  : !granted
                    ? 'Not granted'
                    : expired
                      ? 'Expired'
                      : killed
                        ? 'Stopped'
                        : 'Live'}
        </Text>
      </View>

      {!signedOut && asking ? (
        <Placeholder width={240} height={30} style={{ marginTop: space.s16 }} />
      ) : (
        <Text variant="onboardingTitle" style={{ marginTop: space.s16 }}>
          {signedOut
            ? 'Sign in to see what can trade'
            : unreadable
              ? 'Couldn’t read your permission'
              : killTitle(killed, unusable, granted, expired)}
        </Text>
      )}
      {!signedOut && (asking || (needsCount && counting)) ? (
        <Placeholder width={220} height={18} style={{ marginTop: space.s8 }} />
      ) : (
        <Text variant="body" color={colors.ink55} style={{ marginTop: space.s8 }}>
          {signedOut || unreadable
            ? 'Anything you granted stays in force.'
            : fromChain === 'live'
              ? 'Our server isn’t answering. Stopping still works.'
              : killExplanation(killed, running, unusable, granted, expired)}
        </Text>
      )}

      {/* Scrolls on a short phone; the stop button stays pinned below rather than scrolling away. */}
      <Fill style={{ marginTop: space.s20 }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: space.s16, gap: space.s12 }}
        >
          {/* Today's cap used and the time left, while the permission can trade: a stopped or ended one has neither. */}
          {live ? (
            <SheetCard borderRadius={radius.panel} padding={space.s16}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
                <Ring
                  fraction={spent}
                  value={capUsedFigure(spent)}
                  label="Cap used"
                  accessibilityLabel={`Cap used, ${spent === undefined ? 'unknown' : capUsedFigure(spent)}`}
                />
                <Ring
                  fraction={term}
                  value={left.figure}
                  label="Time left"
                  accessibilityLabel={`Time left, ${left.words}`}
                />
              </View>
            </SheetCard>
          ) : null}

          {/*
            Signed out, nobody's permission has been read: a sign-in, not a claim about a wallet nobody named. And a read
            that failed is not "Nothing granted yet": that card is for a wallet something actually answered for.
          */}
          {signedOut ? (
            <Button label="Sign in" onPress={signIn} />
          ) : asking ? (
            <Placeholder height={110} style={{ borderRadius: radius.panel }} />
          ) : record || chainPolicy ? (
            <SheetCard borderRadius={radius.panel} padding={space.s16}>
              <Row
                title="Your wallet"
                value={
                  <Text variant="rowPrimary" color={colors.ink55} selectable>
                    {ownerShown ? shortAddress(ownerShown) : '—'}
                  </Text>
                }
                height={SETTING_ROW}
              />
              <Row
                title="Agent key"
                secondary="Can’t withdraw"
                value={
                  <Text variant="rowPrimary" color={colors.ink55} selectable>
                    {delegateShown ? shortAddress(delegateShown) : '—'}
                  </Text>
                }
                height={size.rowLg}
                divider={false}
              />
            </SheetCard>
          ) : unreadable ? null : (
            <SheetCard borderRadius={radius.panel} padding={space.s16}>
              <Text variant="rowPrimary">Nothing granted yet</Text>
              <Button
                label="Set limits"
                variant="ghost"
                onPress={() => router.push('/delegate')}
                style={{ marginTop: space.s12 }}
              />
            </SheetCard>
          )}

          {/* The deadline the contract enforces whether or not anyone is watching — only when it is close. */}
          {expiryNote(expiresAt, now) ? (
            <NoteStrip kind={expiryState(expiresAt, now) === 'expired' ? 'blocked' : 'risk'}>
              {expiryNote(expiresAt, now)!}
            </NoteStrip>
          ) : null}

          {/* What the contract can still pull, and the way to take it back. Only when something is approved. */}
          {approvals && heldApprovals.length > 0 ? (
            <SheetCard borderRadius={radius.panel} padding={space.s16}>
              <Eyebrow small>Token approvals</Eyebrow>
              <View style={{ gap: space.s10, marginTop: space.s10 }}>
                {heldApprovals.map((t) => (
                  <View
                    key={t.address}
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s10 }}
                  >
                    <View style={{ flexShrink: 1 }}>
                      <Text variant="rowPrimary">{t.symbol}</Text>
                      {/*
                        The number, not the word: "Limited" tells nobody whether they are comfortable with it. Only a
                        number the executor actually sent — `Number(null)` is 0, which read "Up to 0.0000".
                      */}
                      <Text variant="footnote" color={colors.ink55}>
                        {t.unlimited
                          ? 'No limit'
                          : typeof t.display === 'string' && t.display.trim() !== '' && Number.isFinite(Number(t.display))
                            ? `Up to ${quantity(Number(t.display), Number(t.display) >= 1 ? 2 : 4)}`
                            : 'Limited'}
                      </Text>
                    </View>
                    <Button
                      label="Revoke"
                      variant="ghost"
                      loading={revoking === `${approvals.spender}:${t.symbol}`}
                      onPress={() => revokeApproval(t, approvals.spender)}
                    />
                  </View>
                ))}
              </View>
            </SheetCard>
          ) : null}

          {signedOut ? null : (
            <SheetCard borderRadius={radius.panel} padding={space.s16}>
              <Row
                title="Wallet policy"
                value={
                  <Text variant="rowPrimary" color={colors.ink55}>
                    {/* A policy nobody could read is not a policy that is off, and not a row to leave out. */}
                    {privy.error ? '—' : privy.data ? (privy.data.enforced ? 'On' : 'Off') : '· · ·'}
                  </Text>
                }
                height={SETTING_ROW}
                onPress={() => router.push('/policy')}
              />
              <Row
                title="Allowlist"
                value={
                  <Text variant="rowPrimary" color={colors.ink55}>
                    {/* A count the executor has not given is not zero addresses. */}
                    {allowlistError
                      ? '—'
                      : allowlistLoading
                        ? '· · ·'
                        : addresses.length === 1
                          ? '1 address'
                          : `${addresses.length} addresses`}
                  </Text>
                }
                height={SETTING_ROW}
                onPress={() => router.push('/allowlist')}
              />
              <Row
                title="Recovery"
                value={
                  <Text variant="rowPrimary" color={recoveryBackedUp ? colors.ink55 : colors.warn}>
                    {recoveryBackedUp ? 'Done' : 'Review'}
                  </Text>
                }
                height={SETTING_ROW}
                divider={false}
                onPress={() => router.push('/recovery')}
              />
            </SheetCard>
          )}
        </ScrollView>
      </Fill>

      {error ? (
        <Text variant="secondarySm" color={colors.down} style={{ marginBottom: space.s10 }}>
          {error}
        </Text>
      ) : null}

      {/* No permission, no kill switch: the card above offers the one action that makes sense. */}
      {granted && !unreadable ? (
        <>
          {/*
            The stop is held, not tapped (FEATURES.md #3): it signs a revoke, and a stray touch should not. A screen
            reader, a key or a switch still commits with one activation, and the biometric prompt guards every way in.
            A resume, a reconnect and a new grant stay taps.
          */}
          {killed || unusable || expired ? (
            <Button
              label={killCta(killed, unusable, granted, expired)}
              variant="primary"
              height={size.buttonLg}
              loading={busy}
              onPress={toggle}
            />
          ) : (
            <HoldButton
              label={killCta(killed, unusable, granted, expired)}
              accessibilityHint="Hold to stop"
              height={size.buttonLg}
              loading={busy}
              onCommit={toggle}
            />
          )}
          <Text variant="footnote" color={colors.ink55} align="center" style={{ marginTop: space.s12 }}>
            {killed || unusable || expired
              ? 'You’ll sign to confirm.'
              : /* A revoked policy refuses closePosition too (XorrDelegation.sol), so no stop-loss can fire after this. */
                'Stops all trading, stop-losses too. Your funds stay in your wallet.'}
          </Text>
        </>
      ) : null}
      {/*
        The stop, while it happens and once it lands (FEATURES.md, animations.md "The stop's curtain"). Its detail line
        is the count this screen already read, and only when it was actually read — a stop that says "0 agents were
        running" because a roster failed to load would be the screen guessing about the thing it just did.
      */}
      <StopCurtain
        state={stopping}
        detail={running ? stoppedDetail(running) : undefined}
        signature={stopSignature}
        onDone={() => setStopping(undefined)}
      />

      {/* Stopping and exiting are different needs: exiting is a quiet link, never a second red button. */}
      {signedOut ? null : (
        <Press
          onPress={() => router.push('/flatten')}
          accessibilityRole="button"
          accessibilityLabel="Sell every position into USDC"
          hitHeight={size.hit}
          style={{ marginTop: space.s14, alignItems: 'center' }}
        >
          <Text variant="footnote" color={colors.ink55}>
            Sell everything to cash ›
          </Text>
        </Press>
      )}
    </Screen>
  );
}
