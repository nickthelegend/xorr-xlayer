/**
 * The design system's edge cases — section W of docs/QA-UI-PLAN.md.
 *
 * Empty series, single points, flat ranges, zero-width containers, extreme magnitudes and
 * strings long enough to break a row. Everything here is a case a real feed will produce
 * eventually; the point is that it produces a composed frame rather than a NaN, a crash,
 * or a silently truncated number.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import {
  AgentOrb,
  AreaChart,
  Button,
  Candlestick,
  NoteStrip,
  Pill,
  PillRow,
  Price,
  Row,
  Ruler,
  Screen,
  Segmented,
  SheetCard,
  Sparkline,
  StatRow,
  Stepper,
  Text,
  VolumeBars,
  colors,
  radius,
  space,
  tightProjection,
  wideProjection,
  type Candle,
} from '@/ui';

const FLAT: Candle[] = [
  { open: 100, high: 100, low: 100, close: 100, volume: 0 },
  { open: 100, high: 100, low: 100, close: 100, volume: 0 },
];
const ONE: Candle[] = [{ open: 66120, high: 66480, low: 66020, close: 66400, volume: 40 }];
const DOJI: Candle[] = [
  { open: 66000, high: 66400, low: 65600, close: 66000, volume: 30 },
  { open: 66000, high: 66050, low: 65950, close: 66000, volume: 30 },
];

function Case({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.s8, marginTop: space.s22 }}>
      <Text variant="footnote" color={colors.ink28}>
        {label}
      </Text>
      {children}
    </View>
  );
}

export default function UiEdge() {
  const [cap, setCap] = useState(200);
  const [tp, setTp] = useState(3.0);
  const [seg, setSeg] = useState('a');

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text variant="screenTitle">Edge cases</Text>

        <Case label="W1 · empty candle series — empty plot at the asked height, no NaN">
          <View testID="w1" style={{ borderWidth: 1, borderColor: colors.cardBorder }}>
            <Candlestick series={[]} projection={tightProjection([])} height={80} showAxis />
          </View>
        </Case>

        <Case label="W2 · single candle — one full-width candle, no divide by zero">
          <View testID="w2" style={{ borderWidth: 1, borderColor: colors.cardBorder }}>
            <Candlestick series={ONE} projection={tightProjection(ONE)} height={80} />
          </View>
        </Case>

        <Case label="W3 · flat series, hi == lo — toPct returns 50, not NaN">
          <View testID="w3" style={{ borderWidth: 1, borderColor: colors.cardBorder }}>
            <Candlestick
              series={FLAT}
              projection={{ hi: 100, lo: 100 }}
              height={80}
              showAxis
              lastPrice={{ value: 100, label: '$100' }}
            />
          </View>
        </Case>

        <Case label="W3b · doji — the 1.4% body floor keeps a flat candle visible">
          <View testID="w3b" style={{ borderWidth: 1, borderColor: colors.cardBorder }}>
            <Candlestick series={DOJI} projection={tightProjection(DOJI)} height={80} />
          </View>
        </Case>

        <Case label="W4 · zero-width container — renders nothing, emits no negative width">
          <View testID="w4" style={{ width: 0, borderWidth: 1, borderColor: colors.cardBorder }}>
            <Candlestick series={ONE} projection={tightProjection(ONE)} height={40} />
            <VolumeBars series={ONE} />
            <AreaChart data={[1, 2, 3]} height={40} />
            <Ruler position={0.5} tone="tp" />
          </View>
        </Case>

        <Case label="W5 · empty area and sparkline data">
          <View testID="w5" style={{ borderWidth: 1, borderColor: colors.cardBorder }}>
            <AreaChart data={[]} height={40} grid endDot />
            <Sparkline data={[]} />
            <VolumeBars series={[]} />
          </View>
        </Case>

        <Case label="W6 · single data point — centred, no crash">
          <View testID="w6" style={{ borderWidth: 1, borderColor: colors.cardBorder }}>
            <AreaChart data={[5]} height={40} endDot />
            <Sparkline data={[5]} />
          </View>
        </Case>

        <Case label="W7 · extreme magnitudes">
          <Price variant="heroBalance">$987,654,321.00</Price>
          <StatRow
            testID="w7"
            items={[
              { label: 'Return', value: '+1,234.5%', color: colors.up },
              { label: 'Max DD', value: '−99.9%', color: colors.down },
              { label: 'Sharpe', value: '12.34' },
              { label: 'Trades', value: '123,456' },
            ]}
          />
        </Case>

        <Case label="W8 · long pill labels — full label kept, row scrolls">
          <PillRow testID="w8">
            {[
              'Conviction List',
              'Tokenized Equities & Indices',
              'Pre-IPO Perpetual Contracts',
              'Metals',
            ].map((label) => (
              <Pill key={label} label={label} onPress={() => {}} />
            ))}
          </PillRow>
        </Case>

        <Case label="W9 · long row title — truncates on one line, value column holds">
          <Row
            testID="w9"
            title="Anthropic Pre-IPO Perpetual Contract, settles at listing"
            secondary="A secondary line that is also far too long to fit inside a 402pt row"
            value="$121.55"
            delta="+1.14%"
            deltaTone="up"
            height={66}
          />
        </Case>

        <Case label="W10 · long note copy — dot holds its size, text wraps beside it">
          <NoteStrip testID="w10" kind="risk">
            Drawdown Guard: cut the crypto sleeve from the top of your band to the middle
            after the book gave back 3.1% in two sessions, and moved the stop on the
            remaining SOL to breakeven. It will not re-add until realised volatility comes
            back under your ceiling.
          </NoteStrip>
        </Case>

        <Case label="W11 · stepper at both bounds — each glyph dims independently">
          <Row divider={false}>
            <Text variant="bodyLg">At the floor</Text>
            <View style={{ flex: 1 }} />
            <Stepper
              testID="w11a"
              value={`$${cap}`}
              align="right"
              canDecrement={cap > 200}
              canIncrement={cap < 5000}
              onDecrement={() => setCap((c) => Math.max(200, c - 200))}
              onIncrement={() => setCap((c) => Math.min(5000, c + 200))}
            />
          </Row>
          <Row divider={false}>
            <Text variant="bodyLg">At the ceiling</Text>
            <View style={{ flex: 1 }} />
            <Stepper
              testID="w11b"
              value={`+${tp.toFixed(1)}%`}
              align="right"
              canDecrement={tp > 0.5}
              canIncrement={tp < 3}
              onDecrement={() => setTp((x) => Math.max(0.5, +(x - 0.5).toFixed(1)))}
              onIncrement={() => setTp((x) => Math.min(3, +(x + 0.5).toFixed(1)))}
            />
          </Row>
        </Case>

        <Case label="W12 · ruler at 0 and 1 — marker stays fully inside the track">
          <View style={{ backgroundColor: colors.sheet.bg, padding: space.s12, borderRadius: radius.card, gap: space.s12 }}>
            <Ruler testID="w12a" position={0} tone="sl" />
            <Ruler testID="w12b" position={1} tone="tp" />
            <Ruler testID="w12c" position={-5} tone="tp" />
            <Ruler testID="w12d" position={99} tone="sl" />
          </View>
        </Case>

        <Case label="W13 · orb at min and max — face and specular scale in proportion">
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.s16 }}>
            <AgentOrb testID="w13a" gradient={colors.agent.yield} size={52} face bloom badge="+$1" />
            <AgentOrb testID="w13b" gradient={colors.agent.yield} size={104} face bloom badge="+$1,204" />
          </View>
        </Case>

        <Case label="W14 · segmented with 2 and 4 options — both distribute evenly">
          <Segmented
            testID="w14a"
            value={seg}
            onChange={setSeg}
            options={[
              { value: 'a', label: 'Buy' },
              { value: 'b', label: 'Sell' },
            ]}
          />
          <Segmented
            testID="w14b"
            value={seg}
            onChange={setSeg}
            options={[
              { value: 'a', label: '30d' },
              { value: 'b', label: '90d' },
              { value: 'c', label: '6m' },
              { value: 'd', label: '1y' },
            ]}
          />
        </Case>

        <Case label="W16 · wide projection with TP/SL far outside the series">
          <View style={{ backgroundColor: colors.sheet.bg, borderRadius: radius.card, padding: space.s12 }}>
            <Candlestick
              testID="w16"
              series={ONE}
              projection={wideProjection(ONE, 70000, 62000)}
              height={100}
              light
              lastPriceSide="left"
              lastPrice={{ value: 66400, label: 'Mark $66,400' }}
            />
          </View>
        </Case>

        <Case label="W17 · long button label — truncates, never wraps the pill">
          <Button
            testID="w17"
            label="Approve and fund the portfolio proposal right now"
            onPress={() => {}}
          />
        </Case>

        <Case label="W18 · empty card">
          <SheetCard testID="w18" />
        </Case>

        <View style={{ height: space.s44 }} />
      </ScrollView>
    </Screen>
  );
}
