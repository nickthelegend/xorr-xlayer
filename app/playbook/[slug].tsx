/**
 * One strategy from the book, with everything that was measured about it.
 *
 * The reference for this screen was a TradingKit report the owner sent over — equity curve, KPI blocks,
 * returns table, profit structure, risk-adjusted panel, win/loss split, P&L distribution and a trade list.
 * The depth is worth copying. The numbers on it were not: the research repo's own
 * `docs/15-THE-TRADINGKIT-TRADE-LIST.md` catches the same trade exiting at two different prices, and a
 * +19,972% curve next to a −2.24% drawdown is not a result, it is a bug rendered confidently.
 *
 * So this is that report drawn over measurements this project can stand behind. Two years of hourly
 * candles, nine symbols, split in half, 6 bps a side, flat unlevered sizing — and the half the rule never
 * saw is what the screen leads with.
 *
 * What it will not do:
 *
 *   - Fill a field. No trades means no win rate, no profit factor and no distribution, and the screen says
 *     so in a sentence instead of drawing an empty chart with zeros under it.
 *   - Headline a number that cannot carry the weight. Under 30 unseen trades the return is real and the
 *     interval around it is wide, and the screen says that where the number is, not in a footnote.
 *   - Let the profit structure imply arithmetic that does not hold. Gross, costs and net add up here
 *     because the export builds them from one source; the assertion lives in `catalog.test.ts`.
 */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useGoBack } from '@/nav/useGoBack';
import {
  AreaChart,
  ErrorState,
  Ring,
  Fill,
  HeaderBar,
  Placeholder,
  Price,
  Screen,
  SheetCard,
  Tag,
  Text,
  colors,
  pnlTone,
  radius,
  space,
} from '@/ui';
import { money, percent, ratio } from '@/format';
import { useAsync } from '@/data/useAsync';
import { system } from '@/data/system';
import { TIER_MEANS, type StrategyDetail, type StrategyTier } from '@/data/strategyBook';

const CHART_H = 168;
const DIST_H = 96;

const TIER_TONE: Record<StrategyTier, 'up' | 'neutral' | 'warn'> = {
  verified: 'up',
  measured: 'neutral',
  archive: 'warn',
};

/**
 * The strategy's own description, when it has one worth showing.
 *
 * A hundred of the 313 carry a docstring whose first line is just the slug and a colon — `b200_sess_8:` — and
 * forty-five carry none at all. Rendering those put a line under the tier that said the name of the thing you
 * were already looking at. The first line that is neither empty nor the slug again, or nothing.
 */
function describe(doc: string, slug: string): string | null {
  const bare = (t: string) => t.replace(/[^a-z0-9]/gi, '').toLowerCase();
  for (const line of doc.split('\n')) {
    const t = line.trim();
    if (t && bare(t) !== bare(slug)) return t;
  }
  return null;
}

/**
 * Why the gauntlet turned a strategy down, in words.
 *
 * `failed_on` is the research engine's own shorthand — `Sens`, `comm2x`, `Multi`, `OOS` — and the screen was
 * printing it raw: "Verdict: comm2x, unseen return <= 0". That is a note the engine wrote to itself, and it
 * was the first thing a reader saw about why a strategy is in the archive.
 *
 * Anything unrecognised passes through unchanged. A reason nobody has mapped yet is still a reason, and
 * dropping it would turn "we could not phrase this" into "there was nothing wrong".
 */
const FAILURE_WORDS: Record<string, string> = {
  OOS: 'lost money on data it had not seen',
  'unseen return <= 0': 'made nothing on data it had not seen',
  Sens: 'a small change to its settings broke it',
  comm2x: 'the edge disappears at double the cost',
  Multi: 'it did not hold on a second set of coins',
  'too few trades anywhere': 'it traded too rarely to judge',
};

function failureWords(reasons: readonly string[]): string {
  const said = reasons
    .map((r) => FAILURE_WORDS[r] ?? r.replace(/^BTC-only n=(\d+) \(judged on portfolio\)$/, 'it took only $1 trades on BTC alone, so it was judged across the portfolio'))
    .filter((r, i, all) => all.indexOf(r) === i);
  if (said.length === 0) return 'It did not pass.';
  return `${said[0]!.charAt(0).toUpperCase()}${said[0]!.slice(1)}${said.length > 1 ? `, and ${said.slice(1).join(', and ')}` : ''}.`;
}

