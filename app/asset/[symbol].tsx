/**
 * Screen 13 — Asset detail. screens.md Group B.
 *
 * Back / mark + name. Price at `priceLg` with a delta chip that names its window. A chart — candles by
 * default, or the line, chosen above it — over the real series for the selected range, with the user's own
 * fills marked on it and listed under it, each with the venue that filled it (FEATURES.md #77). Range pills. The
 * position rows, from the real book. Sell / Buy.
 *
 * Rebuilt on `src/ui`. Everything that used to be invented is gone: the position rows were
 * hardcoded (1,750.30 of one token, avg cost $81.14, +$12,566), and the chart fell back to one
 * fixture series, drawing its shape under whatever symbol you had opened.
 *
 * The price and the history are read through `src/markets` and `src/data/marketData`, where a failed read throws.
 * Through the repository both failures came back as "no feed", so the error state this screen carried could never show.
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import { assetGradient } from '@/design/gradients';
import {
  AreaChart,
  AssetMark,
  BackButton,
  Button,
  ButtonPair,
  Candlestick,
  DeltaChip,
  ErrorState,
  Pill,
  PillRow,
  Segmented,
  Placeholder,
  Press,
  Price,
  Row,
  Screen,
  Text,
  candleMarks,
  closeLine,
  colors,
  lineMarks,
  markDetail,
  money,
  type MarkedFill,
  NoteStrip,
  percent,
  pnlTone,
  price as fmtPrice,
  quantity,
  radius,
  size,
  space,
  tightProjection,
  toCandles,
  typeScale,
} from '@/ui';
import { RollingNumber } from '@/ui/RollingNumber';
import { movePhrase, signedMoney, when } from '@/format';
import { repos } from '@/data';
import { api } from '@/data/api';
import { NotSignedIn } from '@/data/apiError';
import { fetchTimedHistory, fillsKnownFrom, fillsOf, type HistoryRange } from '@/data/marketData';
import { system } from '@/data/system';
import { useAsync } from '@/data/useAsync';
import { useLogo } from '@/data/useLogos';
import { coveredLabel, rangeChange } from '@/state/derived';
import { settlementSymbol } from '@/data/tradable';
import { useSettleable } from '@/data/useSettleable';
import { chartFillsNote, listedFills } from '@/markets/chartFills';
import { quoteOf } from '@/markets/quote';
import { actionSentence, type CorporateActionNotice } from '@/markets/corporateAction';
import { DUST_USD } from '@/markets/ticket';
import { useLiveRead } from '@/markets/useLiveRead';
import { useNow } from '@/state/useNow';

/**
 * The ranges, each as long as its label.
 *
 * `1Y` fetched ninety days, and so did `All`, under "past year" and "all time". A year is a year now.
 * `All` is gone: the price feed keeps no more than a year of history, so there is no all time to draw.
 */
const RANGES: readonly HistoryRange[] = ['1D', '1W', '1M', '1Y'];
/**
 * Candles or line, as a visible control.
 *
 * Words, not glyphs. This shipped as `▮` and `∿` on the theory that two shapes read faster than
 * two words and cost less width — but at the 13px the control type is set in, `▮` is a two-pixel
 * mark and `∿` is barely a dot, and neither says anything to a screen reader, which gets the raw
 * character. A control nobody can read is not a compact control.
 */
const CHART_VIEWS: { value: number; label: string }[] = [
  { value: 0, label: 'Candles' },
  { value: 1, label: 'Line' },
];

/** Wide enough for "Candles" at 13/600, and comfortably past the 44pt minimum target. */
const CHART_VIEW_SEGMENT = 58;
const CHART_VIEW_W = CHART_VIEW_SEGMENT * 2 + space.s4 + size.segPad * 2;

const CHART_H = 170;
const ROW_H = 52;
/**
 * The line under the price is the change chip, "Loading…" or "No price feed.", as the reads come in. It is held at the
 * taller of a chip and a line of body text, so trading one for another — which a range switch does twice — moves
 * nothing below it.
 */
const CHANGE_LINE_H = Math.max(typeScale.body.lineHeight, typeScale.chipDelta.lineHeight + space.s2 * 2);
/** The most runs `/runs` answers with, and so the reach of the marks: a fill older than the oldest of them is not drawn. */
const RUNS_WINDOW = 200;
/** The most fills listed under the chart. The rest are still marked on it, and counted in a line below the list. */
const LISTED_FILLS = 5;

