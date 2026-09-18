/**
 * Screen 6 — Auto Close. screens.md Group B. WHITE SHEET.
 *
 * "Chart region flex:1; min-height:230px — THE CHART TAKES THE LEFTOVER HEIGHT, NOT A
 * SPACER." TP wash from the top, SL wash from the bottom, candles on the WIDE projection,
 * a mark chip, and TP/SL marker rows at their projected prices. Two control blocks
 * (stepper with a coloured value chip, then a ruler), gap 26. Cancel / Set.
 *
 * "Set" used to call `goBack()` and nothing else — the screen that exists to arm a stop
 * did not arm one, and the numbers lived in app state only, so the "stop" vanished when the
 * phone slept. It now creates a real **`exit-rules` strategy**, which is the executor's own
 * tier-3 mechanism: `planExitRules` reads `entryPrice`, `takeProfitPct`, `stopLossPct` and
 * `trailPct` from its params on every scheduler tick, maintains the trailing high-water mark
 * on the runs where nothing fires, and can only ever CLOSE. That is what makes screen 20's
 * promise ("stops and take-profits stay active") literally true.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { LayoutChangeEvent, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  Button,
  ButtonRow,
  Candlestick,
  CloseButton,
  Fill,
  LoadingRows,
  NoteStrip,
  Ruler,
  Screen,
  Stepper,
  Tag,
  Text,
  colors,
  money,
  percent,
  price as fmtPrice,
  radius,
  signIn,
  size,
  space,
  toCandles,
  toPct,
  wideProjection,
} from '@/ui';
import {
  slPnl,
  slPrice,
  slTickPct,
  tpPnl,
  tpPrice,
  tpTickPct,
} from '@/state/derived';
import { useStore } from '@/state/store';
import { repos } from '@/data';
import { useAsync } from '@/data/useAsync';
import { NotSignedIn, errorRef, errorText, isRetryable } from '@/data/apiError';
import { chartSeries } from '@/markets/series';
import { useLiveRead } from '@/markets/useLiveRead';

/** screens.md: the chart region never goes below this, and takes every spare point above it. */
const CHART_MIN = 230;
/** Half a marker chip, so the row centres on its price rather than hanging under it. */
const MARKER_OFFSET = 11;

/**
 * Trailing-stop bounds.
 *
 * The ceiling is 25% because beyond that the stop stops being a stop — it sits below almost any
 * drawdown and the position is effectively unprotected while looking protected. Half-percent steps
 * match the fixed controls above so the three read as one set of dials.
 */
const TRAIL_STEP = 0.5;
const TRAIL_MAX = 25;