/** A measured number, or a dash. `null` and `undefined` both mean "not measured" and read the same. */
function fig(v: number | null | undefined, render: (n: number) => string): string {
  return typeof v === 'number' && Number.isFinite(v) ? render(v) : '—';
}

/** A labelled figure. The label sits under the value, as every other panel in this app does it. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' | 'neutral' }) {
  return (
    <View style={{ flexBasis: '33%', flexGrow: 1, paddingVertical: space.s8 }}>
      {tone ? (
        <Price variant="rowPrimary" tone={tone}>
          {value}
        </Price>
      ) : (
        <Text variant="rowPrimary">{value}</Text>
      )}
      <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s4 }}>
        {label}
      </Text>
    </View>
  );
}

/** One line of a table: a name on the left, a measured value on the right. */
function Line({ label, value, tone, last }: { label: string; value: string; tone?: 'up' | 'down' | 'neutral'; last?: boolean }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: space.s10,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: colors.hairline,
      }}
    >
      <Text variant="secondary" color={colors.ink65} style={{ flexShrink: 1, paddingRight: space.s12 }}>
        {label}
      </Text>
      {tone ? (
        <Price variant="secondary" tone={tone}>
          {value}
        </Price>
      ) : (
        <Text variant="secondary">{value}</Text>
      )}
    </View>
  );
}

/**
 * Gross profit, gross loss and commission, each as a share of the largest — and the net they add to.
 *
 * Bars are drawn against the biggest absolute figure rather than against the net, so the commission bar
 * reads as what it is: a slice taken out of the gross, not a fraction of what survived it.
 */
function Structure({ s }: { s: NonNullable<StrategyDetail['structure']> }) {
  const scale = Math.max(Math.abs(s.grossProfitUsd), Math.abs(s.grossLossUsd), Math.abs(s.commissionUsd), 1);
  const bars: { label: string; value: number; color: string }[] = [
    { label: 'Gross profit', value: s.grossProfitUsd, color: colors.up },
    { label: 'Gross loss', value: s.grossLossUsd, color: colors.down },
    { label: 'Commission', value: s.commissionUsd, color: colors.warn },
  ];
  return (
    <View style={{ gap: space.s10 }}>
      {bars.map((b) => (
        <View key={b.label} style={{ flexDirection: 'row', alignItems: 'center', gap: space.s10 }}>
          <Text variant="secondarySm" color={colors.ink65} style={{ width: 96 }}>
            {b.label}
          </Text>
          <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.hairline }}>
            <View
              style={{
                width: `${Math.min(100, (Math.abs(b.value) / scale) * 100)}%`,
                height: 8,
                borderRadius: 4,
                backgroundColor: b.color,
              }}
            />
          </View>
          <Text variant="secondarySm" style={{ width: 78, textAlign: 'right' }}>
            {money(b.value)}
          </Text>
        </View>
      ))}
      <Line label="Net" value={money(s.netPnlUsd)} tone={pnlTone(s.netPnlUsd)} last />
    </View>
  );
}

