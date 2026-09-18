/**
 * What a recurring buy would have done, before you commit money to it.
 *
 * Agents had a backtest and strategies did not, which is backwards: an agent is a persona and a
 * strategy is the thing that actually spends. Running one before creating it is the difference
 * between a plan and a guess.
 *
 * Everything the server sends about the run's provenance is rendered — the window, where the prices
 * came from, and the disclaimer. A backtest without those is a sales pitch, and the server sends
 * them precisely so the client cannot quietly drop them.
 *
 * It creates nothing. This is a calculation over past prices, and the strategy screens are where
 * something gets made.
 *
 * It offers what a recurring buy can buy (`RECURRING_BUY_SYMBOLS`), not every tradable symbol: USDC is
 * what a buy is paid in and the tokenized equities have no history to replay, so a run of either could
 * only fail. And a result stands beside the inputs it was run on and no others — changing the market,
 * the window or the size used to leave the previous answer under pills that no longer described it.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useGoBack } from '@/nav/useGoBack';
import {
  AreaChart,
  Button,
  ErrorState,
  Fill,
  HeaderBar,
  Pill,
  PillRow,
  Placeholder,
  Price,
  Screen,
  SheetCard,
  Text,
  colors,
  pnlTone,
  radius,
  space,
} from '@/ui';
import { money, percent } from '@/format';
import { useAsync } from '@/data/useAsync';
import { system } from '@/data/system';
import { waitOutWarming } from '@/data/warming';
import { RECURRING_BUY_SYMBOLS, type RecurringBuySymbol } from '@/strategies/ladder';

const LOOKBACKS = ['30d', '90d', '6m', '1y'] as const;
const SIZES = [25, 50, 100, 250] as const;
const CHART_H = 130;

type Lookback = (typeof LOOKBACKS)[number];
/** What a run was asked for. A result is only ever shown while the pills still say this. */
type Inputs = { symbol: RecurringBuySymbol; lookback: Lookback; usd: number };

export default function Backtest() {
  const goBack = useGoBack();
  const [symbol, setSymbol] = useState<RecurringBuySymbol>(RECURRING_BUY_SYMBOLS[0]);
  const [lookback, setLookback] = useState<Lookback>('90d');
  const [usd, setUsd] = useState<number>(SIZES[1]);

  const [asked, setAsked] = useState<Inputs | null>(null);
  /*
   * A cold price history takes the executor up to two minutes to fetch, and it answers 503 while the fetch goes on. On an
   * Android emulator this screen said "try again in a moment" twice in a row with the answer on its way (2026-09-15); the
   * agent backtest already waits that out, and so does this.
   */
  const result = useAsync(
    async () =>
      asked
        ? waitOutWarming(() =>
            system.backtestStrategy({
              kind: 'dca',
              symbol: asked.symbol,
              lookback: asked.lookback,
              // Weekly, which is what the DCA creator defaults to — a backtest of a cadence nobody
              // would choose answers a question nobody asked.
              params: { usd: asked.usd, everyNDays: 7 },
            }),
          )
        : null,
    [asked],
  );
  const current =
    asked !== null && asked.symbol === symbol && asked.lookback === lookback && asked.usd === usd;
  const busy = current && result.loading;
  // The same inputs again is a retry; anything else is a new question.
  const run = () => (current ? result.reload() : setAsked({ symbol, lookback, usd }));
  const data = current && !result.loading ? result.data : null;
  const tone = pnlTone(data?.ret ?? 0);

  return (
    <Screen gutter="none">
      <View style={{ paddingHorizontal: space.gutter }}>
        <HeaderBar onBack={goBack} title={<Text variant="screenTitle">Backtest</Text>} />
        <Text variant="secondary" color={colors.ink55} style={{ marginTop: space.s8 }}>
          A weekly buy over real past prices. Nothing is bought.
        </Text>
      </View>

      <Fill style={{ marginTop: space.s12 }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: space.s30 }}
        >
          <PillRow style={{ marginTop: space.s8 }} contentPadding={space.gutter}>
            {RECURRING_BUY_SYMBOLS.map((t) => (
              <Pill key={t} label={t} selected={t === symbol} onPress={() => setSymbol(t)} />
            ))}
          </PillRow>

          <PillRow style={{ marginTop: space.s10 }} contentPadding={space.gutter}>
            {LOOKBACKS.map((l) => (
              <Pill key={l} label={l} selected={l === lookback} onPress={() => setLookback(l)} />
            ))}
          </PillRow>

          <PillRow style={{ marginTop: space.s10 }} contentPadding={space.gutter}>
            {SIZES.map((s) => (
              <Pill key={s} label={money(s)} selected={s === usd} onPress={() => setUsd(s)} />
            ))}
          </PillRow>

          <View style={{ paddingHorizontal: space.gutter, marginTop: space.s16, gap: space.s12 }}>
            <Button label={busy ? 'Running…' : 'Run it'} disabled={busy} onPress={run} />

            {!current ? null : result.loading ? (
              <Placeholder height={CHART_H} />
            ) : result.error ? (
              <ErrorState error={result.error} onRetry={result.reload} />
            ) : data ? (
              <>
                {data.equity.length > 1 ? (
                  <AreaChart
                    data={data.equity}
                    height={CHART_H}
                    color={tone === 'up' ? colors.up : tone === 'down' ? colors.down : colors.ink55}
                    endDot
                  />
                ) : null}

                <SheetCard bordered borderRadius={radius.panel} padding={space.s16}>
                  <Text variant="footnote" color={colors.ink55}>
                    RETURN
                  </Text>
                  <Price variant="screenTitle" tone={tone} style={{ marginTop: space.s6 }}>
                    {percent(data.ret)}
                  </Price>
                  <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s10 }}>
                    Worst drawdown {percent(data.maxDd, { explicitSign: false })} · {data.trades}{' '}
                    {data.trades === 1 ? 'buy' : 'buys'}
                  </Text>
                </SheetCard>

                <SheetCard bordered borderRadius={radius.panel} padding={space.s14}>
                  {/*
                    Provenance, rendered rather than dropped. The server sends these three fields
                    for exactly this reason, and a client that keeps the return and discards the
                    caveat has turned a calculation into a claim.
                  */}
                  <Text variant="footnote" color={colors.ink55}>
                    {data.source}
                  </Text>
                  <Text variant="secondarySm" color={colors.ink55} style={{ marginTop: space.s8 }}>
                    {data.disclaimer}
                  </Text>
                </SheetCard>
              </>
            ) : null}
          </View>
        </ScrollView>
      </Fill>
    </Screen>
  );
}