export default function AutoClose() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const goBack = useGoBack();

  const position = useAsync(() => repos.portfolio.position(id!), [id]);
  const p = position.data ?? undefined;
  // TP/SL are set against the position's OWN market, on live candles. The handoff's static BTC series
  // meant a user editing a stop on an ETH position was reading a BTC chart — and until the position
  // had loaded, this still asked for BTC's. No position, no symbol, no chart.
  const symbol = p?.symbol;
  const candles = useLiveRead(
    () => (symbol ? chartSeries(symbol, '1H') : Promise.resolve(null)),
    [symbol],
    (s) => s?.feed === 'warming',
  );
  // `[o,h,l,c]` on the wire, named fields in the chart set. Memoised off the answer rather than off a
  // `?? []` default, which is a fresh array on every render.
  const bars = candles.data?.symbol === symbol ? candles.data?.bars : undefined;
  const series = useMemo(() => toCandles(bars ?? []), [bars]);

  const tp = useStore((s) => s.tp);
  const sl = useStore((s) => s.sl);
  const bumpTp = useStore((s) => s.bumpTp);
  const bumpSl = useStore((s) => s.bumpSl);
  const setTp = useStore((s) => s.setTp);
  const setSl = useStore((s) => s.setSl);

  /*
   * The trailing stop, which the executor has always been able to run.
   *
   * `planExitRules` reads `trailPct`, `observationFor` maintains the high-water mark on every tick
   * — including the runs where nothing fires, which is most of them and exactly when trailing has
   * to happen — and both are covered by tests. Nothing in the app could ever set it, so the one
   * exit people actually ask for existed in full and was unreachable.
   *
   * Off by default and off is a real value: a trailing stop is not strictly better than a fixed
   * one, and turning it on for everybody would change what existing positions do.
   */
  const [trail, setTrail] = useState(0);

  const [chartH, setChartH] = useState(CHART_MIN);
  const [rulerW, setRulerW] = useState(300);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  /*
   * Show what is already armed rather than the app's last local guess. An exit rule is an `exit-rules`
   * strategy on this symbol that is running: `live`, or `watch` where nothing can trade.
   *
   * Only `live` counted, so a watched rule never showed here and Set armed a second one beside it —
   * while Portfolio, which reads both states, drew the old one.
   */
  const strategies = useAsync(() => repos.strategies.list(), []);
  const armed = (strategies.data ?? []).find(
    (st) =>
      st.kind === 'exit-rules' && st.symbol === symbol && (st.state === 'live' || st.state === 'watch'),
  );
  const armedParams = (armed?.params ?? {}) as {
    takeProfitPct?: number;
    stopLossPct?: number;
    trailPct?: number;
  };
  const armedTrail = armedParams.trailPct;
  const armedTp = armedParams.takeProfitPct;
  const armedSl = armedParams.stopLossPct == null ? undefined : -Math.abs(armedParams.stopLossPct);

  /*
   * Seed the steppers from the rule that is actually armed, once it arrives.
   *
   * The take-profit and stop-loss live in the store, which is an external system — writing to it
   * on arrival is what an effect is for. `trail` is this component's own `useState`, and seeding
   * THAT from an effect is the cascading render `react-hooks/set-state-in-effect` exists to catch:
   * it was the repository's only failing lint. Adjusting local state during render, guarded by the
   * value it was seeded from, is React's documented answer and renders once instead of twice.
   *
   * `setTrail` was also missing from the dependency list while `setTp` and `setSl` were in it —
   * moot now that it is out of the effect entirely.
   */
  useEffect(() => {
    if (armedTp !== undefined && Number.isFinite(armedTp)) setTp(armedTp);
    if (armedSl !== undefined && Number.isFinite(armedSl)) setSl(armedSl);
  }, [armedTp, armedSl, setTp, setSl]);

  const [seededTrail, setSeededTrail] = useState<number>();
  if (armedTrail !== undefined && Number.isFinite(armedTrail) && armedTrail !== seededTrail) {
    setSeededTrail(armedTrail);
    setTrail(armedTrail);
  }

  /**
   * The steppers edit inside state.md's manual range (TP 0.5–3.0, SL −3.0 to −0.5). A rule
   * the ENTRY agent armed is derived from its own proposed stop and target, so it can sit
   * outside that range — and `setTp`/`setSl` clamp it on the way in.
   *
   * Which means the steppers can show a number that is not the rule that is running. That
   * is exactly the kind of quiet misstatement this screen must not make, so when the two
   * disagree the armed rule is stated in full, and the CTA says it will replace it.
   */
  const clamped =
    (armedTp !== undefined && Math.abs(armedTp - tp) > 0.001) ||
    (armedSl !== undefined && Math.abs(armedSl - sl) > 0.001);

  /*
   * Take profit and stop loss are distances from what was paid, because that is what the saved rule measures.
   *
   * `planExitRules` sells when the mark is `takeProfitPct` above `entryPrice` or `stopLossPct` below it,
   * and Portfolio draws the same rule from the entry. This screen drew its markers, its prices and its
   * "Make / lose" from the live mark instead, and saved the entry — so on a position already up 4%, the
   * take profit on screen sat 1% above today's price while the rule it saved would sell on the next run.
   */
  const entry = p && p.entry > 0 ? p.entry : undefined;
  const tpP = entry === undefined ? undefined : tpPrice(tp, entry);
  const slP = entry === undefined ? undefined : slPrice(sl, entry);
  // What the holding cost, so "make" and "lose" are against what was paid too — not a fixed $2,500 notional.
  const costBasis = p && entry !== undefined ? p.units * entry : 0;
  // A trailing stop follows the high from the moment it is set, so its starting point IS the live price.
  const mark = p && p.mark > 0 ? p.mark : series.length ? series[series.length - 1]!.close : undefined;
  // The WIDE projection — its bounds follow TP/SL so both markers stay in frame.
  const proj =
    series.length && tpP !== undefined && slP !== undefined ? wideProjection(series, tpP, slP) : null;
  // A trailing stop with no price to start from would be saved without its trail. It is not offered.
  const trailUnpriced = trail > 0 && mark === undefined;

  async function save() {
    if (!id || !symbol || entry === undefined || trailUnpriced) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      if (armed) await repos.strategies.end(armed.id);
      await repos.strategies.create({
        kind: 'exit-rules',
        state: 'live',
        label: `Exit ${symbol} at ${percent(tp)} / ${percent(sl)}`,
        symbol,
        // `planExitRules` sizes itself by looking at the holding, so it commits no daily
        // allowance — a stop that ate into the cap would be a stop the cap could silence.
        params: {
          entryPrice: entry,
          takeProfitPct: tp,
          stopLossPct: Math.abs(sl),
          /*
           * Omitted entirely when off, rather than sent as 0.
           *
           * `planExitRules` treats `trailPct > 0` as "configured", so a zero is already inert —
           * but a param that is present and meaningless is the kind of thing a later reader
           * trusts. Absent says what it means.
           */
          ...(trail > 0 && mark !== undefined ? { trailPct: trail, peakPrice: mark } : {}),
        },
        cadence: 'daily',
        dailyAllocationUsd: 0,
      });
      goBack();
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text variant="sheetTitle" color={colors.sheet.ink}>
        Auto Close
      </Text>
      <CloseButton onPress={() => goBack()} light />
    </View>
  );

  /*
   * No position, no stop to arm — and a failed read is not "no position".
   *
   * The screen rendered its whole ticket for an id that resolves to nothing: `symbol` fell back
   * to `'BTC'` and `notional` to 0, so it drew a live BTC chart with working steppers and an
   * enabled Set — and Set creates a real `exit-rules` strategy. Arming a stop on a holding the
   * user does not have, from a screen reached by a stale link, a closed position or a mistyped
   * URL. `/position/:id` already answers this correctly; this one is reached the same ways.
   *
   * Only the route's own "not found" says the position is gone. An outage or a signed-out visit said
   * it too, to someone holding the position.
   */
  if (position.error) {
    return (
      <Screen light gutter="sheet">
        {header}
        <SheetFailure error={position.error} onRetry={position.reload} />
      </Screen>
    );
  }
  if (position.data === null) {
    return (
      <Screen light gutter="sheet">
        {header}
        <SheetNote text="This position is no longer open." />
      </Screen>
    );
  }
  if (!p) {
    return (
      <Screen light gutter="sheet">
        {header}
        <LoadingRows count={3} height={size.row} />
      </Screen>
    );
  }
  if (entry === undefined) {
    // The rule measures from the entry, and `planExitRules` does nothing without one.
    return (
      <Screen light gutter="sheet">
        {header}
        <SheetNote text={`No cost is on record for this ${p.symbol}, so there is nothing to measure a stop from.`} />
      </Screen>
    );
  }

  return (
    <Screen light gutter="sheet">
      {header}

      {/* THE LAYOUT LAW: flex:1 goes to the chart, never to a spacer. */}
      <Fill style={{ minHeight: CHART_MIN, marginTop: space.s18 }}>
        {!proj ? (
          candles.error ? (
            <SheetFailure error={candles.error} onRetry={candles.reload} />
          ) : candles.loading ? (
            <LoadingRows count={3} height={size.row} />
          ) : (
            // The rule stands without a chart: it measures from the entry, not from these candles.
            <SheetNote text={`No chart for ${p.symbol} right now.`} />
          )
        ) : (
          <View
            style={{ flex: 1, position: 'relative' }}
            onLayout={(e: LayoutChangeEvent) => setChartH(e.nativeEvent.layout.height)}
          >
            {/* TP wash from the top down to TP. */}
            <View
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                height: `${toPct(proj, tpP!)}%`,
                backgroundColor: colors.tpZone,
              }}
            />
            {/* SL wash from SL down to the bottom. */}
            <View
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: `${100 - toPct(proj, slP!)}%`,
                backgroundColor: colors.slZone,
              }}
            />
            <Candlestick
              series={series}
              projection={proj}
              height={chartH}
              light
              lastPrice={{ value: series[series.length - 1]!.close, label: fmtPrice(series[series.length - 1]!.close) }}
              lastPriceSide="left"
            />

            <MarkerRow
              topPct={toPct(proj, tpP!)}
              height={chartH}
              label="Take Profit"
              price={fmtPrice(tpP!)}
              color={colors.candleUp}
            />
            <MarkerRow
              topPct={toPct(proj, slP!)}
              height={chartH}
              label="Stop Loss"
              price={fmtPrice(slP!)}
              color={colors.candleDown}
            />
          </View>
        )}
      </Fill>

      <View
        style={{ gap: space.s26, marginTop: space.s20 }}
        onLayout={(e) => setRulerW(e.nativeEvent.layout.width)}
      >
        <ControlBlock
          label="Take Profit"
          value={percent(tp)}
          tone="tp"
          chipColor={colors.candleUp}
          onDec={() => bumpTp(-1)}
          onInc={() => bumpTp(1)}
          tickPct={tpTickPct(tp)}
          rulerW={rulerW}
        />
        <ControlBlock
          label="Stop Loss"
          value={percent(sl)}
          tone="sl"
          chipColor={colors.candleDown}
          onDec={() => bumpSl(-1)}
          onInc={() => bumpSl(1)}
          tickPct={slTickPct(sl)}
          rulerW={rulerW}
        />
        <ControlBlock
          label="Trailing Stop"
          value={trail > 0 ? `${percent(trail).replace('+', '')} below the high` : 'Off'}
          tone="sl"
          chipColor={trail > 0 ? colors.candleDown : colors.ink35}
          onDec={() => setTrail((t) => Math.max(0, Math.round((t - TRAIL_STEP) * 10) / 10))}
          onInc={() => setTrail((t) => Math.min(TRAIL_MAX, Math.round((t + TRAIL_STEP) * 10) / 10))}
          tickPct={(trail / TRAIL_MAX) * 100}
          rulerW={rulerW}
        />
      </View>

      {trail > 0 && mark !== undefined ? (
        <NoteStrip kind="acted" style={{ marginTop: space.s16 }}>
          {`Sells if ${p.symbol} falls ${percent(trail).replace('+', '')} from its high after this is set: ${fmtPrice(mark * (1 - trail / 100))} at today’s price.`}
        </NoteStrip>
      ) : null}

      {clamped ? (
        <NoteStrip kind="risk" style={{ marginTop: space.s16 }}>
          {`An agent set this at ${armedTp !== undefined ? percent(armedTp) : 'no take profit'} / ${armedSl !== undefined ? percent(armedSl) : 'no stop'}, outside the hand range. Yours replaces it.`}
        </NoteStrip>
      ) : null}

      {saveError ? (
        <Text
          variant="footnote"
          color={colors.candleDown}
          align="center"
          style={{ marginTop: space.s12 }}
        >
          {saveError}
        </Text>
      ) : null}

      <ButtonRow
        style={{ marginTop: space.s22 }}
        secondary={
          <Button
            label="Cancel"
            backgroundColor={colors.cancelBg}
            color={colors.cancelInk}
            onPress={() => goBack()}
          />
        }
        primary={
          <Button
            label={clamped ? 'Replace' : 'Set'}
            backgroundColor={colors.candleUp}
            color={colors.ink}
            loading={saving}
            disabled={trailUnpriced}
            onPress={save}
          />
        }
      />

      {/* What the holding would make or lose is the person's money: both spans hide while balances are hidden. */}
      <Text
        variant="footnote"
        color={colors.sheet.dim}
        align="center"
        style={{ marginTop: space.s12 }}
        figure="own"
      >
        Make{' '}
        <Text variant="footnote" color={colors.candleUp}>
          {money(tpPnl(tp, costBasis))}
        </Text>{' '}
        at TP or lose{' '}
        <Text variant="footnote" color={colors.candleDown}>
          {money(slPnl(sl, costBasis))}
        </Text>{' '}
        at SL
      </Text>
    </Screen>
  );
}