/** How the per-trade results were spread. The tallest bar sets the height; the counts are printed. */
function Distribution({ bins }: { bins: StrategyDetail['distribution'] }) {
  const tallest = Math.max(...bins.map((b) => b.count), 1);
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: DIST_H, gap: 3 }}>
        {bins.map((b, i) => (
          <View
            key={`${b.from}-${i}`}
            style={{
              flex: 1,
              height: Math.max(2, (b.count / tallest) * DIST_H),
              borderRadius: 2,
              backgroundColor: b.to <= 0 ? colors.down : colors.up,
              opacity: b.count === 0 ? 0.25 : 1,
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.s8 }}>
        <Text variant="footnote" color={colors.ink55}>
          {percent(bins[0]!.from, { digits: 1 })}
        </Text>
        <Text variant="footnote" color={colors.ink55}>
          {percent(bins.at(-1)!.to, { digits: 1 })}
        </Text>
      </View>
    </View>
  );
}

export default function StrategyReport() {
  const goBack = useGoBack();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { data, loading, error, reload } = useAsync(() => system.strategyDetail(slug!), [slug]);

  const u = data?.unseen;
  const traded = (u?.trades ?? 0) > 0;
  const tone = pnlTone(u?.returnPct ?? 0);

  return (
    <Screen>
      <HeaderBar onBack={goBack} title={<Text variant="screenTitle">{slug}</Text>} />
      <Fill>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !data ? (
          <View style={{ paddingHorizontal: space.gutter, gap: space.s12 }}>
            <Placeholder height={CHART_H} />
            <Placeholder height={120} />
          </View>
        ) : !data || !u ? null : (
          <ScrollView contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.s30, gap: space.s12 }}>
            {/* What it is, and what the tier claims. The tier is derived from evidence, never assigned. */}
            <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8, flexWrap: 'wrap' }}>
                <Tag tone={TIER_TONE[data.tier]} label={data.tier.toUpperCase()} />
                {/* Only when it traded at all: beside "it took no trades", a thin-sample warning is the same news twice. */}
                {data.trusted || u.trades === 0 ? null : (
                  <Tag tone="warn" label={`UNDER ${data.trustedMinTrades} TRADES`} />
                )}
              </View>
              <Text variant="secondary" color={colors.ink65} style={{ marginTop: space.s10 }}>
                {TIER_MEANS[data.tier]}
              </Text>
              {describe(data.doc, data.slug) ? (
                <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s10 }}>
                  {describe(data.doc, data.slug)}
                </Text>
              ) : null}
            </SheetCard>

            {/* The headline: the half the rule never saw. */}
            <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
              <Text variant="footnote" color={colors.ink55}>
                RETURN ON UNSEEN DATA
              </Text>
              <Price variant="screenTitle" tone={tone} style={{ marginTop: space.s6 }}>
                {fig(u.returnPct, (n) => percent(n, { digits: 2 }))}
              </Price>
              {/*
                The money beside the percentage. They are the same fact — the book starts every strategy at $100, so
                a +2.34% return IS $2.34 — and a reader looking for "what did it make" should not have to do the
                arithmetic to find out. It comes from the structure, which is the one place the costs are all in.
              */}
              {data.structure ? (
                <Price variant="rowPrimary" tone={pnlTone(data.structure.netPnlUsd)} style={{ marginTop: space.s6 }}>
                  {money(data.structure.netPnlUsd)}
                </Price>
              ) : null}
              <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s6 }}>
                {traded
                  ? `${u.trades} trades it had never seen · ${fig(data.known.returnPct, (n) => percent(n, { digits: 2 }))} on the half it was built from`
                  : 'It took no trades on the unseen half, so there is nothing to report here.'}
              </Text>
              {!traded || data.trusted ? null : (
                <Text variant="secondarySm" color={colors.warn} style={{ marginTop: space.s8 }}>
                  {u.trades} trades is a thin sample. The number is real; the range around it is wide.
                </Text>
              )}
            </SheetCard>

            {traded && data.equityCurve.length > 1 ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
                <Text variant="footnote" color={colors.ink55} style={{ marginBottom: space.s10 }}>
                  EQUITY, UNSEEN HALF
                </Text>
                <AreaChart
                  data={data.equityCurve}
                  height={CHART_H}
                  color={tone === 'up' ? colors.up : tone === 'down' ? colors.down : colors.ink55}
                  grid
                  endDot
                  formatValue={(v) => percent(v - 100, { digits: 2 })}
                  figure="market"
                  accessibilityLabel={`Equity over the unseen half, ${fig(u.returnPct, (n) => percent(n, { digits: 2 }))}`}
                />
                <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
                  Indexed to 100 at the start of the unseen half.
                </Text>
              </SheetCard>
            ) : null}

            {/* Both halves, side by side. Hiding the in-sample number is how a fitted rule passes for a real one. */}
            <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
              <Text variant="footnote" color={colors.ink55} style={{ marginBottom: space.s4 }}>
                BOTH HALVES
              </Text>
              <Line label="Return · unseen" value={fig(u.returnPct, (n) => percent(n, { digits: 2 }))} tone={tone} />
              <Line
                label="Return · the half it was built from"
                value={fig(data.known.returnPct, (n) => percent(n, { digits: 2 }))}
                tone={pnlTone(data.known.returnPct ?? 0)}
              />
              <Line label="Trades · unseen" value={String(u.trades)} />
              <Line label="Trades · built from" value={String(data.known.trades)} />
              <Line label="Win rate" value={fig(u.winRate, (n) => percent(n, { digits: 1, explicitSign: false }))} />
              <Line label="Profit factor" value={fig(u.profitFactor, (n) => ratio(n))} />
              <Line label="Expectancy per trade" value={fig(u.expectancyR, (n) => `${ratio(n, 4)} R`)} last />
            </SheetCard>

            {data.structure ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
                <Text variant="footnote" color={colors.ink55} style={{ marginBottom: space.s12 }}>
                  WHERE THE MONEY WENT
                </Text>
                <Structure s={data.structure} />
                <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s10 }}>
                  On {money(data.window.startEquity)} of starting capital, {data.window.feeBpsPerSide} bps a side.
                </Text>
              </SheetCard>
            ) : null}

            {traded ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
                <Text variant="footnote" color={colors.ink55} style={{ marginBottom: space.s4 }}>
                  RISK
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                  <Stat label="Sharpe" value={fig(u.sharpe, (n) => ratio(n))} />
                  <Stat
                    label="Max drawdown"
                    value={fig(u.maxDrawdownPct, (n) => percent(n, { digits: 2, explicitSign: false }))}
                  />
                  <Stat label="Fees paid" value={fig(u.feesUsd, (n) => money(n, { explicitSign: false }))} />
                  <Stat
                    label="Best trade"
                    value={fig(data.extremes?.bestTradePct, (n) => percent(n, { digits: 2 }))}
                    tone="up"
                  />
                  <Stat
                    label="Worst trade"
                    value={fig(data.extremes?.worstTradePct, (n) => percent(n, { digits: 2 }))}
                    tone="down"
                  />
                  <Stat label="Avg bars held" value={fig(data.extremes?.avgBarsInTrade, (n) => ratio(n, 1))} />
                </View>
              </SheetCard>
            ) : null}

            {/*
              The win rate as a share of the whole, and the split it is a share OF.
              
              The ring is white rather than green: a win rate is not a profit. Sixty-one percent of trades won and
              the strategy can still have lost money, which is exactly why the net sits above it and the two are
              read together. The bar underneath is the same two numbers at their real proportions, because "61.4%"
              over 44 trades and over 4,400 are different claims and only the count says which this is.
            */}
            {traded && typeof u.wins === 'number' ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
                <Text variant="footnote" color={colors.ink55} style={{ marginBottom: space.s12 }}>
                  WINS AND LOSSES
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s16 }}>
                  <Ring
                    fraction={u.trades > 0 ? u.wins / u.trades : undefined}
                    value={fig(u.winRate, (n) => percent(n, { digits: 1, explicitSign: false }))}
                    label="Win rate"
                    accessibilityLabel={`Win rate, ${u.wins} of ${u.trades} trades won`}
                  />
                  <View style={{ flex: 1, gap: space.s8 }}>
                    <View style={{ flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden' }}>
                      <View style={{ flex: Math.max(u.wins, 0.0001), backgroundColor: colors.up }} />
                      <View style={{ flex: Math.max(u.trades - u.wins, 0.0001), backgroundColor: colors.down }} />
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Price variant="secondarySm" tone="up">
                        {u.wins} won
                      </Price>
                      <Price variant="secondarySm" tone="down">
                        {u.trades - u.wins} lost
                      </Price>
                    </View>
                  </View>
                </View>
              </SheetCard>
            ) : null}

            {data.sides.long || data.sides.short ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
                <Text variant="footnote" color={colors.ink55} style={{ marginBottom: space.s4 }}>
                  LONG AND SHORT
                </Text>
                {(['long', 'short'] as const).map((side) => {
                  const s = data.sides[side];
                  if (!s) return null;
                  return (
                    <Line
                      key={side}
                      label={`${side === 'long' ? 'Long' : 'Short'} · ${s.trades} trades`}
                      value={money(s.netPnlUsd)}
                      tone={pnlTone(s.netPnlUsd)}
                      last={side === 'short' || !data.sides.short}
                    />
                  );
                })}
              </SheetCard>
            ) : null}

            {data.distribution.length > 1 ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
                <Text variant="footnote" color={colors.ink55} style={{ marginBottom: space.s12 }}>
                  HOW THE TRADES CAME OUT
                </Text>
                <Distribution bins={data.distribution} />
              </SheetCard>
            ) : null}

            {/*
              The four tests behind the tier. This is the part a TradingKit card has no equivalent of, and
              it is the only reason to believe any of the numbers above.
            */}
            {data.evidence ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
                <Text variant="footnote" color={colors.ink55} style={{ marginBottom: space.s4 }}>
                  WHAT IT WAS PUT THROUGH
                </Text>
                <Line
                  label="Parameters moved ±30%"
                  value={data.evidence.sensitivityPassed ? `${data.evidence.sensitivityPassed} stayed positive` : '—'}
                />
                <Line
                  label="Commission doubled"
                  value={fig(data.evidence.doubleCostReturnPct, (n) => percent(n, { digits: 2 }))}
                  tone={pnlTone(data.evidence.doubleCostReturnPct ?? 0)}
                />
                {Object.entries(data.evidence.crossAsset ?? {}).map(([sym, v]) => (
                  <Line key={sym} label={`Held up on ${sym}`} value={`${ratio(v, 4)} R`} tone={pnlTone(v)} />
                ))}
                <View style={{ paddingTop: space.s10 }}>
                  <Text variant="secondary" color={colors.ink65}>
                    Verdict
                  </Text>
                  <Price
                    variant="secondary"
                    tone={data.evidence.survives ? 'up' : 'down'}
                    style={{ marginTop: space.s4 }}
                  >
                    {data.evidence.survives ? 'Passed all four.' : failureWords(data.evidence.failedOn ?? [])}
                  </Price>
                </View>
              </SheetCard>
            ) : null}

            {data.trades.length > 0 ? (
              <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
                <Text variant="footnote" color={colors.ink55}>
                  TRADES
                </Text>
                <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s4, marginBottom: space.s8 }}>
                  {data.tradesShown === data.tradesTotal
                    ? `All ${data.tradesTotal}.`
                    : `The ${data.tradesShown} most recent of ${data.tradesTotal}.`}
                </Text>
                {data.trades.map((t, i) => (
                  <View
                    key={`${t.closedAt}-${i}`}
                    style={{
                      paddingVertical: space.s10,
                      borderBottomWidth: i < data.trades.length - 1 ? 1 : 0,
                      borderBottomColor: colors.hairline,
                    }}
                  >
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text variant="secondary">
                        {t.side === 'short' ? 'Short' : 'Long'} {t.symbol}
                      </Text>
                      <Price variant="secondary" tone={pnlTone(t.pnlUsd ?? 0)}>
                        {fig(t.pnlPct, (n) => percent(n, { digits: 2 }))}
                      </Price>
                    </View>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.s4 }}>
                      <Text variant="footnote" color={colors.ink55}>
                        {fig(t.entry, (n) => `${n}`)} → {fig(t.exit, (n) => `${n}`)} · {t.bars ?? '—'} bars ·{' '}
                        {(t.reason ?? '').toLowerCase().replace(/_/g, ' ')}
                      </Text>
                      <Text variant="footnote" color={colors.ink55}>
                        {fig(t.pnlUsd, (n) => money(n))}
                      </Text>
                    </View>
                  </View>
                ))}
              </SheetCard>
            ) : null}

            {/* The window, last. Every number above is a claim about this and nothing else. */}
            <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
              <Text variant="footnote" color={colors.ink55}>
                MEASURED OVER
              </Text>
              <Text variant="secondarySm" color={colors.ink65} style={{ marginTop: space.s6 }}>
                {data.window.bars.toLocaleString('en-US')} {data.window.interval} bars across{' '}
                {data.window.symbols.length} symbols ({data.window.symbols.join(', ')}), split in half. The second half
                — {data.window.barsUnseen.toLocaleString('en-US')} bars — is the unseen one.{' '}
                {data.window.feeBpsPerSide} bps a side, {Math.round(data.window.sizingPct * 100)}% of capital per
                position, unlevered.
              </Text>
              <Text variant="footnote" color={colors.ink55} style={{ marginTop: space.s8 }}>
                Past behaviour of a rule over recorded candles. It is not a forecast, and nothing here traded real
                money.
              </Text>
            </SheetCard>
          </ScrollView>
        )}
      </Fill>
    </Screen>
  );
}
