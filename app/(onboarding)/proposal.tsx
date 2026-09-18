/**
 * Screen 10 — Portfolio proposal. screens.md Group A.
 *
 * Centred 56pt strategist orb, title, subtitle. Card containing: an 8pt stacked proportion
 * bar (three segments, 2pt gaps, widths = normalised weights), three sleeve blocks (dot +
 * name + stepper, then an indented rationale), an "Allocated" total row, then the CTA.
 *
 * weights default 55/30/15, ±5 per tap. Total must equal 100 to go on — the CTA reads
 * "Balance to 100% first" (disabled) until it does. Total colour `up` at 100, `warn` otherwise.
 *
 * After the pivot, going on creates a real tier-2 rebalance strategy — and that is all it does, so
 * the button says so. It read "Approve & fund" and funded nothing: a rebalance moves what the wallet
 * already holds. The "Portfolio approved" that followed was a flag kept on the phone, shown on every
 * later visit whether or not the strategy still existed; what this screen says about a portfolio
 * already set now comes from the executor's own list of strategies.
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { agentGradients } from '@/design/gradients';
import {
  AgentOrb,
  Button,
  Fill,
  Price,
  Screen,
  SheetCard,
  Stepper,
  Text,
  colors,
  duration,
  radius,
  size,
  space,
  timing,
  useReducedMotion,
  type AgentStage,
} from '@/ui';
import { canApprove, proposalRebalance, sleeveHeldAsCash, weightBarPct, weightTotal } from '@/state/derived';
import { sleeveFixtures } from '@/data/fixtures/sleeves';
import { useStore } from '@/state/store';
import { repos } from '@/data';
import { system } from '@/data/system';
import { useAsync } from '@/data/useAsync';
import { errorText } from '@/data/apiError';

const BAR_H = 8;

/** The weights a stored rebalance was created with, when its params still carry them in this screen's shape. */
function storedWeights(params: Record<string, unknown> | undefined): number[] | undefined {
  const w = params?.weights;
  return Array.isArray(w) &&
    w.length === sleeveFixtures.length &&
    w.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? (w as number[])
    : undefined;
}

