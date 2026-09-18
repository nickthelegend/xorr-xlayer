/**
 * Screen 22 — Position & close. screens.md Group B.
 *
 * Mark + "{symbol} {side}" + leverage chip. Eyebrow + P&L 46/700, "{pct} on {notional} held".
 * The held token's price over a range, with the user's own buys and sells marked where they filled.
 * Stat card: Entry / Mark / Size / Liquidation (down) / Funding paid (U+2212).
 * Close card: percentage + a 6pt fill bar + 25/50/75/100 pills + "Realises X and frees Y."
 * Edit TP/SL (flex:1) / "Close {n}%" (flex:1.3, white).
 *
 * The close button used to have no `onPress` at all: the primary action on the screen whose
 * entire job is closing a position did nothing. It now calls the executor, which picks the
 * price, splits the cost basis and signs the transfer — see `POST /positions/:id/close`.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { assetGradient } from '@/design/gradients';
import {
  AreaChart,
  AssetMark,
  BackButton,
  Button,
  ButtonRow,
  EmptyState,
  ErrorState,
  Fill,
  LoadingRows,
  NoteStrip,
  Pill,
  PillRow,
  Placeholder,
  Price,
  Row,
  Screen,
  SheetCard,
  Tag,
  Text,
  closeLine,
  colors,
  duration,
  lineMarks,
  money,
  percent,
  pnlTone,
  price as fmtPrice,
  quantity,
  radius,
  size,
  space,
  timing,
  toCandles,
  useReducedMotion,
} from '@/ui';
import { signedMoney } from '@/format';
import { CLOSE_STEPS, closeCta, driftSentence, holdingDrift } from '@/state/derived';
import { useStore } from '@/state/store';
import { repos } from '@/data';
import { fetchTimedHistory, fillsOf, type HistoryRange } from '@/data/marketData';
import { system } from '@/data/system';
import { settlementSymbol } from '@/data/tradable';
import { useAsync } from '@/data/useAsync';
import { CloseResult } from '@/ui/CloseResult';
import { useIntentKeys } from '@/data/useIntentKeys';
import { replayNote } from '@/markets/placed';
import { useLogo } from '@/data/useLogos';
import { errorText, wasReplayed } from '@/data/apiError';
import { useLiveRead } from '@/markets/useLiveRead';

/** The close bar. 6pt — a readout, not a control; the pills below it do the setting. */
const BAR_H = 6;
const STAT_ROW = 46;
/** The ranges the asset screen offers, each as long as its label. */
const RANGES: readonly HistoryRange[] = ['1D', '1W', '1M', '1Y'];
/** Shorter than the asset screen's chart: here the price is context for the position, not the subject. */
const CHART_H = 132;
/** The most runs `/runs` answers with, and so the reach of the marks: a fill older than the oldest of them is not drawn. */
const RUNS_WINDOW = 200;

