/**
 * Strategies — its own page (2026-09-12). PLAN.md 10.1 / §3.5.
 *
 * Reached from every agent's page ("See all") and from a strategy alert — not from the bar. It used
 * to live in the tab shell, which drew the bottom bar under it with nothing lit and no way back but
 * the bar; it now pushes like an agent page, with a back arrow and no bar.
 *
 * Live strategies with state, next run and capital committed; a library to add from, ordered by
 * the §1.2 ladder — DCA first, because it is the trust on-ramp.
 *
 * Built from Row / Segmented / SheetCard on `src/ui`. No new visual language.
 */
import React, { useCallback, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  BackButton,
  Button,
  EmptyList,
  ErrorState,
  Fill,
  LoadingRows,
  Placeholder,
  Press,
  Price,
  Row,
  Screen,
  Segmented,
  SheetCard,
  Text,
  colors,
  money,
  radius,
  size,
  space,
} from '@/ui';
import { quantity } from '@/format';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { errorText } from '@/data/apiError';
import {
  KILL_SWITCH_LINK,
  KILL_SWITCH_ROUTE,
  PAUSE_IS_NOT_THE_KILL_SWITCH,
  stateBadge,
} from '@/strategies/pauseCopy';
import { useGoBack } from '@/nav/useGoBack';
import { useRefreshControl } from '@/ui/useRefreshControl';
import { STRATEGY_LADDER, labelFigure } from '@/strategies/ladder';
import type { Strategy } from '@/data/types';

type Tab = 'running' | 'library';

const TABS = [
  { value: 'running', label: 'Running' },
  { value: 'library', label: 'Add new' },
] as const satisfies readonly { value: Tab; label: string }[];

/** The tier badge on a library card. 22pt circle, per §5's small-marker recipe. */
const TIER = 22;

