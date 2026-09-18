/**
 * Withdraw everything — PLAN.md 4.9.
 *
 * Every position sold into USDC through the executor, the USDC taken out of Aave, and all of it sent
 * to one usable address on the allowlist — in that order, each step waiting for the one before it,
 * and the first thing that fails stopping everything after it, with the reason.
 *
 * What each step will touch is said before the button, and what each step did is shown after it,
 * per transaction. Two of the three steps are the owner's own signatures: the executor sells because
 * it holds the permission to, and it cannot take anything out of Aave or send anything anywhere, so
 * nothing here asks it to.
 *
 * Confirmed in two presses, as a limit order is: the first says exactly what the second does. And the
 * destination is chosen by a tap, never by default — this moves everything, and where it goes is not
 * a guess to make on someone's behalf.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  Button,
  Eyebrow,
  Fill,
  NoteStrip,
  RadioCard,
  Screen,
  SheetCard,
  Tag,
  Text,
  colors,
  money,
  quantity,
  radius,
  size,
  space,
  SignInPrompt,
  type FigureKind,
  type TagTone,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { shortAddress } from '@/format';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { errorText } from '@/data/apiError';
import { withdrawals } from '@/data/withdrawals';
import { useStore } from '@/state/store';
import { delegationOrUnknown, delegationScope } from '@/accounts/delegationScope';
import { useAllowlist, usableFromText, usableIn } from '@/wallet/allowlist';
import { useWithdrawEverything } from '@/wallet/useWithdrawEverything';
import { sellBlocked, type Step } from '@/wallet/withdrawEverything';

const STATUS: Readonly<Record<Step['status'], { label: string; tone: TagTone }>> = {
  waiting: { label: 'Not started', tone: 'neutral' },
  running: { label: 'Working', tone: 'warn' },
  done: { label: 'Done', tone: 'up' },
  failed: { label: 'Stopped', tone: 'down' },
};

export default function WithdrawEverything() {
  const goBack = useGoBack();
  const router = useRouter();
  const allowlist = useAllowlist();
  const preview = useAsync(() => withdrawals.sellPreview(), []);
  const aave = useAsync(() => withdrawals.aavePosition(), []);
  const { steps, running, finished, run } = useWithdrawEverything();
  const [chosen, setChosen] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const signedOut = useSignedOut();

  const destination = allowlist.usable.find((a) => a.address === chosen);
  const started = running || finished !== undefined;

  /*
   * Step 1 sells through `closePosition`, which reverts on a revoked or expired permission (XorrDelegation.sol). After
   * "Stop all agents" the run stopped one transaction in, with the reason in red on a card nobody had been warned about.
   * The chain is asked here; the store's copy stands in until it answers, and nothing read yet is no claim. Only a run
   * with something to sell needs the permission — and a preview not read yet might have something.
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
  const cannotSell = blocked !== undefined && (preview.data ? preview.data.legs.length > 0 : true);

  async function press() {
    if (!destination || running || cannotSell) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setError(undefined);
    try {
      await run({ address: destination.address, label: destination.label });
    } catch (e) {
      setError(errorText(e));
    } finally {
      // Everything these read has changed on chain; read it again rather than guess.
      preview.reload();
      aave.reload();
      allowlist.reload();
    }
  }

  const legs = preview.data?.legs ?? [];
  const sells = preview.error
    ? `Couldn’t load positions: ${errorText(preview.error)}`
    : preview.loading && !preview.data
      ? 'Loading…'
      : legs.length === 0
        ? 'Nothing to sell.'
        : `${legs.map((l) => `${quantity(l.units)} ${l.symbol}`).join(', ')} · about ${money(preview.data!.totalUsd)}`;
  const exits = aave.error
    ? `Couldn’t load savings: ${errorText(aave.error)}`
    : aave.loading && !aave.data
      ? 'Loading…'
      : !aave.data?.available
        ? // Not the executor's `reason`: it names the pool and its address, or is the identifier `no_wallet`.
          'Nothing to take out here.'
        : aave.data.suppliedUsd > 0
          ? `${money(aave.data.suppliedUsd)} earning. You sign this step.`
          : 'Nothing supplied.';
  /*
   * The plan names the person's money — what would sell, what is earning — so those figures hide while balances are
   * hidden (FEATURES.md #47). A read that failed is the executor's sentence instead, drawn as it came.
   */
  const sellsFigure: FigureKind | undefined = preview.error ? undefined : 'units';
  const exitsFigure: FigureKind | undefined = aave.error ? undefined : 'own';

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
      <BackButton onPress={() => goBack()} />
      <Text variant="screenTitle">Withdraw everything</Text>
    </View>
  );

  // Signed out, each of the three steps would print its own "not signed in". There is one thing to do first.
  if (signedOut) {
    return (
      <Screen>
        {header}
        <SignInPrompt text="Sign in to withdraw." />
      </Screen>
    );
  }

  return (
    <Screen>
      {header}

      <Text variant="secondary" style={{ marginTop: space.s10 }}>
        Sell everything, then send it all to one saved address.
      </Text>

      <Fill style={{ marginTop: space.s16 }}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.s20 }}>
          {started ? (
            <Progress steps={steps} />
          ) : (
            <>
              <Eyebrow small>To</Eyebrow>
              <View style={{ gap: space.s10, marginTop: space.s12 }}>
                {allowlist.loading ? (
                  <Text variant="secondary" color={colors.ink55}>
                    Reading your allowlist…
                  </Text>
                ) : allowlist.error && allowlist.addresses.length === 0 ? (
                  <Text variant="secondary" color={colors.down}>
                    Your allowlist could not be read: {errorText(allowlist.error)}
                  </Text>
                ) : allowlist.addresses.length === 0 ? (
                  <Text variant="secondary" color={colors.ink55}>
                    No saved addresses yet.
                  </Text>
                ) : (
                  <>
                    {allowlist.usable.map((a) => (
                      <RadioCard
                        key={a.address}
                        title={a.label}
                        detail={a.address}
                        selected={a.address === destination?.address}
                        onPress={() => {
                          setChosen(a.address);
                          setConfirming(false);
                        }}
                      />
                    ))}
                    {allowlist.pending.map((a) => (
                      <Text key={a.address} variant="secondarySm" color={colors.ink55}>
                        {a.label} · {shortAddress(a.address)} — usable from {usableFromText(a)}
                        {allowlist.serverTime !== undefined ? `, ${usableIn(a, allowlist.serverTime)}` : ''}
                      </Text>
                    ))}
                    {allowlist.usable.length === 0 ? (
                      <Text variant="secondarySm" color={colors.warn}>
                        None is unlocked yet.
                      </Text>
                    ) : null}
                  </>
                )}
              </View>

              <Eyebrow small style={{ marginTop: space.s22 }}>
                In this order
              </Eyebrow>
              <SheetCard borderRadius={radius.note} padding={space.s16} style={{ marginTop: space.s10, gap: space.s12 }}>
                <PlanLine n={1} title="Sell every position" detail={sells} figure={sellsFigure} />
                <PlanLine n={2} title="Take your USDC out of savings" detail={exits} figure={exitsFigure} />
                <PlanLine
                  n={3}
                  title="Send your USDC"
                  detail={`All of it, to ${destination ? destination.label : 'the address you choose'}. You sign it.`}
                />
              </SheetCard>

              <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
                {preview.data?.skipped && preview.data.skipped.length > 0 && preview.data.dustBelowUsd !== undefined
                  ? `${preview.data.skipped.join(', ')} ${preview.data.skipped.length === 1 ? 'stays' : 'stay'}: under ${money(preview.data.dustBelowUsd)}. `
                  : ''}
                ETH stays, for network fees.
              </Text>

              {confirming && destination ? (
                <NoteStrip kind="risk" style={{ marginTop: space.s12 }}>
                  {`Everything goes to ${destination.label}. A finished step can’t be undone.`}
                </NoteStrip>
              ) : null}
            </>
          )}

          {error ? (
            <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s12 }}>
              {error}
            </Text>
          ) : null}
        </ScrollView>
      </Fill>

      {finished !== undefined ? (
        <Button label="Done" height={size.buttonLg} onPress={() => goBack()} />
      ) : (
        <>
          {!started ? (
            <Button
              label="Manage allowlist"
              variant="ghost"
              onPress={() => router.push('/allowlist')}
              style={{ marginBottom: space.s10 }}
            />
          ) : null}
          {/* The one line that explains why the button below is off, said before anyone presses it. */}
          {!started && cannotSell ? (
            <Text variant="secondarySm" color={colors.warn} style={{ marginBottom: space.s10 }}>
              {blocked}
            </Text>
          ) : null}
          <Button
            label={
              running
                ? 'Withdrawing…'
                : !destination
                  ? 'Choose where it goes'
                  : confirming
                    ? `Confirm: everything to ${destination.label}`
                    : `Withdraw everything to ${destination.label}`
            }
            variant="destructive"
            height={size.buttonLg}
            disabled={!destination || (!started && cannotSell)}
            loading={running}
            onPress={press}
          />
        </>
      )}
      <Text variant="footnote" color={colors.ink55} align="center" style={{ marginTop: space.s12 }}>
        The bot sells. Only you can send.
      </Text>
    </Screen>
  );
}

