/**
 * Screen 17 — Backtest. screens.md Group C.
 *
 * Lookback pills 30d / 90d (default) / 6m / 1y. A 150pt equity curve with grid lines.
 * Four stat tiles: Return / Max DD (U+2212) / Sharpe / Trades, with Return and Max DD coloured by
 * their own sign. Both were fixed — Return always `up`, Max DD always `down` — so a losing replay
 * showed its loss in profit-green and a replay that never fell showed its zero in red.
 * Card: "If you'd started with" + a capital stepper ($1k–$50k by $1k), then the projected
 * end value and the gain. Disclaimer: "Nothing here is a promise."
 *
 * The curve arrives as an equity SERIES now, not as an SVG polyline the executor drew —
 * see `server/src/backtest/engine.ts`. The chart projects it, which is the chart's job.
 */
import React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  AreaChart,
  BackButton,
  Button,
  colors,
  EmptyState,
  ErrorState,
  Fill,
  LoadingRows,
  money,
  Pill,
  PillRow,
  pnlTone,
  Price,
  radius,
  Screen,
  SheetCard,
  size,
  space,
  StatGrid,
  Stepper,
  Text,
  type PriceTone,
} from '@/ui';
import { BT_CAPITAL_MAX, BT_CAPITAL_MIN, backtestSummary } from '@/state/derived';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { useStore } from '@/state/store';
import type { BacktestResult } from '@/data/types';

const LOOKBACKS: BacktestResult['lookback'][] = ['30d', '90d', '6m', '1y'];
const CHART_H = 150;

/** The P&L colours, only where there is a gain or a loss. A flat figure keeps the tile's own ink. */
function toneColor(tone: PriceTone): string | undefined {
  return tone === 'up' ? colors.up : tone === 'down' ? colors.down : undefined;
}