export default function Strategies() {
  const router = useRouter();
  const goBack = useGoBack();
  const [tab, setTab] = useState<Tab>('running');
  const { data, loading, error, reload } = useAsync(() => repos.strategies.list(), []);
  // Pulling down is the gesture people already try on a list of things that keep changing.
  const refresh = useRefreshControl(reload);
  /*
   * Back from setting one up, the list is read again. A recurring buy created on an Android 15 emulator was missing from
   * it until the screen was opened afresh (2026-09-15): the setup closes back over this screen, which is not mounted
   * again, so it went on showing the list from before. Not on the first focus, which is the mount and has its own read.
   */
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      reload();
    }, [reload]),
  );

  const all = data ?? [];
  const live = all.filter((s) => s.state === 'live' || s.state === 'watch');
  /*
   * Paused strategies stay on this list.
   *
   * Filtering to live-only meant pausing one made it disappear, taking its Resume button
   * with it — a one-way door out of a state the user chose. The header count still says how
   * many are RUNNING, which is the number that matters; the list says what exists.
   */
  const paused = all.filter((s) => s.state === 'paused');
  const shown = [...live, ...paused];

  return (
    <Screen>
      <View style={{ flexDirection: 'row' }}>
        <BackButton onPress={goBack} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="screenTitle">Strategies</Text>
        {/*
          "0 running" is a claim. Without an answer from the executor we do not have one to make —
          the body below already shows why.

          Nor is a dash while it is still asking: a "—" where the count goes read as a value. Loading is
          a placeholder, and a read that failed leaves the space empty for the error below to explain.
        */}
        {data ? (
          <Text variant="footnote" color={colors.ink55}>
            {`${live.length} running`}
          </Text>
        ) : loading ? (
          <Placeholder height={12} width={64} />
        ) : null}
      </View>

      <Text variant="secondary" style={{ marginTop: space.s10 }}>
        What runs for you, and what you can add.
      </Text>

      <Segmented options={TABS} value={tab} onChange={setTab} style={{ marginTop: space.s18 }} />

      <Fill style={{ marginTop: space.s8 }}>
        <ScrollView refreshControl={refresh.control} showsVerticalScrollIndicator={false}>
          {/* A pull that failed says so, over the rows it could not replace. A success says nothing. */}
          {refresh.notice}
          {tab === 'running' ? (
            loading && !data ? (
              <LoadingRows count={3} />
            ) : error ? (
              <ErrorState error={error} onRetry={reload} />
            ) : shown.length === 0 ? (
              <View style={{ gap: space.s16, paddingTop: space.s10 }}>
                <EmptyList list="strategies" />
                <Text variant="secondarySm" align="center">
                  A recurring buy is the simplest place to start.
                </Text>
                <Button label="Set up a recurring buy" onPress={() => router.push('/strategy/dca')} />
              </View>
            ) : (
              <>
                {shown.map((s) => (
                  <StrategyRow key={s.id} s={s} onChanged={reload} />
                ))}
                <PauseIsNotTheKillSwitch onOpenSafety={() => router.push(KILL_SWITCH_ROUTE as never)} />
              </>
            )
          ) : (
            <View style={{ gap: space.s12, paddingTop: space.s6 }}>
              {STRATEGY_LADDER.map((entry) => (
                <SheetCard key={entry.kind} borderRadius={radius.panel} padding={space.s16}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10 }}>
                    <View
                      style={{
                        width: TIER,
                        height: TIER,
                        borderRadius: radius.full,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: colors.surfaceAlt,
                      }}
                    >
                      {/* A tier number, so no uppercase tracking — it would push the digit
                          off centre in a circle this small. */}
                      <Text variant="tagSm" color={colors.ink55} style={{ letterSpacing: 0 }}>
                        {entry.tier}
                      </Text>
                    </View>
                    <Text variant="cardTitle" style={{ flex: 1 }}>
                      {entry.label}
                    </Text>
                    {entry.available ? null : (
                      <Text variant="footnote" color={colors.ink55}>
                        Later
                      </Text>
                    )}
                  </View>
                  {/* One line a card. Why each rung sits where it does lives beside it in the ladder. */}
                  <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s10 }}>
                    {entry.what}
                  </Text>
                  {entry.available ? (
                    <Button
                      label={entry.cta}
                      variant="secondary"
                      height={size.ghostSm}
                      style={{ marginTop: space.s14 }}
                      onPress={() => router.push(entry.route as never)}
                    />
                  ) : null}
                </SheetCard>
              ))}
            </View>
          )}
        </ScrollView>
      </Fill>
    </Screen>
  );
}

/**
 * A running strategy, with the two things a user needs to be able to do to it.
 *
 * There was no way to stop one: a user could add strategies until they hit the daily cap and
 * then had no route out, which made the cap — working exactly as designed — read as the app
 * being broken. "Run now" exists because a weekly cadence is the point of the product and
 * useless for seeing that it works.
 */
