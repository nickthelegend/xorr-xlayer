/**
 * Portfolio — what the wallet is worth, what the bot holds, and what it made (2026-09-12).
 *
 * Opened from the balance on Home. The balance with its week drawn under it, money in and out, then
 * every open position as a card — the recent price with its entry, target and stop, the trades that
 * built it and why — then profit, cash and earning.
 *
 * The graph is the wallet's own history — what it was worth at each snapshot the executor read from the
 * chain over the last week (PLAN.md 2.10) — and its caption says how far back that line actually reaches.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  BackButton,
  Button,
  Eyebrow,
  Placeholder,
  Press,
  Price,
  Row,
  Screen,
  Text,
  colors,
  money,
  percent,
  pnlTone,
  price as fmtPrice,
  quantity,
  radius,
  size,
  space,
  toCandles,
  NoteStrip,
  SignInPrompt,
} from '@/ui';
import { useSignedOut } from '@/auth/useSignedOut';
import { PositionCard, PositionCardSkeleton, type PositionLevel } from '@/ui/PositionCard';
import { AllocationDonut } from '@/ui/charts/AllocationDonut';
import { TimelineNotYet, ValueTimeline } from '@/ui/charts/ValueTimeline';
import { continuityWindowMs, netInvestedSteps, observedRuns, recordedCount } from '@/ui/charts/timeline';
import { useMeasuredBox } from '@/ui/charts/useMeasuredBox';
import { allocationBySector } from '@/ui/charts/allocation';
import { Rise } from '@/ui/Rise';
import { RollingNumber } from '@/ui/RollingNumber';
import { STAGGER } from '@/ui/motion';
import { signedMoney } from '@/format';
import { repos } from '@/data';
import { system, type SectorClassification } from '@/data/system';
import { useAsync } from '@/data/useAsync';
import { useFreshOnReturn } from '@/data/useFreshOnReturn';
import type { Strategy } from '@/data/types';
import { driftSentence, holdingDrift } from '@/state/derived';

const GRAPH_H = 150;
/** The day's closes on each card: `1H` reads one day, folded to twelve candles (src/data/marketData.ts). */
const CARD_TF = '1H' as const;
const CARD_POINTS = 12;
/** How far back the history must reach before its caption may say "Past week" rather than when it starts. */
const WEEK_MS = 6.5 * 24 * 60 * 60 * 1000;

/**
 * What the graph's line covers, in as few words as it takes to be true.
 *
 * The history holds what exists, and a wallet a day old has a day of it. "Past week" over a day's line is the
 * overclaim the old caption made, so a line that starts later says when it starts.
 */