export default function PositionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const goBack = useGoBack();
  const closePct = useStore((s) => s.closePct);
  const setClosePct = useStore((s) => s.setClosePct);
  const reduced = useReducedMotion();

  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string>();
  /* `replayed`: the executor had already answered this key, so this tap sold nothing. See `markets/placed.ts`. */
  const [closed, setClosed] = useState<{ proceeds: number; units: number; replayed: boolean } | undefined>();
  // A week, not a day: a position is held for longer than one, and the fills that built it are what the marks are for.
  const [range, setRange] = useState<HistoryRange>('1W');

  // Every figure below comes from the position book, valued at the live mark. The handoff's
  // entry $63,880 / mark $66,560 / liquidation $58,110 were design values with nothing
  // behind them.
  const { data: p, loading, error, reload } = useAsync(() => repos.portfolio.position(id!), [id]);
  const logo = useLogo(p?.symbol);

  /*
   * The price of what is held, over the chosen range, and your fills of it (FEATURES.md #9). Asked once the position
   * has said what it holds. As on the asset screen: a feed still warming is a wait `useLiveRead` asks again, null is
   * a token nothing prices, and the last range stays in its box, stepped back, while the next one loads (#83).
   */
  const symbol = p?.symbol;
  const history = useLiveRead(
    async () => ({ symbol, range, candles: symbol ? await fetchTimedHistory(symbol, range) : null }),
    [symbol, range],
  );
  const answer = history.data;
  const current = answer !== undefined && answer.symbol === symbol && answer.range === range ? answer : undefined;
  const drawn = current ?? (history.loading && answer !== undefined && answer.symbol === symbol ? answer : undefined);
  const pending = drawn !== undefined && current === undefined;
  const series = useMemo(() => toCandles((drawn?.candles ?? []).map((c) => c.bar)), [drawn]);
  const spans = useMemo(() => (drawn?.candles ?? []).map(({ start, end }) => ({ start, end })), [drawn]);
  const line = useMemo(() => closeLine(series, spans), [series, spans]);
  const chartMove = series.length > 1 ? series.at(-1)!.close - series[0]!.open : 0;

  // A failed read leaves the line unmarked and says nothing — see the asset screen, which reads the same record.
  const runs = useAsync(() => system.runs(RUNS_WINDOW), []);
  /*
   * The executor's own account of this symbol's cost basis. `basisIncomplete` is it saying that some of what was sold
   * had no recorded cost — so a gain worked out against that basis would have an error bar nobody can see, and the
   * result below declines to state one rather than stating it confidently.
   */
  const realised = useAsync(() => repos.portfolio.realised(), []);
  const fills = useMemo(
    () => (symbol ? fillsOf(runs.data ?? [], settlementSymbol(symbol)) : []),
    [runs.data, symbol],
  );
  const onLine = useMemo(() => lineMarks(fills, line.times), [fills, line]);

  const realise = p ? (p.unrealised * closePct) / 100 : 0;
  const free = p ? (p.margin * closePct) / 100 : 0;

  const pct = useSharedValue(closePct / 100);
  useEffect(() => {
    pct.value = withTiming(closePct / 100, timing(duration.base, reduced));
  }, [closePct, reduced, pct]);
  const fill = useAnimatedStyle(() => ({ width: `${pct.value * 100}%` }));

  /*
   * The close's Idempotency-Key (FEATURES.md #29): Close tapped again after a timeout is the same close. Another
   * percentage is another close, and so is the same one once the first has answered.
   */
  const keys = useIntentKeys();

  const close = useCallback(async () => {
    if (!p || closing) return;
    setClosing(true);
    setCloseError(undefined);
    try {
      const ask = { symbol: p.symbol, fraction: closePct / 100 };
      const res = await keys.send(ask, (idempotencyKey) => repos.portfolio.close(ask, { idempotencyKey }));
      if (res.status === 'closed') {
        setClosed({ proceeds: res.usd ?? 0, units: res.units ?? 0, replayed: wasReplayed(res) });
        reload();
      } else {
        // A blocked or failed close is not a success. Say which, in the server's own words — and say when
        // that answer belongs to an earlier attempt rather than to this tap.
        const note = replayNote(wasReplayed(res));
        const said = res.detail ?? res.error ?? `The close came back "${res.status}".`;
        setCloseError(note ? `${said} ${note}` : said);
      }
    } catch (e) {
      setCloseError(errorText(e));
    } finally {
      setClosing(false);
    }
  }, [p, closePct, closing, reload, keys]);

  const header = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.s10,
        justifyContent: 'space-between',
      }}
    >
      {/* The identity group carries the flex, so the feed tag sits at the right edge
          without a bare spacer between them — design.md §4. */}
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10, flex: 1, minWidth: 0 }}
      >
        <BackButton onPress={() => goBack()} />
        {p ? <AssetMark gradient={assetGradient(p.symbol)} {...logo} size={26} /> : null}
        <Text variant="cardTitle" numberOfLines={1}>
          {p ? `${p.symbol} ${p.side}` : 'Position'}
        </Text>
        {p && p.leverage > 1 ? <Tag label={`${p.leverage}x lev`} small /> : null}
      </View>
      {p?.feed === 'unavailable' ? <Tag label="No feed" small tone="warn" /> : null}
    </View>
  );

  if (loading && !p) {
    return (
      <Screen>
        {header}
        <LoadingRows count={4} height={size.row} />
      </Screen>
    );
  }
  if (error) {
    return (
      <Screen>
        {header}
        <ErrorState error={error} onRetry={reload} />
      </Screen>
    );
  }
  if (!p) {
    return (
      <Screen>
        {header}
        {/* copy.md: plain and specific. This screen is reached with an id; the honest
            statement is that *this* position is gone, not that the book is empty — the
            user may well hold others. */}
        <EmptyState text="This position is no longer open." />
      </Screen>
    );
  }

  const flat = p.units <= 0;
  const drift = holdingDrift(p);

  return (
    <Screen>
      {header}

      <View style={{ marginTop: space.s26, gap: space.s6 }}>
        <Text variant="eyebrowSm">Unrealised</Text>
        <Price variant="pnlHero" tone={pnlTone(p.unrealised)}>
          {signedMoney(p.unrealised)}
        </Price>
        <Text variant="body" color={colors.ink55} figure="own">
          {percent(p.unrealisedPct)} on {money(p.notional)} held
        </Text>
      </View>

      <Fill style={{ marginTop: space.s20 }}>
        <ScrollView showsVerticalScrollIndicator={false}>
          {/*
            The price with your fills on it — drag across it for a moment's price. Left out only for a token nothing
            prices, which has no chart to draw; a read that failed says so, and the range pills stay to try another.
          */}
          {current?.candles === null ? null : (
            <View style={{ marginBottom: space.s14 }}>
              <View style={{ minHeight: CHART_H, justifyContent: 'center' }}>
                {series.length > 1 && drawn ? (
                  <AreaChart
                    data={line.values}
                    times={line.times}
                    formatValue={fmtPrice}
                    figure="market"
                    marks={onLine}
                    seriesKey={`${p.symbol}:${drawn.range}`}
                    pending={pending}
                    height={CHART_H}
                    color={chartMove < 0 ? colors.down : colors.up}
                    endDot
                    drawIn
                  />
                ) : history.error ? (
                  <ErrorState error={history.error} onRetry={history.reload} />
                ) : history.loading ? (
                  <Placeholder height={CHART_H} style={{ borderRadius: radius.tile }} />
                ) : (
                  <Text variant="body" color={colors.ink55} align="center">
                    No chart yet.
                  </Text>
                )}
              </View>
              <PillRow style={{ marginTop: space.s12 }}>
                {RANGES.map((r) => (
                  <Pill key={r} label={r} selected={r === range} onPress={() => setRange(r)} />
                ))}
              </PillRow>
            </View>
          )}

          <SheetCard borderRadius={radius.panel} padding={space.s16}>
            {/* Prices stay while balances are hidden; the size, and what funding has cost, are the person's. */}
            <Row title="Entry" value={fmtPrice(p.entry)} figure="market" height={STAT_ROW} />
            <Row title="Mark" value={fmtPrice(p.mark)} figure="market" height={STAT_ROW} />
            <Row title="Size" value={`${quantity(p.units)} ${p.symbol}`} figure="units" height={STAT_ROW} />
            {p.liquidation > 0 ? (
              <Row
                title="Liquidation"
                value={
                  <Price tone="down" figure="market">
                    {fmtPrice(p.liquidation)}
                  </Price>
                }
                height={STAT_ROW}
              />
            ) : null}
            <Row
              title="Funding paid"
              value={
                <Price color={colors.ink55}>
                  {p.fundingPaid === 0 ? 'None — spot' : signedMoney(-p.fundingPaid)}
                </Price>
              }
              height={STAT_ROW}
              divider={false}
            />
          </SheetCard>

          {drift ? (
            <NoteStrip kind="risk" style={{ marginTop: space.s14 }} figure="units">
              {driftSentence(p.symbol, drift)}
            </NoteStrip>
          ) : null}

          {/*
            A close that was a REPLAY says so. The executor answered this key before and handed back what
            that attempt did, so this tap sold nothing — and "Sold 0.0412 WETH" a second time is the sentence
            that makes a user believe they sold twice.
          */}
          {closed ? (
            <NoteStrip kind="acted" style={{ marginTop: space.s14 }} figure="units">
              {closed.replayed
                ? `Already sold ${quantity(closed.units)} ${p.symbol} for ${money(closed.proceeds)}. Nothing was sold again.`
                : `Sold ${quantity(closed.units)} ${p.symbol} for ${money(closed.proceeds)}.`}
            </NoteStrip>
          ) : null}

          {/*
            And what it realised (FEATURES.md #44) — against this position's own average entry, which is from real
            fills. Not the `unrealised × fraction` forecast above: that is a projection against a live mark, and what is
            reported after a sale has to be the sale.

            It states a loss with the same weight as a gain, and says nothing at all where the cost basis cannot carry
            the claim. A moment that celebrates is worth nothing unless it can stay silent.
          */}
          {closed ? (
            <CloseResult
              symbol={p.symbol}
              outcome={{
                proceedsUsd: closed.proceeds,
                units: closed.units,
                entryPrice: p.entry,
                basisIncomplete:
                  realised.data?.bySymbol.find((r) => r.symbol === p.symbol)?.basisIncomplete ?? false,
                replayed: closed.replayed,
              }}
              style={{ marginTop: space.s10 }}
            />
          ) : null}

          {flat ? null : (
            <SheetCard
              borderRadius={radius.panel}
              padding={space.s16}
              style={{ marginTop: space.s14 }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                }}
              >
                <Text variant="cardTitle">Close</Text>
                <Price variant="screenTitle">{closePct}%</Price>
              </View>

              <View
                style={{
                  height: BAR_H,
                  borderRadius: BAR_H / 2,
                  backgroundColor: colors.control,
                  marginTop: space.s12,
                  overflow: 'hidden',
                }}
              >
                <Animated.View
                  style={[
                    { height: BAR_H, borderRadius: BAR_H / 2, backgroundColor: colors.ink },
                    fill,
                  ]}
                />
              </View>

              <View style={{ flexDirection: 'row', gap: space.s8, marginTop: space.s14 }}>
                {CLOSE_STEPS.map((step) => (
                  <View key={step} style={{ flex: 1 }}>
                    <Pill
                      label={`${step}%`}
                      selected={step === closePct}
                      onPress={() => setClosePct(step)}
                      style={{ flexGrow: 1 }}
                    />
                  </View>
                ))}
              </View>

              {/* One sentence to a screen reader, its two figures in their own ink: `figure` covers the spans in it. */}
              <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s14 }} figure="own">
                Realises{' '}
                <Text variant="secondarySm" color={colors.ink}>
                  {signedMoney(realise)}
                </Text>{' '}
                and frees{' '}
                <Text variant="secondarySm" color={colors.ink}>
                  {money(free)}
                </Text>
                .
              </Text>

              {closeError ? (
                <Text variant="secondarySm" color={colors.down} style={{ marginTop: space.s10 }}>
                  {closeError}
                </Text>
              ) : null}
            </SheetCard>
          )}
        </ScrollView>
      </Fill>

      {flat ? (
        <Button label="Done" onPress={() => goBack()} />
      ) : (
        <ButtonRow
          style={{ marginTop: space.s14 }}
          secondary={
            <Button
              label="Edit TP/SL"
              variant="secondary"
              onPress={() => router.push(`/auto-close/${p.id}`)}
            />
          }
          primary={<Button label={closeCta(closePct)} loading={closing} onPress={close} />}
        />
      )}
    </Screen>
  );
}