function StrategyRow({ s, onChanged }: { s: Strategy; onChanged: () => void }) {
  const [busy, setBusy] = useState<'run' | 'pause' | undefined>();
  const [note, setNote] = useState<string>();
  const isPaused = s.state === 'paused';

  const next = s.nextRunAt
    ? new Date(s.nextRunAt).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
    : '—';

  async function act(kind: 'run' | 'pause') {
    setBusy(kind);
    setNote(undefined);
    try {
      if (kind === 'pause') {
        /*
         * `resume()`, not `setState(id, 'live')`.
         *
         * A resume is "undo the pause", and the state to undo INTO is the one the pause was taken
         * out of — which the executor stored on the row (`paused_from`). Naming `live` from here
         * put a watching strategy, whose whole purpose is to move nothing, back able to spend.
         * The client does not get to answer that question any more.
         */
        if (isPaused) await repos.strategies.resume(s.id);
        else await repos.strategies.pause(s.id);
      } else {
        const r = await repos.strategies.runNow(s.id);
        /*
         * Say what happened. "Nothing to do" is a real and common outcome for a rebalance that has
         * not drifted, and it must not read as a failure.
         *
         * Nor may two other outcomes read as it. Tiers 6 and 7 ask before an entry, so a skip can be
         * a run waiting on a yes. And a fill the executor did not measure says "Filled." rather than
         * "Filled 0.0000 at $0.00".
         */
        const skipped =
          r.reason === 'already_ran_this_period'
            ? 'Already ran this period.'
            : r.reason === 'awaiting_approval'
              ? 'Waiting for your approval.'
              : 'Checked — nothing to do.';
        setNote(
          r.status === 'filled'
            ? r.units != null && r.price != null
              ? `Filled ${quantity(r.units)} at ${money(r.price)}`
              : 'Filled.'
            : r.status === 'skipped'
              ? skipped
              : // The executor's sentence before its identifier: "agent_trade_limit" is not something to show a person.
                (r.detail ?? r.reason ?? r.status),
        );
      }
      onChanged();
    } catch (e) {
      /*
       * The server's sentence, not the wire.
       *
       * This was `e.message.slice(0, 90)`, and `ApiError.message` is the raw response — so
       * pressing Run now on a chain no venue can fill printed this under the row:
       *
       *   502 : {"status":"failed","runId":"040c4097-84a3-41bc-a203-3dd30a20d523","error":"This netw
       *
       * A status code, a JSON brace, an internal run id, and the one useful part cut off
       * mid-word by the slice. The executor had written a perfectly good sentence; `errorText`
       * is what gets it out, the same accessor `ErrorState` uses everywhere else.
       */
      setNote(errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <View>
      <Row
        title={s.label}
        titleFigure={labelFigure(s.kind)}
        secondary={`${s.state === 'watch' ? 'Watching · ' : ''}Next run ${next}`}
        value={<Price>{money(s.dailyAllocationUsd, { decimals: 0 })}</Price>}
        // A paused row says what a resume will make it, since that is not always what it was.
        delta={stateBadge(s.state, s.pausedFrom)}
        // `Watch` and `Paused` are not losses — the P&L colours are reserved.
        deltaTone={!isPaused && s.state === 'live' ? 'up' : 'neutral'}
        height={size.rowLg}
      />
      <View
        style={{
          flexDirection: 'row',
          gap: space.s8,
          marginTop: -space.s4,
          marginBottom: space.s10,
        }}
      >
        <SmallAction
          label={busy === 'run' ? 'Running…' : 'Run now'}
          disabled={busy !== undefined || isPaused}
          onPress={() => void act('run')}
        />
        <SmallAction
          label={busy === 'pause' ? '…' : isPaused ? 'Resume' : 'Pause'}
          disabled={busy !== undefined}
          onPress={() => void act('pause')}
        />
      </View>
      {note ? (
        <Text
          variant="footnote"
          color={colors.ink55}
          style={{ marginTop: -space.s6, marginBottom: space.s10 }}
        >
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The difference between the three stops, under the rows that offer the smallest one.
 *
 * Someone who paused a strategy and believed they had pulled the kill switch has a wrong model of
 * what their money is exposed to, and would find out at the worst possible time. It sits here
 * rather than in a help page because here is where the Pause button is.
 *
 * Under the list, not above it: it explains a control the reader has just seen, and a warning ahead
 * of the thing it is about reads as a warning about the screen.
 */
function PauseIsNotTheKillSwitch({ onOpenSafety }: { onOpenSafety: () => void }) {
  return (
    <View style={{ marginTop: space.s10, marginBottom: space.s20, gap: space.s6 }}>
      <Text variant="footnote" color={colors.ink55}>
        {PAUSE_IS_NOT_THE_KILL_SWITCH}
      </Text>
      <Press
        onPress={onOpenSafety}
        accessibilityRole="button"
        accessibilityLabel={KILL_SWITCH_LINK}
        hitHeight={size.hit}
        style={{ alignSelf: 'flex-start' }}
      >
        <Text variant="footnote" color={colors.ink}>
          {KILL_SWITCH_LINK} ›
        </Text>
      </Press>
    </View>
  );
}

function SmallAction({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        // The target stays at the 44pt the design mandates even though the pill is shorter.
        minHeight: size.hit,
        justifyContent: 'center',
        paddingHorizontal: space.s14,
        borderRadius: radius.card,
        backgroundColor: colors.control,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text variant="control">{label}</Text>
    </Press>
  );
}
