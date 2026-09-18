/**
 * What runs next, and when.
 *
 * Strategies carry a `nextRunAt` and the app has only ever shown it inside a strategy's own row.
 * The question people actually have is the other way round — "what is about to happen" — and that
 * is a list across every strategy, ordered by time.
 *
 * Overdue is its own state. A strategy whose next run is in the past is either about to fire on the
 * next tick or is not firing at all, and the difference between "in two hours" and "four hours ago"
 * is the difference between waiting and investigating.
 */
import React, { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  EmptyList,
  ErrorState,
  Fill,
  HeaderBar,
  LoadingRows,
  NoteStrip,
  Pill,
  PillWrap,
  Row,
  Screen,
  Text,
  colors,
  size,
  space,
} from '@/ui';
import { api } from '@/data/api';
import { useAsync } from '@/data/useAsync';
import { useNow } from '@/state/useNow';
import { repos } from '@/data';
import { kindLabel, labelFigure } from '@/strategies/ladder';
import { PROFILE_TITLE, type RiskProfile, type RiskSettings } from '@/bot/risk';

/** Relative time, in the coarsest unit that still says something useful. */
function when(at: number, now: number): { label: string; overdue: boolean } {
  const ms = at - now;
  const overdue = ms < 0;
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60_000);
  // Under a minute is "now". It read "in 0m" and "Due 0m ago", a duration of nothing.
  if (mins < 1) return { label: 'now', overdue };
  if (mins < 60) return { label: `${mins}m`, overdue };
  const hours = Math.round(mins / 60);
  if (hours < 48) return { label: `${hours}h`, overdue };
  return { label: `${Math.round(hours / 24)}d`, overdue };
}

type AgentPreview = {
  tickMs: number;
  nextTickAt: number | null;
  lastTickAt: number | null;
  universe: { symbol: string; name: string }[];
  wallet: { agentsStopped: boolean; cooldownUntil: number | null; eligible: boolean };
  risk: { profile: RiskProfile; settings: RiskSettings };
};

/**
 * What the autonomous agent is about to do, ahead of it doing it.
 *
 * The sweep runs inside the scheduler tick and the first anybody heard of it was a push saying a
 * trade had happened. This answers the two questions people have in between: when does it next
 * look, and what does it look at.
 *
 * It does not name a winner. The sweep reads its conditions — a price, a band, the Nasdaq clock, a
 * mint's multiplier — at tick time, so any pick shown here would be wrong the moment one of them
 * moved, on the one panel whose whole job is setting expectations accurately. It shows the
 * universe and the gates that are already decided, and says the rest is read when the tick comes.
 */
function AgentNext({
  preview,
  now,
  onEditRisk,
  onOpenBasket,
}: {
  preview: AgentPreview;
  now: number;
  onEditRisk: () => void;
  onOpenBasket: () => void;
}) {
  const { wallet } = preview;

  /*
   * The countdown, and the point at which this stops being one.
   *
   * Three states, because there are three things that can be true. `nextTickAt` is null when the
   * executor has not ticked since it started — real after a restart, and said rather than smoothed
   * into a plausible-looking time.
   *
   * The third case matters more than it looks. This panel is read once, and the loop keeps going:
   * within a minute the reading is several ticks old and a countdown drawn from it would be
   * arithmetic on a stale number. Past its own deadline it stops counting and states the cadence
   * instead, which is the part still known to be true.
   */
  const everySeconds = Math.round(preview.tickMs / 1000);
  const dueIn = preview.nextTickAt === null ? null : preview.nextTickAt - now;
  const dueText =
    dueIn === null
      ? 'Not yet — the executor has not run a sweep since it started.'
      : dueIn <= 0
        ? `Every ${everySeconds} seconds.`
        : dueIn < 60_000
          ? `In under a minute, then every ${everySeconds} seconds.`
          : `In about ${Math.round(dueIn / 60_000)} minutes.`;

  const holdText = wallet.agentsStopped
    ? 'The kill switch is on, so this wallet is skipped entirely.'
    : wallet.cooldownUntil !== null
      ? `This wallet traded recently, so it is held until ${new Date(wallet.cooldownUntil).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}.`
      : null;

  return (
    <View style={{ gap: space.s10 }}>
      <Text variant="cardTitle">The agent</Text>

      <Row title="Next sweep" value={dueText} height={size.rowLg} />

      {/*
        The profile, where the behaviour it governs is being described.

        Settings screens are where a control like this usually goes and where nobody finds it. It
        belongs next to the sentence about what the agent is about to do, because that sentence is
        the thing it changes.
      */}
      <Row
        title="Basket"
        value="Targets and drift"
        secondary="What the agent holds to, and how far it has moved"
        onPress={onOpenBasket}
        height={size.rowLg}
      />

      <Row
        title="Risk profile"
        value={PROFILE_TITLE[preview.risk.profile]}
        secondary={`Entries up to $${preview.risk.settings.maxTradeUsd}, ${preview.risk.settings.cooldownMinutes} minutes apart`}
        onPress={onEditRisk}
        height={size.rowLg}
      />

      {/*
        Not shown as a failure. A held wallet is the cooldown and the kill switch working, and the
        panel says which of the two it is rather than leaving someone to guess why nothing happened.
      */}
      {holdText ? (
        <NoteStrip kind={wallet.agentsStopped ? 'blocked' : 'risk'}>{holdText}</NoteStrip>
      ) : null}

      <Text variant="secondarySm" color={colors.ink55}>
        {wallet.eligible
          ? 'It looks at each of these, then takes at most one of them:'
          : 'When it resumes, it looks at each of these:'}
      </Text>

      <PillWrap>
        {preview.universe.map((u) => (
          <Pill key={u.symbol} label={u.symbol} />
        ))}
      </PillWrap>

      <Text variant="footnote" color={colors.ink55}>
        Which of them it can actually act on is read at the moment it looks — a live price, the band
        it has recorded, the Nasdaq session, and whether the mint has a split or dividend queued.
      </Text>
    </View>
  );
}

