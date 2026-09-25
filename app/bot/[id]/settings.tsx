/**
 * Screen 4 — Trade settings. screens.md Group C.
 *
 * Card: 34pt violet orb, "Limits". Two 56pt rows —
 *   Run For (pill, cycles 1/3/7/30 Days)
 *   Daily Spend Cap (stepper $200–$5,000 by $200)
 * Under the cap: a 6pt green→amber→red rail with a white marker at (cap−200)/4800,
 * endpoints "$200 · conservative" / "$5,000 · max".
 *
 * PLAN.md 6.7: after the pivot these controls are NOT preferences — they are the delegation
 * policy. The CTA signs a transaction, it does not save a setting.
 *
 * The design had two more rows, and both are gone because nothing stood behind them:
 *
 *   Trade Autonomously — a switch captioned "Every trade waits for your approval" when off. It lived in
 *   local storage and `commit()` never read it, and nothing else could have: the permission has no such
 *   field, and `PATCH /agents/:id` takes a tone and two dollar limits. Asking first belongs to the
 *   strategy kind — tiers 6 and 7 always ask (`APPROVAL_FIRST_KINDS` in server/src/executor/run.ts) —
 *   not to a switch.
 *
 *   Risk Level — Low / Medium / High, also local and never signed. The nearest real thing is an agent's
 *   own dollar limits, and those bind only strategies attached to that agent. Nothing in the app
 *   attaches one, so a level written there would still have changed no trade.
 */
import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { agentGradients } from '@/design/gradients';
import {
  AssetMark,
  Button,
  Fill,
  Pill,
  Row,
  Screen,
  SheetCard,
  SignInButton,
  Stepper,
  Text,
  colors,
  duration,
  money,
  radius,
  size,
  space,
  timing,
  useReducedMotion,
} from '@/ui';
import { useGrantDelegation } from '@/auth/useGrantDelegation';
import { useSignedOut } from '@/auth/useSignedOut';
import { CAP_MAX, CAP_MIN, RUN_FOR, capLabel, capMarkerPct, runForMs } from '@/state/derived';
import { useStore } from '@/state/store';
import { readDelegationIntoStore } from '@/wallet/readDelegation';
import { errorText } from '@/data/apiError';

const RAIL_H = 6;
const MARKER_W = 3;
const MARKER_H = 10;

export default function TradeSettings() {
  const goBack = useGoBack();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const reduced = useReducedMotion();
  const signedOut = useSignedOut();
  const [localError, setLocalError] = useState<string>();
  // These controls ARE the delegation policy, so saving them is a signature, not a
  // save — and it is the user's wallet that signs it, never the executor.
  const { grant: signGrant, busy, error: txError } = useGrantDelegation();
  const error = localError ?? txError;

  const runFor = useStore((s) => s.runFor);
  const cycleRunFor = useStore((s) => s.cycleRunFor);
  const cap = useStore((s) => s.cap);
  const bumpCap = useStore((s) => s.bumpCap);

  const target = capMarkerPct(cap);
  const pct = useSharedValue(target);
  useEffect(() => {
    pct.value = withTiming(target, timing(duration.base, reduced));
  }, [target, reduced, pct]);
  const marker = useAnimatedStyle(() => ({ left: `${pct.value}%` }));

  async function commit() {
    setLocalError(undefined);
    try {
      await signGrant(cap, runForMs(runFor));
      // Read it back from the chain rather than trusting what we just sent, and file it against
      // the address it was read for (`wallet/readDelegation.ts`).
      await readDelegationIntoStore();
      goBack();
    } catch (e) {
      setLocalError(errorText(e));
    }
  }

  return (
    <Screen>
      <Text variant="screenTitle">Trade Settings</Text>
      <Text variant="secondary" style={{ marginTop: space.s10 }}>
        {/*
          "The agent" read as the one you just tapped Get Started on, because this screen is
          reached at /bot/:id/settings. It is not. `commit()` calls `signGrant(cap, runFor)` with
          no agent in it, and `repos.wallet.delegation()` reads one policy back — there is a single
          on-chain permission per wallet, and every agent runs inside it. Someone who set a $200
          cap here believing it applied to Earnings Desk alone would have set it for all four.
        */}
        One permission for the whole wallet, not just this agent. Inside it, each agent spends from a budget of its own.
      </Text>

      {/*
        Scrolls. A limits screen is exactly the surface that grows — another control, another
        explanation — and the failure mode is a user unable to reach the cap they came to change.
      */}
      <Fill style={{ marginTop: space.s20 }}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 16 }}>
        <SheetCard borderRadius={radius.panel} padding={space.s16}>
          {/* No chevron. This header is not pressable, and a chevron promises somewhere to go. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s12 }}>
            <AssetMark gradient={agentGradients.Strategist} size={size.mark} />
            <Text variant="cardTitle" style={{ flex: 1 }}>
              Limits
            </Text>
          </View>

          <Row
            title="Run For"
            right={<Pill label={RUN_FOR[runFor]!} selected onPress={cycleRunFor} />}
            height={size.row}
          />

          <Row
            title="Daily Spend Cap"
            divider={false}
            height={size.row}
            right={
              <Stepper
                value={capLabel(cap)}
                onDecrement={() => bumpCap(-1)}
                onIncrement={() => bumpCap(1)}
                canDecrement={cap > CAP_MIN}
                canIncrement={cap < CAP_MAX}
                valueMinWidth={size.stepperValueMinW}
              />
            }
          />

          <View style={{ marginTop: space.s14 }}>
            <View style={{ height: RAIL_H, borderRadius: radius.full, overflow: 'hidden' }}>
              <LinearGradient
                colors={[colors.up, colors.warn, colors.down]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={{ height: RAIL_H }}
              />
              <Animated.View
                style={[
                  {
                    position: 'absolute',
                    top: -2,
                    width: MARKER_W,
                    height: MARKER_H,
                    borderRadius: MARKER_W / 2,
                    backgroundColor: colors.ink,
                  },
                  marker,
                ]}
              />
            </View>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                marginTop: space.s8,
              }}
            >
              <Text variant="footnoteSm" color={colors.ink55}>
                {money(CAP_MIN, { decimals: 0 })} · conservative
              </Text>
              <Text variant="footnoteSm" color={colors.ink55}>
                {money(CAP_MAX, { decimals: 0 })} · max
              </Text>
            </View>
          </View>
        </SheetCard>

        {/*
          The agent's own budget (2026-09-25) is on its page: the cap here bounds the wallet, and an agent with no budget
          of its own does not trade at all, so the way to it sits right under the cap.
        */}
        {id ? (
          <View style={{ marginTop: space.s14 }}>
            <Button label="Set this agent’s budget" variant="ghost" onPress={() => router.push(`/agent/${id}`)} />
          </View>
        ) : null}

        {error ? (
          <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s14 }}>
            {error}
          </Text>
        ) : null}
        </ScrollView>
      </Fill>

      {/* Signed out, the one step that is possible sits where the signature would. */}
      {signedOut ? (
        <SignInButton label="Sign in to set limits" />
      ) : (
        <Button label="Sign these limits" loading={busy} onPress={commit} />
      )}
      <Text
        variant="footnote"
        color={colors.ink55}
        align="center"
        style={{ marginTop: space.s12 }}
      >
        Signed by you. Revoke anytime in Safety.
      </Text>
    </Screen>
  );
}