export default function Proposal() {
  const router = useRouter();
  const draft = useStore((s) => s.weights);
  const bumpWeight = useStore((s) => s.bumpWeight);
  const cap = useStore((s) => s.cap);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /*
   * Whether trades settle on this network at all — asked before starting, so the user knows what starting does
   * (PLAN.md 3.7). Undefined until the executor answers.
   */
  const [settles, setSettles] = useState<boolean>();
  /* What settles here, by symbol: a sleeve that names none of it is held as cash, and its line says so. */
  const [tradable, setTradable] = useState<string[]>();
  useEffect(() => {
    let live = true;
    system
      .tradable()
      .then((rows) => {
        if (!live) return;
        setSettles(rows.length > 0);
        setTradable(rows.map((t) => t.symbol));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  /*
   * A rebalance this wallet already runs, asked of the executor.
   *
   * So a second visit neither creates a duplicate — nothing on the server refuses one — nor claims an
   * approval from a flag on the phone. It shows the weights that portfolio was set with, and the way
   * on. A read that fails leaves the choice with the person, as the screen did before it asked.
   */
  const strategies = useAsync(() => repos.strategies.list(), []);
  const existing = (strategies.data ?? []).find(
    (s) => s.kind === 'rebalance' && (s.state === 'live' || s.state === 'watch'),
  );
  const weights = (existing && storedWeights(existing.params)) ?? draft;

  const total = weightTotal(weights);
  const ok = canApprove(weights);

  /*
   * What the Strategist is doing, for its orb (`AgentOrb`'s `stage`). Every one of these is a fact this
   * screen already holds and already says in words — the subtitle, the total, the CTA — so the orb adds
   * a second reading of the same thing rather than the only one. Nothing here is a timer.
   */
  const stage: AgentStage = busy
    ? // The strategy is being written to the executor.
      'executing'
    : existing
      ? // A rebalance already runs for this wallet: the work this screen exists for is done.
        'filled'
      : strategies.loading || tradable === undefined
        ? // Still asking what this network settles and what the wallet already runs.
          'thinking'
        : // The draft is on screen and the decision is yours.
          'decided';

  async function start() {
    if (!ok || existing) return;
    setBusy(true);
    setError(undefined);
    try {
      /*
       * The weights as a rebalance can hold them (PLAN.md 2.17). This sent `weights` and sleeve names, which
       * the rebalance planner does not read — it needs `targets` keyed by tradable symbols — and the executor
       * refused the strategy outright, so approving the one portfolio a new user builds created nothing. What
       * this network can settle decides where each sleeve's weight goes; the rest stays cash.
       */
      const tradable = (await system.tradable()).map((t) => t.symbol);
      /*
       * Where nothing settles — Base Sepolia, where 1inch has no deployment — the tradable list is empty (PLAN.md
       * 3.7) and approving refused with "nothing to rebalance", so a new user could not finish. There the
       * portfolio is created watched, over what the chain can price and read: it reports what it would trade,
       * moves nothing, and the screen says so.
       */
      const watchable = tradable.length > 0 ? [] : (await system.watchable()).map((t) => t.symbol);
      const { state, targets, cashPct } = proposalRebalance(
        sleeveFixtures.map((s, i) => ({ name: s.name, weight: weights[i] ?? 0 })),
        tradable,
        watchable,
      );
      if (Object.keys(targets).length === 0) {
        throw new Error('Nothing here can be traded or followed on this network.');
      }
      setSettles(state === 'live');
      await repos.strategies.create({
        kind: 'rebalance',
        state,
        label: 'Rebalance to targets',
        symbol: 'PORTFOLIO',
        params: { targets, cashPct, weights, sleeves: sleeveFixtures.map((s) => s.name) },
        cadence: 'weekly',
        dailyAllocationUsd: Math.round(cap / 4),
      });
      // It exists on the executor now, which is the only record of it that matters. Home shows what runs.
      router.replace('/(tabs)');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  /* What the button does, said as that: a weekly rebalance, or a watched one where nothing settles. */
  const label = !ok ? 'Balance to 100% first' : settles === false ? 'Start watching' : 'Start rebalancing';

  return (
    <Screen>
      <View style={{ alignItems: 'center', gap: space.s14 }}>
        <AgentOrb
          gradient={agentGradients.Strategist}
          identity="Strategist"
          size={size.orb56}
          face
          specular
          bloom
          stage={stage}
        />
        <Text variant="onboardingTitle" align="center">
          Your draft portfolio
        </Text>
        <Text variant="body" color={colors.ink55} align="center">
          Adjust the weights. Nothing trades until you start.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s26 }}>
        <SheetCard borderRadius={radius.panel} padding={space.s18}>
          <View style={{ flexDirection: 'row', gap: space.s2, height: BAR_H }}>
            {sleeveFixtures.map((s, i) => (
              <Bar key={s.name} pct={weightBarPct(weights, i)} color={s.color} />
            ))}
          </View>

          <View style={{ marginTop: space.s20, gap: space.s20 }}>
            {sleeveFixtures.map((s, i) => (
              <View key={s.name} style={{ gap: space.s8 }}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.s10,
                    justifyContent: 'space-between',
                  }}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.s10,
                      flex: 1,
                    }}
                  >
                    <View
                      style={{
                        width: BAR_H,
                        height: BAR_H,
                        borderRadius: BAR_H / 2,
                        backgroundColor: s.color,
                      }}
                    />
                    <Text variant="rowPrimary" style={{ flex: 1 }}>
                      {s.name}
                    </Text>
                  </View>
                  {/* A portfolio already set is shown as it runs; editing a draft here would change nothing there. */}
                  <Stepper
                    value={`${weights[i] ?? 0}%`}
                    onDecrement={() => bumpWeight(i, -1)}
                    onIncrement={() => bumpWeight(i, 1)}
                    canDecrement={!existing && (weights[i] ?? 0) > 0}
                    canIncrement={!existing && (weights[i] ?? 0) < 100}
                    valueMinWidth={size.stepperValueMinWSm}
                  />
                </View>
                {/* Indented to the dot's text column, so the rationale reads as belonging to
                    the sleeve above it rather than to the card. A sleeve nothing here can settle, like the
                    equities on a fork or on Base Sepolia, is held as cash and says that instead. */}
                <Text variant="secondarySm" color={colors.ink55} style={{ paddingLeft: space.s18 }}>
                  {sleeveHeldAsCash(s.name, tradable) ? 'Held as cash on this network.' : s.note}
                </Text>
              </View>
            ))}
          </View>

          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: space.s22,
            }}
          >
            <Text variant="rowPrimary">Allocated</Text>
            {/* Ink when it adds up: green is for profit and loss, and a total of 100% is neither (G3). */}
            <Price variant="value" color={ok ? colors.ink : colors.warn}>
              {total}%
            </Price>
          </View>
        </SheetCard>

        {error ? (
          <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s14 }}>
            {error}
          </Text>
        ) : null}
        {existing ? (
          <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s14 }}>
            {existing.state === 'watch' ? 'This portfolio is already being watched.' : 'This portfolio is already rebalancing.'}
          </Text>
        ) : settles === false ? (
          <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s14 }}>
            Watch-only here: it shows what it would trade.
          </Text>
        ) : null}
      </Fill>

      {existing ? (
        <Button label="Continue" onPress={() => router.replace('/(tabs)')} />
      ) : (
        <Button label={label} disabled={!ok} loading={busy} onPress={start} />
      )}
    </Screen>
  );
}

/**
 * One segment of the proportion bar.
 *
 * The width is seeded at the current weight and advanced from a `useEffect`. Returning
 * `withTiming` out of `useAnimatedStyle` — as this did — starts every segment at 0 and grows
 * it on mount, which is an entrance animation, and animations.md §5 has none.
 *
 * animations.md's inventory lists 200ms here, contradicting its own "150 / 180 / 250 and
 * nothing else" rule. The rule wins; `duration.base` is 180.
 */
function Bar({ pct, color }: { pct: number; color: string }) {
  const reduced = useReducedMotion();
  const width = useSharedValue(pct);

  useEffect(() => {
    width.value = withTiming(pct, timing(duration.base, reduced));
  }, [pct, reduced, width]);

  const style = useAnimatedStyle(() => ({ width: `${width.value}%` }));

  return (
    <Animated.View
      style={[{ height: BAR_H, borderRadius: BAR_H / 2, backgroundColor: color }, style]}
    />
  );
}
