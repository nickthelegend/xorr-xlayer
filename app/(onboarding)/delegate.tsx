/**
 * NEW — Grant delegation. PLAN.md 7.5, closing [G45].
 *
 * The single most consequential screen in the app, and it does not exist in the handoff:
 * this is where a user hands a bot authority over real money.
 *
 * Built from screen 20's consequence-card pattern — that layout already reads correctly for
 * "here is exactly what will and will not happen", which is the whole job here.
 *
 * Voice per copy.md: name the consequence, not the feature. Second person, present tense.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as LocalAuthentication from 'expo-local-authentication';
import {
  BackButton,
  Button,
  ConsequenceCard,
  Fill,
  NoteStrip,
  Pill,
  Screen,
  SheetCard,
  Stepper,
  Text,
  colors,
  money,
  radius,
  size,
  space,
  SignInButton,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { useGoBack } from '@/nav/useGoBack';
import { useAsync } from '@/data/useAsync';
import { api } from '@/data/api';
import { useGrantDelegation } from '@/auth/useGrantDelegation';
import { CAP_MAX, CAP_MIN, RUN_FOR, capLabel, runForMs } from '@/state/derived';
import { useStore } from '@/state/store';
import { readDelegationIntoStore } from '@/wallet/readDelegation';
import { errorText } from '@/data/apiError';


export default function GrantDelegation() {
  const router = useRouter();
  const goBack = useGoBack();
  /** Onboarding's Fund step asks for its next step; Home's setup card and Safety ask for nothing, and are gone back to. */
  const { then } = useLocalSearchParams<{ then?: string }>();
  const signedOut = useSignedOut();
  const cap = useStore((s) => s.cap);
  const bumpCap = useStore((s) => s.bumpCap);
  const runFor = useStore((s) => s.runFor);
  const cycleRunFor = useStore((s) => s.cycleRunFor);
  const [localError, setLocalError] = useState<string>();
  // The grant is signed by the USER's own wallet. The executor cannot grant itself
  // permission — that is the whole point of the delegation being on-chain.
  const { grant: signGrant, busy, error: grantError } = useGrantDelegation();
  /*
   * How many signatures this is actually going to ask for.
   *
   * The grant is one transaction, and it is preceded by an ERC-20 approval for every token the
   * delegation may need to pull — which on a chain where the tokenized equities exist is eleven.
   * Eleven wallet prompts with no warning reads as the app having broken, and a user who stops
   * half way has approvals but no permission. Saying the number first costs one sentence.
   *
   * Counted the way the grant counts them (`useGrantDelegation`): one approval per token the
   * executor names, or USDC alone when it names none, then the grant. And a count that could not be
   * read does not take the warning with it — a failed read is no evidence of a single signature — so
   * the sentence then states the rule instead of the number.
   */
  const params = useAsync(
    () => api.get<{ tokens?: { symbol: string }[] }>('/delegation/params'),
    [],
  );
  const signatures = params.data ? Math.max(params.data.tokens?.length ?? 0, 1) + 1 : undefined;
  const error = localError ?? grantError;

  async function grant() {
    setLocalError(undefined);
    try {
      const hasHw = await LocalAuthentication.hasHardwareAsync().catch(() => false);
      if (hasHw && (await LocalAuthentication.isEnrolledAsync().catch(() => false))) {
        const res = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Let the bot trade inside your limits',
        });
        if (!res.success) {
          setLocalError('Not confirmed. Nothing was granted.');
          return;
        }
      }
      await signGrant(cap, runForMs(runFor));
      // Read it back from the chain rather than trusting what we just sent, and file it against
      // the address it was read for (`wallet/readDelegation.ts`).
      await readDelegationIntoStore();
      /*
       * Onboarding goes on to the draft portfolio; everywhere else goes back to where the permission was asked for
       * (2026-09-26). This always replaced with /proposal, so a permission signed from Home's setup card or from Safety
       * landed on onboarding's portfolio screen, whose only way on was to start a rebalance nobody had asked for.
       */
      if (then === 'proposal') router.replace('/proposal');
      else goBack();
    } catch (e) {
      setLocalError(errorText(e));
    }
  }

  return (
    <Screen>
      {/*
        A way back. This was the one onboarding step without one — and it is also reached from Safety, where the only
        other exit was "Not yet", which replaces the whole stack with Home.
      */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
        <BackButton onPress={() => goBack()} />
        <Text variant="screenTitle">Let the bot trade</Text>
      </View>
      <Text variant="body" color={colors.ink55} style={{ marginTop: space.s10 }}>
        What it can and can’t do.
      </Text>

      {/*
        Scrolls, because the two things this screen exists to say were below the fold.

        Measured on a 375×667 viewport — an iPhone SE, which is the shortest device the design
        supports — the content runs to 865pt with `body` at `overflow: hidden`. Unreachable: the
        risk warning ("a bot with permission to trade can lose money inside these limits") and the
        sentence telling the user how many signatures their wallet is about to ask for — one per tradable token
        and then the grant, which is seventeen on X Layer today and is counted, never hard-coded.

        Both are on the screen where someone decides whether to give a bot access to their money,
        and a consent screen whose warning cannot be read is not consent.
      */}
      <Fill style={{ marginTop: space.s22 }}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.s16 }}>
        <View style={{ gap: space.s10 }}>
          <ConsequenceCard
            tone="up"
            label="It can place trades"
            detail={`Up to ${capLabel(cap)}.`}
          />
          <ConsequenceCard
            tone="down"
            label="It cannot move your money out"
            detail="No transfers or withdrawals, ever."
          />
          <ConsequenceCard
            tone="up"
            label="It expires on its own"
            detail={`After ${RUN_FOR[runFor]!.toLowerCase()}.`}
          />
          <ConsequenceCard
            tone="up"
            label="You can take it back in one tap"
            detail="From Safety, anytime."
          />
        </View>

        <SheetCard borderRadius={radius.panel} padding={space.s16} style={{ marginTop: space.s18 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: space.s12,
            }}
          >
            <Text variant="rowPrimary">Most it can spend a day</Text>
            <Stepper
              value={money(cap, { decimals: 0 })}
              onDecrement={() => bumpCap(-1)}
              onIncrement={() => bumpCap(1)}
              canDecrement={cap > CAP_MIN}
              canIncrement={cap < CAP_MAX}
              valueMinWidth={size.stepperValueMinW}
            />
          </View>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: space.s18,
              gap: space.s12,
            }}
          >
            <Text variant="rowPrimary">For how long</Text>
            <Pill label={RUN_FOR[runFor]!} selected onPress={cycleRunFor} />
          </View>
        </SheetCard>

        <NoteStrip kind="risk" style={{ marginTop: space.s16 }}>
          Trading can lose money within these limits.
        </NoteStrip>

        {/*
          The grant is the one signature this whole product depends on, so if the build cannot
          take it the screen says so before asking — rather than letting Privy answer with a
          revert about a balance on a chain the user is not looking at. See src/chain.ts.
        */}
        {signatures !== undefined ? (
          signatures > 2 ? (
            <NoteStrip kind="risk" style={{ marginTop: space.s10 }}>
              You’ll sign {signatures} times. Nothing is granted until the last.
            </NoteStrip>
          ) : null
        ) : params.error ? (
          <NoteStrip kind="risk" style={{ marginTop: space.s10 }}>
            You’ll sign once per token, then once more. Nothing is granted until the last.
          </NoteStrip>
        ) : null}

        {error ? (
          <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s14 }}>
            {error}
          </Text>
        ) : null}
        </ScrollView>
      </Fill>

      {signedOut ? (
        <SignInButton label="Sign in first" />
      ) : (
        <Button
          label="Sign this permission"
          loading={busy}
          onPress={grant}
        />
      )}
      <Button
        label="Not yet — look around first"
        variant="ghost"
        style={{ marginTop: space.s10 }}
        onPress={() => router.replace('/(tabs)')}
      />
    </Screen>
  );
}