/**
 * A line in the sheet's own ink.
 *
 * `EmptyState` and `ErrorState` draw for the black screens, in white — so on this white sheet "This
 * position is no longer open" was printed white on white, and nobody could read why nothing was there.
 */
function SheetNote({ text }: { text: string }) {
  return (
    <View style={{ paddingVertical: space.s30, alignItems: 'center' }}>
      <Text variant="body" color={colors.sheet.muted} align="center">
        {text}
      </Text>
    </View>
  );
}

/**
 * `ErrorState`'s rules — signed out asks for a sign-in, a server fault or a timeout carries its request's
 * reference, and only a retryable failure offers a retry — in sheet ink.
 */
function SheetFailure({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const signedOut = error instanceof NotSignedIn;
  const ref = errorRef(error);
  return (
    <View style={{ paddingVertical: space.s30, gap: space.s14, alignItems: 'center' }}>
      <Text variant="rowPrimary" color={colors.sheet.ink} align="center">
        {signedOut ? 'Sign in to see this.' : 'That did not load.'}
      </Text>
      {signedOut ? null : (
        <Text variant="secondary" color={colors.sheet.muted} align="center">
          {errorText(error)}
        </Text>
      )}
      {ref ? (
        <Text variant="footnote" color={colors.sheet.muted} selectable>
          {`Ref ${ref}`}
        </Text>
      ) : null}
      {signedOut || isRetryable(error) ? (
        <Button
          label={signedOut ? 'Sign in' : 'Try again'}
          backgroundColor={colors.cancelBg}
          color={colors.cancelInk}
          onPress={signedOut ? signIn : onRetry}
          testID={signedOut ? 'sign-in' : 'error-retry'}
        />
      ) : null}
    </View>
  );
}

/** A label chip on the left and its price on the right, both centred on the marker's price. */
function MarkerRow({
  topPct,
  height,
  label,
  price,
  color,
}: {
  topPct: number;
  height: number;
  label: string;
  price: string;
  color: string;
}) {
  const chip = { bg: color, fg: colors.ink };
  return (
    <View
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        left: 0,
        right: 0,
        top: (topPct / 100) * height - MARKER_OFFSET,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <Tag label={label} small sentence colors={chip} radius={radius.tile} />
      <Tag label={price} small sentence colors={chip} radius={radius.tile} />
    </View>
  );
}

function ControlBlock({
  label,
  value,
  tone,
  chipColor,
  onDec,
  onInc,
  tickPct,
  rulerW,
}: {
  label: string;
  value: string;
  tone: 'tp' | 'sl';
  chipColor: string;
  onDec: () => void;
  onInc: () => void;
  tickPct: number;
  rulerW: number;
}) {
  return (
    <View style={{ gap: space.s10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="rowPrimary" color={colors.sheet.ink}>
          {label}
        </Text>
        <Stepper
          value={value}
          onDecrement={onDec}
          onIncrement={onInc}
          light
          chip={{ bg: chipColor, fg: colors.ink }}
          valueMinWidth={72}
        />
      </View>
      {/* `tickPct` is state.md's 0–100 derivation; `Ruler` takes 0–1. */}
      <Ruler position={tickPct / 100} tone={tone} style={{ width: rulerW }} />
    </View>
  );
}