export default function Backtest() {
  const { id = 'momentum-scout' } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const goBack = useGoBack();
  const btLook = useStore((s) => s.btLook);
  const setBtLook = useStore((s) => s.setBtLook);
  const btCapital = useStore((s) => s.btCapital);
  const bumpBtCapital = useStore((s) => s.bumpBtCapital);

  /*
   * Whose backtest this is, read rather than assumed.
   *
   * The line below the title was the literal string "Momentum Scout". The RESULTS underneath it
   * have always been real and have always been for `id` — /bot/earnings-desk/backtest returned
   * Earnings Desk's +33.5% over 13 trades — so every agent but one had its own numbers published
   * under another agent's name. Attribution is the whole content of a backtest: a return with the
   * wrong strategy on it is worse than no return at all.
   *
   * And asked for by the id the executor keys backtests on, which is the persona. The roster links
   * here with `a.id`, and for an agent this wallet has hired that is its row uuid, which the executor
   * answers `404 unknown_agent` (server/src/routes/extra.ts) — so a hired Momentum Scout, the one
   * agent that can be replayed, never could be. The roster is read first, the agent found by either
   * id, and the request goes out under its `personaId`.
   */
  const roster = useAsync(() => repos.bot.listAgents(), []);
  const agent = (roster.data ?? []).find((a) => a.id === id || a.personaId === id);
  const personaId = agent ? (agent.personaId ?? agent.id) : undefined;

  const { data, loading, error, reload } = useAsync(
    async () => (personaId ? repos.bot.backtest(personaId, LOOKBACKS[btLook]!) : null),
    [personaId, btLook],
  );

  const summary = data ? backtestSummary(btCapital, data.ret, data.maxDd) : null;
  const tone = pnlTone(data?.ret ?? 0);
  // A drawdown is a fall from a peak: a loss, or nothing. The engine sends it at or below zero.
  const ddTone = pnlTone(-Math.abs(data?.maxDd ?? 0));

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8 }}>
        <BackButton onPress={() => goBack()} />
        <Text variant="screenTitle">Backtest</Text>
      </View>

      <Text variant="secondary" style={{ marginTop: space.s10 }}>
        {/*
          Only claims a run when there was one. The executor refuses three of the four agents, and
          "on real history" sitting above "there is no history to replay" is the screen arguing with
          itself — so when it refuses, the name alone stands and ErrorState below says why. With no
          agent to name, there is no subtitle.
        */}
        {!agent
          ? ''
          : error
            ? agent.name
            : `${agent.name}, on real history at your current limits. Nothing here is a promise.`}
      </Text>

      <PillRow style={{ marginTop: space.s18, flexGrow: 0 }}>
        {LOOKBACKS.map((l, i) => (
          <Pill key={l} label={l} selected={i === btLook} onPress={() => setBtLook(i)} />
        ))}
      </PillRow>

      <Fill style={{ marginTop: space.s18 }}>
        {roster.error && !roster.data ? (
          // Signed out, this asks for a sign-in. Otherwise the roster read failed, and it says so.
          <ErrorState error={roster.error} onRetry={roster.reload} />
        ) : !roster.data ? (
          <LoadingRows count={3} height={size.row} />
        ) : !agent ? (
          <EmptyState text={`No agent "${id}" on the roster.`} />
        ) : loading ? (
          /*
            Whenever a window is on its way, not only the first time. Keeping the last answer up while
            another lookback loaded put one window's numbers under a different lit pill.
          */
          <LoadingRows count={3} height={size.row} />
        ) : error ? (
          /*
            The executor refuses to backtest three of the four agents, and says why in one
            sentence each — a tokenized-equity strategy has no price history to replay, a yield
            strategy has no price path, and a strategy that only closes positions has no return
            independent of the book it is guarding. Those are 4xx, so `ErrorState` shows the
            sentence and offers no retry: pressing again cannot change any of them.
          */
          <ErrorState error={error} onRetry={reload} />
        ) : data && summary ? (
          <>
            {data.equity.length > 1 ? (
              <AreaChart
                data={data.equity}
                height={CHART_H}
                color={toneColor(tone) ?? colors.ink55}
                grid
                endDot
              />
            ) : (
              <View style={{ height: CHART_H, justifyContent: 'center' }}>
                <Text variant="secondary">No equity series came back for this range.</Text>
              </View>
            )}

            <StatGrid
              style={{ marginTop: space.s20 }}
              items={[
                { label: 'Return', value: summary.ret, color: toneColor(tone) },
                { label: 'Max DD', value: summary.dd, color: toneColor(ddTone) },
                { label: 'Sharpe', value: data.sharpe.toFixed(1) },
                { label: 'Trades', value: String(data.trades) },
              ]}
            />

            <SheetCard
              borderRadius={radius.panel}
              padding={space.s16}
              style={{ marginTop: space.s16 }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Text variant="rowPrimary">{`If you'd started with`}</Text>
                <Stepper
                  value={money(btCapital, { decimals: 0 })}
                  onDecrement={() => bumpBtCapital(-1)}
                  onIncrement={() => bumpBtCapital(1)}
                  canDecrement={btCapital > BT_CAPITAL_MIN}
                  canIncrement={btCapital < BT_CAPITAL_MAX}
                  valueMinWidth={84}
                />
              </View>
              <Price variant="amountMd" style={{ marginTop: space.s16 }}>
                {summary.end}
              </Price>
              <Price variant="body" tone={tone} style={{ marginTop: space.s4 }}>
                {summary.gain}
              </Price>
            </SheetCard>

            {/* Provenance and the disclaimer, both from the executor. A backtest without
                them is a sales pitch. */}
            <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s14 }}>
              {[data.source, data.disclaimer].filter(Boolean).join(' · ')}
            </Text>
          </>
        ) : null}
      </Fill>

      {/*
        Says where it goes. This was "Run this strategy live" and pushed /strategies, which starts
        nothing — and nothing in the app can create the one strategy that can be replayed here. The
        agent's own page is where it is hired.
      */}
      {agent ? (
        <Button
          label={`Open ${agent.name}`}
          onPress={() => router.push(`/agent/${agent.personaId ?? agent.id}`)}
        />
      ) : null}
    </Screen>
  );
}