function PlanLine({ n, title, detail, figure }: { n: number; title: string; detail: string; figure?: FigureKind }) {
  return (
    <View>
      <Text variant="rowPrimary">
        {n}. {title}
      </Text>
      <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s4 }} figure={figure}>
        {detail}
      </Text>
    </View>
  );
}

/** Each step as it stands: what it did, transaction by transaction, and where the run stopped if it did. */
function Progress({ steps }: { steps: Step[] }) {
  return (
    <>
      {steps.map((step, i) => (
        <SheetCard
          key={step.key}
          borderRadius={radius.note}
          padding={space.s14}
          style={{ marginTop: i === 0 ? 0 : space.s10 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s10 }}>
            <Text variant="rowPrimary">
              {i + 1}. {step.title}
            </Text>
            <Tag label={STATUS[step.status].label} small tone={STATUS[step.status].tone} />
          </View>
          {step.lines.map((line, j) => (
            <View key={`${step.key}-${j}`} style={{ marginTop: space.s8 }}>
              {/*
                A finished line says what moved — "Sold 0.5000 WETH for $1,200.00" — which hides while balances are
                hidden. A line left or failed is the reason, drawn as it came.
              */}
              <Text
                variant="secondarySm"
                color={line.tone === 'failed' ? colors.down : line.tone === 'left' ? colors.ink45 : colors.ink}
                figure={line.tone === 'done' ? 'units' : undefined}
              >
                {line.text}
              </Text>
              {line.txHash ? (
                <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s2 }} selectable>
                  {line.txHash}
                </Text>
              ) : null}
            </View>
          ))}
          {step.detail ? (
            <Text
              variant="secondarySm"
              color={step.status === 'failed' ? colors.down : colors.ink45}
              style={{ marginTop: space.s8 }}
            >
              {step.detail}
            </Text>
          ) : null}
        </SheetCard>
      ))}
    </>
  );
}