function historyCaption(firstAt: number, now = Date.now()): string {
  return now - firstAt >= WEEK_MS
    ? 'Past week'
    : `Since ${new Date(firstAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
/** Below a cent, a holding is left over from a sale rather than held. */
const DUST_USD = 0.01;

const card = {
  marginTop: space.s14,
  marginHorizontal: space.gutter,
  padding: space.s16,
  borderRadius: radius.panel,
  backgroundColor: colors.surfaceAlt,
} as const;

/**
 * Closes per symbol, each arriving on its own.
 *
 * One `Promise.all` made every card wait for the slowest coin: CBBTC's history answered 503 after
 * eight seconds while WETH's took half of one, and WETH's chart sat as a skeleton the whole time. Each
 * symbol now lands in the map as soon as it answers — `undefined` while in flight, `null` when it
 * could not be read, and never a guessed series.
 */
function useClosesBySymbol(symbolsKey: string, timeframe: '1H' | '4H'): Record<string, number[] | null> {
  /*
   * Tagged with the question it answers, so a new set of symbols reads as empty until its own answers
   * arrive — rather than clearing state synchronously inside the effect, which re-rendered for nothing.
   */
  const key = `${timeframe}:${symbolsKey}`;
  const [answered, setAnswered] = useState<{ key: string; closes: Record<string, number[] | null> }>({
    key: '',
    closes: NO_CLOSES,
  });
  useEffect(() => {
    let alive = true;
    for (const symbol of symbolsKey ? symbolsKey.split(',') : []) {
      repos.markets
        .candles(symbol, timeframe)
        .then((candles) => toCandles(candles.bars).map((c) => c.close))
        .catch(() => null)
        .then((value) => {
          if (!alive) return;
          setAnswered((prev) => ({
            key,
            closes: { ...(prev.key === key ? prev.closes : NO_CLOSES), [symbol]: value },
          }));
        });
    }
    return () => {
      alive = false;
    };
  }, [key, symbolsKey, timeframe]);
  return answered.key === key ? answered.closes : NO_CLOSES;
}

/** One empty map, so "nothing answered yet" keeps the same identity across renders. */
const NO_CLOSES: Record<string, number[] | null> = {};

/** Take profit and stop loss on a symbol, from the exit rules set on it — and nothing when there are none. */
function exitLevels(strategies: readonly Strategy[], symbol: string, entry: number): PositionLevel[] {
  const rule = strategies.find(
    (s) => s.kind === 'exit-rules' && s.symbol === symbol && (s.state === 'live' || s.state === 'watch'),
  );
  if (!rule) return [];
  const levels: PositionLevel[] = [];
  const tp = Math.abs(Number(rule.params.takeProfitPct ?? 0));
  const sl = Math.abs(Number(rule.params.stopLossPct ?? 0));
  if (tp > 0) {
    const value = entry * (1 + tp / 100);
    levels.push({ label: 'TP', value, formatted: fmtPrice(value), tone: 'target' });
  }
  if (sl > 0) {
    const value = entry * (1 - sl / 100);
    levels.push({ label: 'SL', value, formatted: fmtPrice(value), tone: 'stop' });
  }
  return levels;
}

export default function Portfolio() {
  const goBack = useGoBack();
  const router = useRouter();
  const balance = useAsync(() => repos.portfolio.balance(), []);
  const positions = useAsync(() => repos.portfolio.positions(), []);
  const realised = useAsync(() => repos.portfolio.realised(), []);
  const strategies = useAsync(() => repos.strategies.list(), []);
  const runs = useAsync(() => system.runs(200), []);
  const activity = useAsync(() => repos.activity.list(), []);

  // Dust a sale left behind is not a position: it would read as an open trade worth $0.00.
  const book = useMemo(() => (positions.data ?? []).filter((p) => p.notional >= DUST_USD), [positions.data]);
  const symbolsKey = book.map((p) => p.symbol).join(',');
  const daily = useClosesBySymbol(symbolsKey, CARD_TF);

  /*
   * The week, as the wallet was actually worth it: the snapshots the executor reads from the chain every fifteen
   * minutes and at every fill, close and withdrawal (PLAN.md 2.10). This used to be today's units times each coin's
   * past closes, captioned only "Past week" — a coin bought on Thursday drawn as held all week, and the cash and
   * savings in the total above left out of the line beneath it.
   */
  const history = useAsync(() => system.portfolioHistory('1W'), []);
  /*
   * Read again when someone comes back (FEATURES.md #27). This sheet sits under the position screen a sale is made from,
   * and under Deposit and Send, and every figure on it moves with what happened there. The cards' closes keep their own
   * read — a day of hourly prices, asked again when the set of positions changes.
   */
  useFreshOnReturn(balance, positions, realised, strategies, runs, activity, history);
  const points = useMemo(() => (history.data?.points ?? []).map((p) => p.totalUsd), [history.data]);
  const firstAt = history.data?.points[0]?.at;
  const graphDelta = points.length > 1 ? points[points.length - 1]! - points[0]! : 0;
  const graphPct = points.length > 1 && points[0]! > 0 ? (graphDelta / points[0]!) * 100 : 0;

  /*
   * What each held company does, from the SEC (`/market/classification`). Asked only for what is actually held, and
   * re-asked when the book changes; a symbol the regulator has no classification for comes back null and stays null.
   */
  const heldSymbols = useMemo(() => [...new Set(book.map((p) => p.symbol))].sort(), [book]);
  const sectors = useAsync<Record<string, SectorClassification | null>>(
    () => (heldSymbols.length === 0 ? Promise.resolve({}) : system.classification(heldSymbols)),
    [heldSymbols.join(',')],
  );
  /* The donut's arithmetic, from real position values and real classifications. */
  const allocation = useMemo(
    () =>
      allocationBySector(
        book.map((p) => ({ symbol: p.symbol, valueUsd: p.notional, sector: sectors.data?.[p.symbol]?.sector ?? null })),
      ),
    [book, sectors.data],
  );

  /*
   * The history, as the things that were actually recorded (`timeline.ts`).
   *
   * Two series, true in two different ways. NET INVESTED steps at each recorded fill and is flat between them because
   * it WAS flat between them — exactly, not approximately — so joining two fills claims nothing. VALUE WHEN RECORDED is
   * the snapshots, drawn as the readings they are and joined only across stretches recorded continuously; where nothing
   * was recorded for a while there is a gap, because a line across it would be a claim about time nobody looked at.
   *
   * Neither is interpolated, smoothed or extended to the edges.
   */
  const investedSteps = useMemo(
    () =>
      netInvestedSteps(
        (runs.data ?? [])
          .filter((r) => r.status === 'filled' && r.usd !== null)
          .map((r) => ({ at: Date.parse(r.finishedAt ?? r.at), usd: r.usd as number, side: r.side ?? null })),
      ),
    [runs.data],
  );
  const valueRuns = useMemo(
    () => observedRuns(history.data?.points ?? [], continuityWindowMs(history.data?.everyMinutes)),
    [history.data],
  );
  const recorded = recordedCount(investedSteps, valueRuns);
  const [graphBox, onGraphLayout] = useMeasuredBox();

  /* Fills per symbol — how many trades built each position. */
  const trades = useMemo(() => {
    if (!runs.data) return undefined;
    const by: Record<string, number> = {};
    for (const r of runs.data) if (r.status === 'filled') by[r.symbol] = (by[r.symbol] ?? 0) + 1;
    return by;
  }, [runs.data]);

  /*
   * The bot's own words for its latest trade in a symbol, from the audit trail — matched as a whole word, because
   * `includes` let ETH claim "Bought 0.1234 WETH".
   */
  const whyFor = (symbol: string): string | undefined => {
    const event = (activity.data ?? []).find(
      (e) => e.kind === 'trade' && e.action.split(/[^A-Za-z0-9]+/).includes(symbol),
    );
    return event ? [event.action, event.detail].filter(Boolean).join('. ') : undefined;
  };

  const unrealised = book.reduce((sum, p) => sum + p.unrealised, 0);
  const cost = book.reduce((sum, p) => sum + (p.notional - p.unrealised), 0);
  const unrealisedPct = cost > 0 ? (unrealised / cost) * 100 : undefined;
  const total = balance.data?.total ?? null;
  const signedOut = useSignedOut();

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.gutter }}>
      <BackButton onPress={goBack} />
      <Text variant="cardTitle" align="center" style={{ flex: 1 }}>
        Portfolio
      </Text>
      {/* Balances the back button, so the title sits in the true centre. */}
      <View style={{ width: size.hit }} />
    </View>
  );

  // Signed out, a dash for the balance and "Couldn’t load positions" describe a wallet nobody has named.
  if (signedOut) {
    return (
      <Screen gutter="none" sheet>
        {header}
        <SignInPrompt />
      </Screen>
    );
  }

  return (
    <Screen gutter="none" sheet>
      {header}

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.s30 }}>
        <Rise index={0} style={{ alignItems: 'center', marginTop: space.s14 }}>
          <Eyebrow>Total balance</Eyebrow>
          {total !== null ? (
            <RollingNumber
              value={money(total)}
              variant="heroBalance"
              delay={STAGGER}
              roll
              containerStyle={{ marginTop: space.s6 }}
            />
          ) : balance.loading ? (
            <Placeholder width={200} height={46} style={{ marginTop: space.s8, borderRadius: radius.tile }} />
          ) : (
            <Price variant="heroBalance" style={{ marginTop: space.s6 }}>
              —
            </Price>
          )}
          {positions.loading && !positions.data ? (
            <Placeholder width={160} height={14} style={{ marginTop: space.s10 }} />
          ) : unrealisedPct !== undefined && Math.abs(unrealised) >= 0.005 ? (
            <Price variant="secondarySm" tone={pnlTone(unrealised)} style={{ marginTop: space.s6 }}>
              {`${signedMoney(unrealised)} · ${percent(unrealisedPct)} open`}
            </Price>
          ) : null}
        </Rise>

        <Rise index={1} style={{ marginTop: space.s18, paddingHorizontal: space.gutter }}>
          {history.loading && !history.data ? (
            <Placeholder height={GRAPH_H} style={{ borderRadius: radius.tile }} />
          ) : history.error ? (
            // Said rather than left as a gap: a graph that is simply missing reads as a wallet with no past.
            <Text variant="footnote" color={colors.ink55}>
              Couldn’t load the past week.
            </Text>
          ) : recorded < 2 ? (
            /* Nothing, or one reading. Neither is a trend, and a line along zero would claim we watched and it held. */
            <TimelineNotYet count={recorded} />
          ) : (
            <View onLayout={onGraphLayout}>
              <ValueTimeline steps={investedSteps} runs={valueRuns} width={graphBox.width} height={GRAPH_H} />
              <View
                style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.s8 }}
              >
                <Text variant="footnote" color={colors.ink55}>
                  {firstAt !== undefined ? historyCaption(firstAt) : 'Every reading recorded so far'}
                </Text>
                {points.length > 1 ? (
                  <Price variant="footnote" tone={pnlTone(graphDelta)}>
                    {`${signedMoney(graphDelta)} · ${percent(graphPct)}`}
                  </Price>
                ) : null}
              </View>
              {/* What the two series are. Without this the dimmer step line is an unexplained second line. */}
              <View style={{ flexDirection: 'row', gap: space.s14, marginTop: space.s6 }}>
                <Text variant="footnote" color={colors.ink55}>
                  Value when recorded
                </Text>
                <Text variant="footnote" color={colors.ink45}>
                  Net invested
                </Text>
              </View>
            </View>
          )}
        </Rise>

        <Rise
          index={2}
          style={{ flexDirection: 'row', gap: space.s10, marginTop: space.s18, paddingHorizontal: space.gutter }}
        >
          <View style={{ flex: 1 }}>
            <Button label="Deposit" onPress={() => router.push('/deposit')} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Withdraw" variant="ghost" height={size.button} onPress={() => router.push('/send')} />
          </View>
        </Rise>

        {/*
          What the book is made of, by sector — the SEC's own classification of each underlying company, never a
          mapping of ours (`/market/classification`). A holding the regulator has no answer for is drawn and labelled
          Unclassified; it is never guessed from the ticker and never dropped, because dropping it would renormalise
          every other slice and the chart would look right while being wrong by exactly that much.

          Nothing is drawn until the classifications have answered: a donut whose every slice says Unclassified
          because the read is still in flight is a chart telling a story about the read rather than the portfolio.
        */}
        {book.length > 0 ? (
          <Rise index={3} style={{ marginTop: space.s26, paddingHorizontal: space.gutter, gap: space.s12 }}>
            <Text variant="cardTitle">Allocation</Text>
            {sectors.loading && !sectors.data ? (
              <Placeholder height={168} style={{ borderRadius: radius.panel }} />
            ) : sectors.error ? (
              <Text variant="body" color={colors.ink55}>
                Couldn’t read what these companies do, so the split by sector isn’t shown.
              </Text>
            ) : (
              <AllocationDonut slices={allocation.slices} total={money(allocation.totalUsd)} totalLabel="In positions" />
            )}
          </Rise>
        ) : null}

        <Rise index={4} style={{ marginTop: space.s26, paddingHorizontal: space.gutter, gap: space.s12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <Text variant="cardTitle">Positions</Text>
            {positions.data ? (
              <Text variant="secondarySm" color={colors.ink55}>
                {book.length === 1 ? '1 open' : `${book.length} open`}
              </Text>
            ) : null}
          </View>
          {positions.loading && !positions.data ? (
            <>
              <PositionCardSkeleton />
              <PositionCardSkeleton />
            </>
          ) : book.length === 0 ? (
            <View style={{ padding: space.s16, gap: space.s12, borderRadius: radius.panel, backgroundColor: colors.surfaceAlt }}>
              <Text variant="body" color={colors.ink55}>
                {positions.error ? 'Couldn’t load positions.' : 'No open positions yet.'}
              </Text>
              {!positions.error ? (
                <Button label="Start a recurring buy" variant="ghost" onPress={() => router.push('/strategy/dca')} />
              ) : null}
            </View>
          ) : (
            book.map((p) => (
              <PositionCard
                key={p.id}
                symbol={p.symbol}
                side={p.side}
                price={fmtPrice(p.mark)}
                pnl={signedMoney(p.unrealised)}
                pnlPct={percent(p.unrealisedPct)}
                pnlValue={p.unrealised}
                series={daily[p.symbol] === undefined ? undefined : (daily[p.symbol] ?? []).slice(-CARD_POINTS)}
                levels={[
                  { label: 'ENTRY', value: p.entry, formatted: fmtPrice(p.entry), tone: 'entry' },
                  ...exitLevels(strategies.data ?? [], p.symbol, p.entry),
                ]}
                stats={[
                  { label: 'SIZE', value: quantity(p.units), figure: 'units' },
                  { label: 'VALUE', value: money(p.notional) },
                  { label: 'P&L', value: signedMoney(p.unrealised), value2: p.unrealised },
                ]}
                trades={trades?.[p.symbol]}
                why={whyFor(p.symbol)}
                onPress={() => router.push(`/position/${p.id}`)}
              />
            ))
          )}
          {/* Where the ledger and the wallet disagree, said beside the cards it changes (PLAN.md 2.7). */}
          {book.map((p) => {
            const drift = holdingDrift(p);
            return drift ? (
              <NoteStrip key={`drift-${p.id}`} kind="risk" style={{ marginTop: space.s10 }}>
                {driftSentence(p.symbol, drift)}
              </NoteStrip>
            ) : null;
          })}
        </Rise>

        <Rise index={5} style={card}>
          <Text variant="cardTitle">Profit</Text>
          <Row
            height={size.rowSm}
            title="Open"
            value={
              positions.data ? (
                <Price tone={pnlTone(unrealised)}>{signedMoney(unrealised)}</Price>
              ) : positions.loading ? (
                <Placeholder width={80} height={18} />
              ) : (
                // A read that failed is a dash, as Closed is: a placeholder that never resolves reads as still coming.
                <Price>—</Price>
              )
            }
          />
          <Row
            height={size.rowSm}
            divider={false}
            title="Closed"
            value={
              realised.data ? (
                <Price tone={pnlTone(realised.data.total)}>{signedMoney(realised.data.total)}</Price>
              ) : realised.loading ? (
                <Placeholder width={80} height={18} />
              ) : (
                <Price>—</Price>
              )
            }
          />
        </Rise>

        <Rise index={6} style={[card, { flexDirection: 'row', gap: space.s12 }]}>
          <View style={{ flex: 1, gap: space.s4 }}>
            <Text variant="eyebrowSm">Cash</Text>
            {balance.data ? (
              <Price variant="rowPrimary">{money(balance.data.cash)}</Price>
            ) : balance.loading ? (
              <Placeholder width={70} height={18} />
            ) : (
              <Price variant="rowPrimary">—</Price>
            )}
          </View>
          <Press
            onPress={() => router.push('/yield')}
            accessibilityRole="button"
            accessibilityLabel="Earning. Opens yield."
            style={{ flex: 1, gap: space.s4 }}
          >
            <Text variant="eyebrowSm">Earning</Text>
            {balance.data ? (
              <Price variant="rowPrimary">{money(balance.data.supplied)}</Price>
            ) : balance.loading ? (
              <Placeholder width={70} height={18} />
            ) : (
              <Price variant="rowPrimary">—</Price>
            )}
          </Press>
        </Rise>
      </ScrollView>
    </Screen>
  );
}