export default function AssetDetail() {
  const { symbol } = useLocalSearchParams<{ symbol: string }>();
  const router = useRouter();
  const goBack = useGoBack();
  const [range, setRange] = useState<HistoryRange>('1D');
  // design.md calls the candlestick the centrepiece, and the bars are already fetched — the
  // area chart was only ever a summary of the same data. Both are offered; candles are the
  // default wherever there are real ones to draw.
  const [candleView, setCandleView] = useState(true);

  const logo = useLogo(symbol);
  const inst = useAsync(() => repos.markets.getInstrument(symbol!), [symbol]);
  const positions = useAsync(() => repos.portfolio.positions(), []);
  // Dust a sale left behind is not a position (as on Portfolio): a cent or more is held.
  const held = (positions.data ?? []).find((p) => p.symbol === symbol && p.notional >= DUST_USD);
  // Signed out there is no position to show, which is not a failure. Anything else that stopped the read is.
  const positionUnread = positions.error !== undefined && !(positions.error instanceof NotSignedIn);

  // Tokenized equities have a real spot price and no history: they are priced off the route
  // that would fill them, not a candle feed. A real price with no chart is a true state to show.
  const spotRead = useLiveRead(() => quoteOf(symbol!), [symbol]);
  /*
   * The history, with the stretch of time each candle covers — what a fill is placed by and what the scrub reads
   * out. A feed still warming throws `StillWarming`, which `useLiveRead` treats as a wait and asks again; null is a
   * symbol nothing prices.
   */
  const history = useLiveRead(
    async () => ({ symbol: symbol!, range, candles: await fetchTimedHistory(symbol!, range) }),
    [symbol, range],
  );

  /*
   * The answer for this symbol and range — never the last range's candles under the new label as if they were it.
   *
   * While the next range loads, the last one stays in its box, stepped back and not scrubbable (FEATURES.md #83), and
   * crossfades into the answer when it lands. It used to drop to a skeleton of a different height, lose the
   * Candles/Line control above it, and draw the new range in from the left, so every tap on a pill shook the screen.
   * Nothing else here reads the kept range: the change line waits for the real answer.
   */
  const answer = history.data;
  const current = answer?.symbol === symbol && answer.range === range ? answer : undefined;
  const drawn = current ?? (history.loading && answer?.symbol === symbol ? answer : undefined);
  const pending = drawn !== undefined && current === undefined;
  const series = useMemo(() => toCandles((drawn?.candles ?? []).map((c) => c.bar)), [drawn]);
  const spans = useMemo(() => (drawn?.candles ?? []).map(({ start, end }) => ({ start, end })), [drawn]);
  // The line from the window's first open, so it covers the range its pill names and a fill anywhere in it has a place.
  const line = useMemo(() => closeLine(series, spans), [series, spans]);
  /*
   * One reading is enough to draw (FEATURES.md #41). This was `> 1`, so a symbol with exactly one recorded price fell
   * through to "No chart yet" — the same thing a symbol with NO recorded prices shows. One observation is not no
   * observations, and the chart says which by drawing the point and captioning it below.
   */
  const hasSeries = series.length > 0;
  /** Exactly one reading: a point, never a trend, and never candles — a single candle drawn wide reads as a range. */
  const lone = series.length === 1;
  // From the window's first open, so the change covers the whole range its label names.
  const seriesPct = hasSeries ? ((series.at(-1)!.close - series[0]!.open) / series[0]!.open) * 100 : 0;

  const quote = spotRead.data ?? undefined;

  /*
   * The percentage names the window it measured.
   *
   * It said "today" whatever the pills were set to, so 1M read "up 38.4% today" — false about a
   * real asset, on the screen someone opens to decide whether to buy. The day itself now comes
   * from the quote's 24h change, the same field the market list and the search rows read, because
   * deriving it a second way from the candles is what made one asset show 2.1% here and 2.55%
   * there at the same moment.
   */
  const { pct: changePct, label: rangeLabel } = rangeChange(range, seriesPct, quote?.change24h);
  // The 1D figure is the quote's own 24h change where there is one; otherwise it is the series, over what it covers.
  const changeLabel =
    range === '1D' && quote?.change24h !== undefined ? rangeLabel : coveredLabel(range, rangeLabel, spans[0]?.start, (ms) => when(ms));
  const up = changePct >= 0;
  // The line keeps the colour of the range it draws, the kept one included.
  const lineUp = drawn ? rangeChange(drawn.range, seriesPct, quote?.change24h).pct >= 0 : up;

  /*
   * Your fills of this token, marked where they happened (FEATURES.md #9), from the executor's record of every run —
   * manual buys and sales included. Signed out there are none to ask for. A read that fails leaves the chart unmarked
   * and says nothing: an unmarked chart is not a claim that nothing filled, and the price is still worth showing.
   */
  const runs = useAsync(() => system.runs(RUNS_WINDOW), []);
  const fills = useMemo(() => fillsOf(runs.data ?? [], settlementSymbol(symbol ?? '')), [runs.data, symbol]);
  const onLine = useMemo(() => lineMarks(fills, line.times), [fills, line]);
  const inCandles = useMemo(() => candleMarks(fills, spans), [fills, spans]);

  /*
   * The fills under the chart (FEATURES.md #77): exactly the ones the chart in view drew, each with its recorded time,
   * price and venue, so a reader can see where every mark came from without having to find it with a finger. The note
   * under them keeps an unmarked stretch from reading as a quiet one: a read that failed, or a capped page of runs
   * that stops short of this range's start, is said out loud.
   */
  const candlesShown = candleView && !lone;
  const marked: readonly MarkedFill[] = candlesShown ? inCandles : onLine;
  const listed = useMemo(() => listedFills(marked, LISTED_FILLS), [marked]);
  const runsUnread = runs.error !== undefined && !(runs.error instanceof NotSignedIn);
  const fillsNote = chartFillsNote({
    unread: runsUnread,
    knownFrom: runs.data ? fillsKnownFrom(runs.data, RUNS_WINDOW) : null,
    windowStart: hasSeries ? line.times[0] : undefined,
    marked: marked.length,
    ofToken: fills.length,
  });

  /*
   * The corporate action this share has queued, off its own mint.
   *
   * A Token-2022 Scaled UI multiplier change IS the split or the dividend — the issuer publishes
   * the new multiplier and the moment it starts applying, and the chain carries both until then.
   * There is no vendor calendar involved and nothing anybody typed in, which is why this can be on
   * the screen at all: the agent's first version of this feature shipped a hardcoded list of
   * invented dates, and that is not something to show a person next to their money.
   *
   * A failure is left to the strip to word. The price and the chart are still worth showing, and
   * "we could not check" is a different sentence from "nothing is coming".
   */
  const corporate = useAsync(
    () =>
      api.get<CorporateActionNotice>(
        `/market/corporate-action?symbol=${encodeURIComponent(symbol ?? '')}`,
      ),
    [symbol],
  );
  /*
   * A minute is the right tick for this: the strip counts in hours and days, so a faster clock
   * would be a wakeup a second for a number that moves hourly.
   */
  const now = useNow();
  const action = actionSentence(corporate.data, now);

  /*
   * The same asset, priced a second way.
   *
   * Every number in this app came from one feed, and one feed is one point of being wrong.
   * The on-chain spot price is derived from the liquidity a fill would actually go through,
   * which makes it the right second opinion rather than just another API: when the two
   * disagree, the one that decides what a trade costs is the on-chain one.
   */
  const cross = useAsync(
    () =>
      api.get<{ agree: boolean; note: string }>(
        `/market/crosscheck?symbol=${encodeURIComponent(symbol ?? '')}`,
      ),
    [symbol],
  );

  // The hero reads live SPOT, not the last candle close — a candle series is a history and
  // the number at the top of this screen is a price.
  const spot = quote && quote.price > 0 ? quote.price : undefined;

  /*
   * Still arriving, in any of the ways it can be.
   *
   * The screen only knew "have data" and "have none", so during the very first fetch it said
   * "No live price for this market" and "No chart for this market yet" — a confident claim
   * about a market it had not finished asking about. Loading, warming and empty are different
   * states and only the last one is news; a warming answer is asked again by `useLiveRead`.
   */
  const priceLoading = spotRead.loading && spotRead.data === undefined;
  const historyLoading = history.loading && !current;

  /*
   * Asked of the executor, like the order ticket. A Buy button that leads to a ticket the chain
   * cannot settle is the same lie one screen earlier.
   */
  // 'checking' is rendered, not guessed through — see useSettleable.
  const settleable = useSettleable(symbol ?? '');
  const tradable = settleable !== 'no';

  return (
    <Screen gutter="none" sheet>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: space.gutter,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10, flex: 1 }}>
          <BackButton onPress={() => goBack()} />
          {/*
            The mark does not depend on the instrument being in a market class.

            It used to: `i ? <AssetMark …>` meant the header was bare for anything the market list
            does not carry — including WETH, which was the app's own default buy, sat on Home and in
            Holdings wearing its real logo, and lost it on the one screen dedicated to it. The
            instrument only ever supplied two gradient colours, and `assetGradient` derives those
            from the symbol, so there is nothing to wait for.
          */}
          <AssetMark
            gradient={inst.data ? { c1: inst.data.c1, c2: inst.data.c2 } : assetGradient(symbol ?? '')}
            {...logo}
            size={26}
          />
          <Text variant="cardTitleLg" numberOfLines={1}>
            {inst.data?.name ?? symbol}
          </Text>
        </View>
      </View>

      {/*
        Everything between the header and the footer scrolls.
        The design canvas is 874 tall and an iPhone SE is 667. Price, chart, range pills, the
        chart-type control, the position rows and the note come to more than that, so on a short
        device the bottom of it was simply unreachable — `Fill` anchors height, it does not give
        you a way to reach what overflows. The Sell/Buy pair stays pinned outside, because the
        action must not scroll away.
      */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: space.s14 }}
        showsVerticalScrollIndicator={false}
      >
      <View style={{ alignItems: 'center', marginTop: space.s22, gap: space.s6 }}>
        {spotRead.error ? (
          <ErrorState error={spotRead.error} onRetry={spotRead.reload} />
        ) : (
          <>
            {/* The price rolls in when it first arrives; live ticks after that change in place. */}
            {spot !== undefined ? (
              <RollingNumber value={fmtPrice(spot)} variant="priceLg" figure="market" />
            ) : priceLoading ? (
              <Placeholder width={150} height={34} style={{ borderRadius: radius.tile }} />
            ) : (
              <Price variant="priceLg" color={colors.ink55} figure="market">
                —
              </Price>
            )}
            <View style={{ minHeight: CHANGE_LINE_H, alignItems: 'center', justifyContent: 'center' }}>
              {current && hasSeries ? (
                <DeltaChip
                  label={`${movePhrase(changePct)} ${changeLabel}`}
                  // One decimal, as the label's own figure is: a chip that says "flat" must not be drawn red.
                  tone={pnlTone(changePct, 1)}
                  style={{ alignSelf: 'center' }}
                />
              ) : priceLoading || historyLoading ? (
                <Text variant="body" color={colors.ink55}>
                  Loading…
                </Text>
              ) : spot === undefined ? (
                // One quiet line, not a warning tag beside it saying the same thing again.
                <Text variant="body" color={colors.ink55}>
                  No price feed.
                </Text>
              ) : null}
            </View>
          </>
        )}

        {/*
          A second opinion, from the pools a fill would actually touch.

          Shown only when it DISAGREES. A line saying "two sources agree" on every asset every
          day is noise that trains people to stop reading — the whole value is that it appears
          when something is wrong, and the number the executor would trade at is the one that
          matters when they diverge.
        */}
        {cross.data && !cross.data.agree ? (
          <Text
            variant="secondarySm"
            color={colors.warn}
            align="center"
            style={{ marginTop: space.s6, paddingHorizontal: space.gutter }}
          >
            {cross.data.note}
          </Text>
        ) : null}
      </View>

      {/*
        What is about to happen to this holding, when the chain has already said.

        Above the chart rather than below the position rows: a change that restates every unit and
        every price is context for the whole screen, and a candle series drawn across the effective
        timestamp means two different things either side of it. Nothing renders when nothing is
        queued — a strip announcing the absence of a split on every asset every day is noise, and
        the value here is that it appears only when there is something to know.
      */}
      {action ? (
        <NoteStrip kind={action.kind} style={{ marginTop: space.s12, marginHorizontal: space.gutter }}>
          {action.text}
        </NoteStrip>
      ) : null}

      {/*
        The chart type, visibly — and now the only way to change it.

        Both charts have been here since the beginning and the only way to swap them was to tap the
        chart itself — an affordance with nothing on screen to suggest it existed. That tap is gone:
        a finger on the line scrubs it (FEATURES.md #45), and a chart that turned itself into candles
        when someone touched it to read a price would take the reading away.

        Above the chart rather than beside the range pills, which is where it went first: the range
        pills and a two-word control do not fit one 402pt row, and what that shipped was "All"
        sliced in half by the control's left edge. They also answer different questions — the pills
        pick a period, this picks a rendering — and the one that belongs to the chart sits with it.

        It stays while a series is on its way, so the chart below does not jump when it lands.
      */}
      {hasSeries || history.loading ? (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'flex-end',
            marginTop: space.s12,
            paddingHorizontal: space.gutter,
          }}
        >
          <Segmented
            options={CHART_VIEWS}
            value={candleView ? 0 : 1}
            onChange={(v) => setCandleView(v === 0)}
            height={size.segThumbSm}
            /*
             * An explicit width, because `Segmented` has no intrinsic one: design.md §5 gives the
             * thumb `flex: 1`, which is right for the full-width control it usually is and means
             * that anywhere else it collapses to its own 4pt padding — which is exactly what
             * shipped first, a two-pixel white sliver against the bezel.
             */
            style={{ width: CHART_VIEW_W }}
          />
        </View>
      ) : null}

      {/* One box for every state the chart can be in, so none of them moves the pills below. */}
      <View
        style={{
          minHeight: CHART_H,
          marginTop: space.s10,
          paddingHorizontal: space.gutter,
          justifyContent: 'center',
        }}
      >
        {hasSeries && drawn ? (
          candleView && !lone ? (
            <Candlestick
              series={series}
              projection={tightProjection(series, inCandles.map((m) => m.price))}
              marks={inCandles}
              seriesKey={`${symbol}:${drawn.range}`}
              pending={pending}
              height={CHART_H}
              lastPrice={{ value: series.at(-1)!.close, label: fmtPrice(series.at(-1)!.close) }}
              drawIn
            />
          ) : (
            <AreaChart
              data={line.values}
              times={line.times}
              formatValue={fmtPrice}
              figure="market"
              marks={onLine}
              seriesKey={`${symbol}:${drawn.range}`}
              pending={pending}
              height={CHART_H}
              color={lineUp ? colors.up : colors.down}
              endDot
              drawIn
            />
          )
        ) : history.error ? (
          // The pills stay below it, so another range is still one tap away.
          <ErrorState error={history.error} onRetry={history.reload} />
        ) : history.loading ? (
          <Placeholder height={CHART_H} style={{ borderRadius: radius.tile }} />
        ) : spot !== undefined ? (
          <Text variant="body" color={colors.ink55} align="center">
            No chart yet.
          </Text>
        ) : null}
      </View>

      {/*
        A lone reading says so. The point above is real and is drawn, but one observation has no direction, and a
        chart that leaves the reader to infer a trend from a single dot has only moved the guess rather than removed it.
      */}
      {hasSeries && lone ? (
        <Text variant="footnote" color={colors.ink45} align="center" style={{ marginTop: space.s8 }}>
          One reading in this range. There is no trend to draw until there is a second.
        </Text>
      ) : null}

      <PillRow style={{ marginTop: space.s16 }} contentPadding={space.gutter}>
        {RANGES.map((r) => (
          <Pill key={r} label={r} selected={r === range} onPress={() => setRange(r)} />
        ))}
      </PillRow>

      {/*
        Where the chart's marks came from, one row per fill, newest first. Each opens its run, where the signature and
        the venue's full meaning are. The venue is named by `markDetail`, so a venue-vault settlement reads as the
        vault and is never called a swap. Nothing is listed that the chart did not draw.
      */}
      {hasSeries && drawn && (listed.shown.length > 0 || fillsNote !== null) ? (
        <View style={{ marginTop: space.s14, paddingHorizontal: space.gutter }}>
          {listed.shown.length > 0 ? (
            <Text variant="secondarySm" color={colors.ink55} style={{ marginBottom: space.s4 }}>
              {candlesShown ? 'Your fills on these candles' : 'Your fills on this line'}
            </Text>
          ) : null}
          {listed.shown.map((m, i) => {
            const detail = markDetail(m);
            return (
              <Row
                key={m.id ?? `${m.at}:${m.side}:${m.price}`}
                title={`${detail.action} at ${fmtPrice(m.price)}`}
                secondary={`${when(m.at)} · ${detail.venue}`}
                figure="market"
                height={ROW_H}
                divider={i < listed.shown.length - 1}
                onPress={m.id === undefined ? undefined : () => router.push(`/runs/${m.id}`)}
              />
            );
          })}
          {listed.more > 0 ? (
            <Text variant="footnote" color={colors.ink45} style={{ marginTop: space.s6 }}>
              {`${listed.more} earlier ${listed.more === 1 ? 'fill is' : 'fills are'} marked on the chart but not listed.`}
            </Text>
          ) : null}
          {fillsNote?.kind === 'unread' ? (
            // Not "no fills": the record did not answer, so this chart cannot say either way.
            <Press
              onPress={runs.reload}
              accessibilityRole="button"
              accessibilityLabel="Read your fills again"
              hitHeight={size.hit}
            >
              <Text variant="footnote" color={colors.ink55}>
                Your fills did not load, so none are marked. Try again ›
              </Text>
            </Press>
          ) : fillsNote?.kind === 'partial' ? (
            <Text variant="footnote" color={colors.ink45} style={{ marginTop: space.s6 }}>
              {`Only your latest ${RUNS_WINDOW} runs were read, back to ${when(fillsNote.since)}. Fills before then are not marked.`}
            </Text>
          ) : fillsNote?.kind === 'outside' ? (
            <Text variant="footnote" color={colors.ink45}>
              {`None of your ${fillsNote.count} ${fillsNote.count === 1 ? 'fill' : 'fills'} of ${symbol} ${fillsNote.count === 1 ? 'is' : 'are'} in this range.`}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={{ marginTop: space.s14, paddingHorizontal: space.gutter }}>
        {held ? (
          <>
            <Row
              title="Your position"
              value={<Price figure="units">{`${quantity(held.units)} ${symbol}`}</Price>}
              secondary={money(held.notional)}
              height={ROW_H}
            />
            {/* What was paid for one unit is a price, and says nothing of how much is held: it stays while hidden. */}
            <Row title="Avg cost" value={<Price figure="market">{fmtPrice(held.entry)}</Price>} height={ROW_H} />
            <Row
              title="Unrealised"
              value={<Price tone={pnlTone(held.unrealised)}>{signedMoney(held.unrealised)}</Price>}
              delta={percent(held.unrealisedPct)}
              deltaTone={pnlTone(held.unrealised)}
              height={ROW_H}
              divider={false}
            />
          </>
        ) : positionUnread ? (
          // Not "you hold none": the book did not answer, so this screen cannot say either way.
          <Press
            onPress={positions.reload}
            accessibilityRole="button"
            accessibilityLabel="Read your position again"
            hitHeight={size.hit}
          >
            <Text variant="secondary" color={colors.ink55}>
              Your position did not load. Try again ›
            </Text>
          </Press>
        ) : null}
      </View>
      </ScrollView>

      {/*
        A Buy button on a market this chain cannot settle is a promise the app cannot keep.
        These instruments are real markets, but nothing prices them on this build and none carries
        a price here; what does not exist is a token on this chain to route into. Saying so is better than a button that
        leads to an order ticket which can never be filled.
      */}
      <View style={{ paddingHorizontal: space.gutter }}>
        {tradable ? (
          <ButtonPair
            style={{ marginTop: space.s14 }}
            left={
              <Button
                label="Sell"
                variant="secondary"
                disabled={settleable === 'checking'}
                onPress={() => router.push(`/order/${settlementSymbol(symbol ?? '')}?side=sell`)}
              />
            }
            right={
              <Button
                label="Buy"
                disabled={settleable === 'checking'}
                onPress={() => router.push(`/order/${settlementSymbol(symbol ?? '')}?side=buy`)}
              />
            }
          />
        ) : (
          <View style={{ marginTop: space.s14, paddingVertical: space.s14, alignItems: 'center' }}>
            <Text variant="secondary" align="center">
              {/* "Here", not a chain's name: an equity trades on X Layer mainnet and its fork but not on the testnet, and no network is named off the money screens. */}
              Not tradable here
            </Text>
          </View>
        )}
      </View>
    </Screen>
  );
}