export default function Schedule() {
  const goBack = useGoBack();
  const router = useRouter();
  const now = useNow();
  const { data, loading, error, reload } = useAsync(() => repos.strategies.list(), []);
  /*
   * Read alongside the strategies, not before them. A failure here leaves the list intact — the
   * agent panel is an addition to this screen, and losing it must not cost someone the schedule
   * they came for.
   */
  const agent = useAsync(() => api.get<AgentPreview>('/agents/preview'), []);

  const rows = useMemo(
    () =>
      (data ?? [])
        .filter((s) => s.state === 'live' || s.state === 'watch')
        .filter((s) => typeof s.nextRunAt === 'number')
        .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0)),
    [data],
  );

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">What runs next</Text>} />
      </View>

      <Fill style={{ marginTop: space.s16, paddingHorizontal: space.gutter }}>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <LoadingRows count={5} height={size.rowLg} />
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.s30 }}
          >
            {agent.data ? (
              <View style={{ marginBottom: space.s20 }}>
                <AgentNext
                  preview={agent.data}
                  now={now}
                  onEditRisk={() => router.push('/agent/risk')}
                  onOpenBasket={() => router.push('/agent/basket')}
                />
              </View>
            ) : null}

            {/*
              The strategies keep their own heading now that the agent sits above them: without one
              the two lists run together and a reader has no way to tell which schedule they are
              looking at.
            */}
            {rows.length > 0 ? (
              <Text variant="cardTitle" style={{ marginBottom: space.s10 }}>
                Your strategies
              </Text>
            ) : null}

            {rows.length === 0 ? (
              <EmptyList list="schedule" />
            ) : null}

            {rows.map((s) => {
              const t = when(s.nextRunAt!, now);
              return (
                <Row
                  key={s.id}
                  height={size.rowLg}
                  onPress={() => router.push(`/strategy/${s.id}`)}
                  title={s.label}
                  titleFigure={labelFigure(s.kind)}
                  // The kind as the library names it — "Recurring buy", not `dca`.
                  secondary={`${s.symbol} · ${kindLabel(s.kind)}`}
                  value={
                    <Text variant="rowPrimary" color={t.overdue ? colors.warn : colors.ink}>
                      {/*
                        "Due" rather than a negative duration. A strategy past its time is either
                        about to fire or is stuck, and neither is well described by "−4h".
                      */}
                      {t.label === 'now'
                        ? t.overdue
                          ? 'Due now'
                          : 'Now'
                        : t.overdue
                          ? `Due ${t.label} ago`
                          : `in ${t.label}`}
                    </Text>
                  }
                />
              );
            })}
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
