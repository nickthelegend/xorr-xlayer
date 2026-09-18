/**
 * The design-system scratch screen.
 *
 * Every primitive in `src/ui`, in every state it ships with, on the real canvas — the
 * page to hold next to `mobile-ui/reference/Orbit Trading App.dc.html` and diff.
 *
 * It uses the prototype's own OHLC series, its own sparkline points and its own copy, so
 * a candle here should sit where a candle there sits.
 *
 * Not a screen. No navigation, no store, no data fetch — it exists to be looked at.
 */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import {
  AgentOrb,
  AreaChart,
  AssetMark,
  BottomSheet,
  Button,
  ButtonPair,
  ButtonRow,
  Candlestick,
  DeltaChip,
  Eyebrow,
  NoteStrip,
  Pill,
  PillRow,
  PillWrap,
  Price,
  Row,
  Ruler,
  Screen,
  Segmented,
  SheetCard,
  Sparkline,
  StatGrid,
  StatRow,
  StatTile,
  Stepper,
  Switch,
  SwitchRow,
  TabBar,
  Tag,
  Text,
  Value,
  VolumeBars,
  colors,
  money,
  percent,
  price,
  quantity,
  wholeMoney,
  radius,
  size,
  space,
  tightProjection,
  typeScale,
  wideProjection,
  type Candle,
  type TabKey,
  type TypeVariant,
} from '@/ui';
import { agentGradient } from '@/design/gradients';

/* ---------------------------------------------------------------- fixtures */

/** The prototype's series, verbatim: [open, high, low, close]. */
const RAW: readonly (readonly [number, number, number, number])[] = [
  [66120, 66480, 66020, 66400],
  [66400, 66520, 66180, 66240],
  [66240, 66300, 65860, 65920],
  [65920, 66040, 65600, 65700],
  [65700, 65780, 65380, 65460],
  [65460, 65540, 65180, 65240],
  [65240, 65700, 65200, 65640],
  [65640, 65720, 65420, 65480],
  [65480, 65960, 65440, 65900],
  [65900, 66140, 65840, 66080],
  [66080, 66360, 66020, 66300],
  [66300, 66620, 66240, 66560],
];

/** The prototype's volume heights: `28 + ((i * 37) % 62)`. */
const SERIES: Candle[] = RAW.map(([open, high, low, close], i) => ({
  open,
  high,
  low,
  close,
  volume: 28 + ((i * 37) % 62),
}));

const LAST_CLOSE = 66560;
const MID = 66000;

/** The watchlist sparkline for SOL, converted out of SVG's y-down space. */
const SPARK = [20, 14, 17, 9, 13, 7, 10, 5].map((y) => 30 - y);

const EQUITY = [86, 80, 84, 66, 72, 52, 58, 40, 46, 30, 34, 20].map((y) => 110 - y);

const TYPE_ORDER = Object.keys(typeScale) as TypeVariant[];

/* ------------------------------------------------------------------ layout */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: space.s38 }}>
      <Eyebrow>{title}</Eyebrow>
      <View style={{ marginTop: space.s14, gap: space.s16 }}>{children}</View>
    </View>
  );
}

function Case({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.s8 }}>
      <Text variant="footnote" color={colors.ink28}>
        {label}
      </Text>
      {children}
    </View>
  );
}

function Swatch({ name, value }: { name: string; value: string }) {
  return (
    <View style={{ width: 96, gap: space.s4 }}>
      <View
        style={{
          height: space.s34,
          borderRadius: radius.square,
          backgroundColor: value,
          borderWidth: 1,
          borderColor: colors.cardBorder,
        }}
      />
      <Text variant="footnoteSm" color={colors.ink50}>
        {name}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ screen */

export default function UiScratch() {
  const [pill, setPill] = useState('Metals');
  const [risk, setRisk] = useState('balanced');
  const [side, setSide] = useState('buy');
  const [look, setLook] = useState('90d');
  const [cap, setCap] = useState(1600);
  const [tp, setTp] = useState(1.0);
  const [sl, setSl] = useState(-1.0);
  const [auto, setAuto] = useState(true);
  const [alertOn, setAlertOn] = useState(true);
  const [tab, setTab] = useState<TabKey>('home');
  const [killed, setKilled] = useState(false);
  const [chatTapped, setChatTapped] = useState(false);

  /* The faces are loaded once in `app/_layout.tsx`, which holds the splash until they are
     ready — so by the time any screen renders they are there. This gallery had its own
     loader back when the design system owned font loading; two loaders for one set of
     files is one more than can be kept in agreement. */

  const tight = tightProjection(SERIES);
  const tpPrice = MID * (1 + tp / 100);
  const slPrice = MID * (1 + sl / 100);
  const wide = wideProjection(SERIES, tpPrice, slPrice);

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text variant="screenTitle">Design system</Text>
        <Text variant="bodySm" style={{ marginTop: space.s8 }}>
          Every primitive in src/ui, in every state. Inter is loaded — 400, 500, 600, 700,
          selected by family name.
        </Text>

        {/* ------------------------------------------------------------ type */}

        <Section title="Type · design.md §2">
          {TYPE_ORDER.map((name) => (
            <View key={name} style={{ gap: space.s2 }}>
              <Text variant="footnoteSm" color={colors.ink28}>
                {name} · {typeScale[name].fontSize}/{typeScale[name].lineHeight} ·{' '}
                {typeScale[name].fontFamily.replace('Inter_', '')} · ls{' '}
                {typeScale[name].letterSpacing}
              </Text>
              <Text variant={name} color={colors.ink}>
                $66,560.18
              </Text>
            </View>
          ))}
        </Section>

        {/* --------------------------------------------------------- colour */}

        <Section title="Colour · design.md §1">
          <Case label="Surfaces">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s8 }}>
              <Swatch name="bg" value={colors.bg} />
              <Swatch name="surface" value={colors.surface} />
              <Swatch name="surfaceAlt" value={colors.surfaceAlt} />
              <Swatch name="control" value={colors.control} />
              <Swatch name="controlPress" value={colors.controlPress} />
              <Swatch name="switchOff" value={colors.switchOff} />
              <Swatch name="inputBg" value={colors.inputBg} />
            </View>
          </Case>

          <Case label="Ink ramp">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s8 }}>
              <Swatch name="ink" value={colors.ink} />
              <Swatch name="ink70" value={colors.ink70} />
              <Swatch name="ink65" value={colors.ink65} />
              <Swatch name="ink55" value={colors.ink55} />
              <Swatch name="ink50" value={colors.ink50} />
              <Swatch name="ink45" value={colors.ink45} />
              <Swatch name="ink40" value={colors.ink40} />
              <Swatch name="ink38" value={colors.ink38} />
              <Swatch name="ink35" value={colors.ink35} />
              <Swatch name="ink32" value={colors.ink32} />
              <Swatch name="ink30" value={colors.ink30} />
              <Swatch name="ink28" value={colors.ink28} />
            </View>
          </Case>

          <Case label="Semantic — P&L only">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s8 }}>
              <Swatch name="up" value={colors.up} />
              <Swatch name="upBg" value={colors.upBg} />
              <Swatch name="down" value={colors.down} />
              <Swatch name="downBg" value={colors.downBg} />
              <Swatch name="warn" value={colors.warn} />
              <Swatch name="candleUp" value={colors.candleUp} />
              <Swatch name="candleDown" value={colors.candleDown} />
            </View>
          </Case>

          <Case label="Light sheet">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s8 }}>
              <Swatch name="sheetBg" value={colors.sheet.bg} />
              <Swatch name="sheetInk" value={colors.sheet.ink} />
              <Swatch name="sheetMuted" value={colors.sheet.muted} />
              <Swatch name="sheetDim" value={colors.sheet.dim} />
              <Swatch name="sheetFill" value={colors.sheet.fill} />
              <Swatch name="sheetTick" value={colors.sheet.tick} />
            </View>
          </Case>

          <Case label="Hairlines — each on surface, so the difference is visible">
            <SheetCard padding={space.s16}>
              {(
                [
                  ['hairline .05', colors.hairline],
                  ['hairlineStrong .055', colors.hairlineStrong],
                  ['cardBorder .06', colors.cardBorder],
                  ['inputBorder .07', colors.inputBorder],
                  ['ghostBorder .09', colors.ghostBorder],
                  ['selectedBorder .55', colors.selectedBorder],
                ] as const
              ).map(([name, value]) => (
                <View
                  key={name}
                  style={{
                    height: size.rowSm,
                    justifyContent: 'center',
                    borderBottomWidth: 1,
                    borderBottomColor: value,
                  }}
                >
                  <Text variant="secondarySm">{name}</Text>
                </View>
              ))}
            </SheetCard>
          </Case>
        </Section>

        {/* ----------------------------------------------------- agent orbs */}

        <Section title="AgentOrb · design.md §5">
          <Case label="Sizes 52 / 56 / 70 / 74 / 84 / 104 — gradient at 32% 26%, c2 at 74%">
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.s12, flexWrap: 'wrap' }}>
              {([52, 56, 70, 74, 84, 104] as const).map((s) => (
                <AgentOrb key={s} gradient={colors.agent.momentum} size={s} />
              ))}
            </View>
          </Case>

          <Case label="Specular off · face · bloom · P&L badge">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s20 }}>
              <AgentOrb gradient={colors.agent.earnings} size={74} specular={false} />
              <AgentOrb gradient={colors.agent.earnings} size={74} face />
              <AgentOrb gradient={colors.agent.yield} size={74} face bloom />
              <AgentOrb gradient={colors.agent.momentum} size={74} face badge="+$10.5" />
            </View>
          </Case>

          <Case label="With name and status — Active, New, Paused">
            <View style={{ flexDirection: 'row', gap: space.s22 }}>
              <AgentOrb
                gradient={colors.agent.momentum}
                size={74}
                face
                name="Signals"
                status="active"
              />
              <AgentOrb
                gradient={colors.agent.yield}
                size={74}
                face
                name="Crypto"
                status="new"
              />
              <AgentOrb
                gradient={colors.agent.drawdown}
                size={74}
                face
                name="Guard"
                status="paused"
              />
            </View>
          </Case>

          <Case label="Every identity gradient, plus asset marks at 34 / 30 / 22">
            <View style={{ flexDirection: 'row', gap: space.s12, flexWrap: 'wrap' }}>
              {(
                ['momentum', 'earnings', 'yield', 'drawdown', 'strategist'] as const
              ).map((key) => (
                <AgentOrb key={key} gradient={colors.agent[key]} size={52} />
              ))}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s12 }}>
              <AssetMark gradient={{ c1: '#F5CE5F', c2: '#B98A0C' }} size={size.mark} />
              <AssetMark gradient={{ c1: '#5B93FF', c2: '#49E39B' }} size={size.markSm} />
              <AssetMark gradient={{ c1: '#E8464B', c2: '#98181C' }} size={size.noteOrb} />
            </View>
          </Case>

          <Case label="Generated faces — identity={name}: the same name draws the same face everywhere">
            <View style={{ flexDirection: 'row', gap: space.s12, flexWrap: 'wrap' }}>
              {(
                [
                  'Momentum Scout', 'Earnings Desk', 'Yield Keeper', 'Drawdown Guard', 'Strategist',
                  'Night Owl', 'Basis Trader', 'Grid Runner', 'Funding Hunter', 'Vol Seller',
                  'Delta Neutral', 'Gamma Ghost',
                ] as const
              ).map((n) => (
                <AgentOrb key={n} gradient={agentGradient(n)} identity={n} size={52} face />
              ))}
            </View>
          </Case>
        </Section>

        {/* ---------------------------------------------------------- rows */}

        <Section title="Row · design.md §5">
          <Case label="Mark · primary + secondary · value + delta — 66px">
            <Row
              height={size.rowLg}
              left={<AssetMark gradient={{ c1: '#5B93FF', c2: '#49E39B' }} size={size.mark} />}
              title="SOL"
              secondary="Solana · Spot · Perp"
              value="$88.32"
              delta="+2.40%"
              deltaTone="up"
            />
            <Row
              height={size.rowLg}
              left={<AssetMark gradient={{ c1: '#9AA3AD', c2: '#4A5058' }} size={size.mark} />}
              title="XRP"
              secondary="XRP · Perp · 50x"
              value="$2.94"
              delta="−1.08%"
              deltaTone="down"
            />
          </Case>

          <Case label="Label / value pair — 38px, no mark">
            <Row height={space.s38}>
              <Text variant="secondary">Position size</Text>
              <View style={{ flex: 1 }} />
              <Price>$4,000</Price>
            </Row>
            <Row height={space.s38}>
              <Text variant="secondary">Liquidation</Text>
              <View style={{ flex: 1 }} />
              <Price tone="down">$2,784</Price>
            </Row>
            <Row height={space.s38} divider={false}>
              <Text variant="secondary">Funding</Text>
              <View style={{ flex: 1 }} />
              <Price>0.0041% / 8h</Price>
            </Row>
          </Case>

          <Case label="Sparkline row — direction lives in the text, not the line">
            <Row height={64}>
              <Text variant="rowPrimaryLg" style={{ width: 78 }}>
                SOL
              </Text>
              <Sparkline data={SPARK} />
              <View style={{ flex: 1 }} />
              <View style={{ alignItems: 'flex-end' }}>
                <Price variant="rowPrimaryLg">$88.32</Price>
                <Price variant="delta" tone="up">
                  +2.4%
                </Price>
              </View>
            </Row>
          </Case>

          <Case label="Pressable row">
            <Row
              title="Withdrawal allowlist"
              secondary="2 addresses"
              right={<Text variant="secondary">›</Text>}
              onPress={() => {}}
            />
          </Case>
        </Section>

        {/* --------------------------------------------------------- pills */}

        <Section title="Pill · Segmented · design.md §5">
          <Case label="Pill row — scrolls, never shrinks">
            <PillRow>
              {['Conviction List', 'Metals', 'Stocks', 'Defi', 'Overview'].map((label) => (
                <Pill
                  key={label}
                  label={label}
                  selected={pill === label}
                  onPress={() => setPill(label)}
                />
              ))}
            </PillRow>
          </Case>

          <Case label="Wrapping set · light sheet · disabled">
            <PillWrap>
              {['Grow long term', 'Trade actively', 'Earn yield'].map((label) => (
                <Pill
                  key={label}
                  label={label}
                  selected={pill === label}
                  onPress={() => setPill(label)}
                />
              ))}
            </PillWrap>
            <View
              style={{
                flexDirection: 'row',
                gap: space.s8,
                backgroundColor: colors.sheet.bg,
                padding: space.s12,
                borderRadius: radius.card,
              }}
            >
              <Pill label="$100" light onPress={() => {}} />
              <Pill label="$500" light selected onPress={() => {}} />
              <Pill label="Max" light onPress={() => {}} />
            </View>
            <View style={{ flexDirection: 'row', gap: space.s8 }}>
              <Pill label="Disabled" disabled />
              <Pill label="Selected, static" selected />
            </View>
          </Case>

          <Case label="Segmented — 3 options at 42, 2 options at 38, light sheet at 38">
            <Segmented
              height={size.segThumbLg}
              value={risk}
              onChange={setRisk}
              options={[
                { value: 'steady', label: 'Steady' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'aggressive', label: 'Aggressive' },
              ]}
            />
            <Segmented
              value={look}
              onChange={setLook}
              options={[
                { value: '30d', label: '30d' },
                { value: '90d', label: '90d' },
                { value: '6m', label: '6m' },
                { value: '1y', label: '1y' },
              ]}
            />
            <View style={{ backgroundColor: colors.sheet.bg, padding: space.s12, borderRadius: radius.card }}>
              <Segmented
                light
                value={side}
                onChange={setSide}
                options={[
                  { value: 'buy', label: 'Buy' },
                  { value: 'sell', label: 'Sell' },
                ]}
              />
            </View>
          </Case>
        </Section>

        {/* ------------------------------------------------------- steppers */}

        <Section title="Stepper · Switch · design.md §5">
          <Case label="Daily spend cap — 26px circles, 44pt touch area, fixed value width">
            <Row divider={false} height={size.row}>
              <Text variant="bodyLg">Daily Spend Cap</Text>
              <View style={{ flex: 1 }} />
              <Stepper
                value={`${wholeMoney(cap)}/day`}
                align="right"
                canDecrement={cap > 200}
                canIncrement={cap < 5000}
                onDecrement={() => setCap((c) => Math.max(200, c - 200))}
                onIncrement={() => setCap((c) => Math.min(5000, c + 200))}
              />
            </Row>
          </Case>

          <Case label="TP / SL chip steppers, on the light sheet">
            <View
              style={{
                backgroundColor: colors.sheet.bg,
                padding: space.s16,
                borderRadius: radius.card,
                gap: space.s16,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text variant="rowPrimary" color={colors.sheet.ink}>
                  Stop Loss
                </Text>
                <View style={{ flex: 1 }} />
                <Stepper
                  light
                  circle={size.stepperCircleSm}
                  valueMinWidth={56}
                  value={percent(sl)}
                  chip={{ bg: colors.candleDown, fg: colors.ink }}
                  canDecrement={sl > -3}
                  canIncrement={sl < -0.5}
                  onDecrement={() => setSl((x) => Math.max(-3, +(x - 0.5).toFixed(1)))}
                  onIncrement={() => setSl((x) => Math.min(-0.5, +(x + 0.5).toFixed(1)))}
                />
              </View>
              <Ruler position={(80 + sl * 22) / 100} tone="sl" />
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text variant="rowPrimary" color={colors.sheet.ink}>
                  Take Profit
                </Text>
                <View style={{ flex: 1 }} />
                <Stepper
                  light
                  circle={size.stepperCircleSm}
                  valueMinWidth={56}
                  value={percent(tp)}
                  chip={{ bg: colors.candleUp, fg: colors.ink }}
                  canDecrement={tp > 0.5}
                  canIncrement={tp < 3}
                  onDecrement={() => setTp((x) => Math.max(0.5, +(x - 0.5).toFixed(1)))}
                  onIncrement={() => setTp((x) => Math.min(3, +(x + 0.5).toFixed(1)))}
                />
              </View>
              <Ruler position={(20 + tp * 22) / 100} tone="tp" />
            </View>
          </Case>

          <Case label="Switch — always paired with a caption that changes with it">
            <SwitchRow
              label="Trade Autonomously"
              on={auto}
              onChange={setAuto}
              caption={(on) =>
                on
                  ? 'Executes inside your limits without asking'
                  : 'Every trade waits for your approval'
              }
            />
            <Row height={70} divider>
              <View style={{ flex: 1 }}>
                <Text variant="rowPrimary">SOL above $95</Text>
                <Text variant="secondarySm" style={{ marginTop: space.s2 }}>
                  Price alert · push + agent note
                </Text>
              </View>
              <Switch compact on={alertOn} onChange={setAlertOn} accessibilityLabel="SOL above $95" />
            </Row>
            <View style={{ flexDirection: 'row', gap: space.s16, alignItems: 'center' }}>
              <Switch on={false} onChange={() => {}} />
              <Switch on disabled onChange={() => {}} />
              <Switch on={false} disabled onChange={() => {}} />
              <Text variant="footnote">off · on+disabled · off+disabled</Text>
            </View>
          </Case>
        </Section>

        {/* -------------------------------------------------------- buttons */}

        <Section title="Button · design.md §5">
          <Case label="primary · secondary · ghost · destructive · success · disabled">
            <Button label="Run Agent" onPress={() => {}} />
            <Button label="Edit TP/SL" variant="secondary" onPress={() => {}} />
            <Button label="Add custom alert" variant="ghost" onPress={() => {}} />
            <Button label="Stop all agents" variant="destructive" onPress={() => {}} />
            <Button label="Portfolio approved" variant="success" onPress={() => {}} />
            <Button label="Balance to 100% first" disabled />
          </Case>

          <Case label="Two-button row — affirmative wider (flex 1.3) and on the right">
            <ButtonRow
              secondary={<Button label="Edit TP/SL" variant="secondary" onPress={() => {}} />}
              primary={<Button label="Close 50%" onPress={() => {}} />}
            />
          </Case>

          <Case label="Equal pair — neither action is the safe one">
            <ButtonPair
              left={<Button label="Short" variant="secondary" onPress={() => {}} />}
              right={
                <Button
                  label="Long"
                  backgroundColor={colors.candleUp}
                  color={colors.ink}
                  onPress={() => {}}
                />
              }
            />
          </Case>

          <Case label="On the light sheet">
            <View style={{ backgroundColor: colors.sheet.bg, padding: space.s16, borderRadius: radius.card }}>
              <Button label="Buy $250 of SOL" variant="sheetPrimary" onPress={() => {}} />
            </View>
          </Case>
        </Section>

        {/* ------------------------------------------------- tags and notes */}

        <Section title="Eyebrow · Tag · NoteStrip · design.md §5">
          <Case label="Eyebrow, both sizes">
            <Eyebrow>Total value</Eyebrow>
            <Eyebrow small>Open interest</Eyebrow>
          </Case>

          <Case label="Tags — neutral, warn, and an instrument's own pair">
            <View style={{ flexDirection: 'row', gap: space.s6, flexWrap: 'wrap' }}>
              <Tag label="Perpetual" small colors={{ bg: 'rgba(245,206,95,.14)', fg: '#F5CE5F' }} />
              <Tag label="No expiry" small />
              <Tag label="Spot feed" small />
              <Tag label="Macro" colors={{ bg: 'rgba(91,147,255,.16)', fg: '#7FA9FF' }} />
              <Tag label="Earnings" tone="warn" />
            </View>
          </Case>

          <Case label="P&L tags and delta chips — always signed or worded">
            <View style={{ flexDirection: 'row', gap: space.s6, alignItems: 'center', flexWrap: 'wrap' }}>
              <Tag label="+0.44%" tone="up" sentence />
              <Tag label="−2.10%" tone="down" sentence />
              <Tag label="Take profit" tone="solidUp" />
              <Tag label="Stop loss" tone="solidDown" />
              <DeltaChip label="up 0.3%" tone="up" />
              <DeltaChip label="down 5.1%" tone="down" />
            </View>
          </Case>

          <Case label="NoteStrip — acted, adjusted risk, blocked, and with an agent orb">
            <NoteStrip kind="acted">
              Yield Keeper: moved $1,240 of idle cash in. Unlock is 3 days.
            </NoteStrip>
            <NoteStrip kind="risk">
              Drawdown Guard: trailing the stop to −1.0% after a +2.4% run.
            </NoteStrip>
            <NoteStrip kind="blocked">
              Earnings Desk: skipped NVDAx. Spread 0.42% is over your 0.25% limit.
            </NoteStrip>
            <NoteStrip gradient={colors.agent.momentum}>
              Three green closes off the $65.2K shelf. Momentum Scout is watching for a
              break of $66.6K to add.
            </NoteStrip>
          </Case>
        </Section>

        {/* ---------------------------------------------------------- cards */}

        <Section title="SheetCard · StatTile">
          <Case label="Card at each radius — 22, 26, 30, 34">
            {([radius.panel, radius.panelXl, radius.sheet, radius.sheetLg] as const).map((r) => (
              <SheetCard key={r} borderRadius={r}>
                <Text variant="cardTitle">radius {r} · no elevation, 1px cardBorder</Text>
              </SheetCard>
            ))}
          </Case>

          <Case label="Single tile — the eyebrow names the value, it is never the value">
            <View style={{ flexDirection: 'row' }}>
              <StatTile label="Return" value="+11.8%" color={colors.up} />
            </View>
          </Case>

          <Case label="Stat row — four tiles, tabular so the columns hold">
            <StatRow
              items={[
                { label: 'Return', value: '+11.8%', color: colors.up },
                { label: 'Max DD', value: '−5.4%', color: colors.down },
                { label: 'Sharpe', value: '1.7' },
                { label: 'Trades', value: '54' },
              ]}
            />
          </Case>

          <Case label="Stat grid — the 1px gutters are the card border showing through">
            <StatGrid
              items={[
                { label: 'Open interest', value: '$182.4M' },
                { label: '24h volume', value: '$1.06B' },
                { label: 'Mark vs index', value: '+$0.42', color: colors.up },
                { label: 'Next funding', value: '02:14:38' },
              ]}
            />
          </Case>

          <Case label="Bottom sheet — 30 30 0 0, dark and light">
            <View style={{ height: 120, flexDirection: 'row', gap: space.s12 }}>
              <BottomSheet style={{ flex: 1, padding: space.s18 }}>
                <Text variant="sheetTitle">Position</Text>
              </BottomSheet>
              <BottomSheet light style={{ flex: 1, padding: space.s18 }}>
                <Text variant="sheetTitle" color={colors.sheet.ink}>
                  Auto Close
                </Text>
              </BottomSheet>
            </View>
          </Case>
        </Section>

        {/* --------------------------------------------------------- charts */}

        <Section title="Charts · design.md §6">
          <Case label="Tight projection — the pro chart, with the derived axis and last-price rule">
            <Candlestick
              series={SERIES}
              projection={tight}
              height={230}
              showAxis
              lastPrice={{ value: LAST_CLOSE, label: wholeMoney(LAST_CLOSE) }}
            />
            <VolumeBars series={SERIES} axisWidth={56} />
            <Text variant="footnoteSm">
              hi {wholeMoney(tight.hi)} · lo {wholeMoney(tight.lo)} — maxHigh + 120 /
              minLow − 120
            </Text>
          </Case>

          <Case label="Wide projection — the same series, bracketed by the live TP/SL above">
            <View style={{ backgroundColor: colors.sheet.bg, borderRadius: radius.card, padding: space.s12 }}>
              <Candlestick
                series={SERIES}
                projection={wide}
                height={200}
                light
                lastPriceSide="left"
                lastPrice={{ value: LAST_CLOSE, label: `Mark ${wholeMoney(LAST_CLOSE)}` }}
              />
            </View>
            <Text variant="footnoteSm">
              hi {wholeMoney(wide.hi)} · lo {wholeMoney(wide.lo)} — brackets TP{' '}
              {wholeMoney(tpPrice)} and SL {wholeMoney(slPrice)} at any setting
            </Text>
          </Case>

          <Case label="Area — equity curve with grid and end dot, and a bare instrument line">
            <AreaChart data={EQUITY} height={150} grid endDot />
            <AreaChart data={EQUITY} height={110} color="#F5CE5F" />
          </Case>

          <Case label="Sparkline — 90×30, white, direction carried by the text beside it">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s16 }}>
              <Sparkline data={SPARK} />
              <Sparkline data={[...SPARK].reverse()} />
              <Price variant="delta" tone="down">
                −1.2%
              </Price>
            </View>
          </Case>
        </Section>

        {/* -------------------------------------------------------- tab bar */}

        <Section title="TabBar · design.md §4">
          <Case label="Home, Swap and Messages — Home is the place; Swap and Messages are actions">
            <View style={{ borderRadius: radius.card, overflow: 'hidden' }}>
              <TabBar
                active={tab}
                onHome={() => setTab('home')}
                onSwap={() => setChatTapped(false)}
                onMessages={() => setChatTapped((c) => !c)}
                unread={3}
              />
            </View>
            <Text variant="footnote" color={colors.ink40}>
              {chatTapped ? 'Messages opened' : 'Messages closed'}
            </Text>
            <SwitchRow
              label="Agents are live"
              on={!killed}
              onChange={(on) => setKilled(!on)}
              divider={false}
              caption={(on) =>
                on
                  ? '3 agents can place orders inside your limits right now'
                  : 'Nothing will be placed until you resume. Open positions are untouched'
              }
            />
          </Case>
        </Section>

        {/* ------------------------------------------------------ formatting */}

        <Section title="Formatting · state.md">
          <Case label="U+2212 for negatives, separators on anything over 999">
            <Row height={space.s38}>
              <Text variant="secondary">money(4862.18)</Text>
              <View style={{ flex: 1 }} />
              <Price>{money(4862.18)}</Price>
            </Row>
            <Row height={space.s38}>
              <Text variant="secondary">money(−4.22, signed)</Text>
              <View style={{ flex: 1 }} />
              <Price tone="down">{money(-4.22, { signed: true })}</Price>
            </Row>
            <Row height={space.s38}>
              <Text variant="secondary">price(66560) · price(88.32) · price(0.1842)</Text>
              <View style={{ flex: 1 }} />
              <Price>
                {price(66560)} · {price(88.32)} · {price(0.1842)}
              </Price>
            </Row>
            <Row height={space.s38}>
              <Text variant="secondary">percent(1) · percent(−5.4)</Text>
              <View style={{ flex: 1 }} />
              <Price>
                {percent(1)} · {percent(-5.4)}
              </Price>
            </Row>
            <Row height={space.s38} divider={false}>
              <Text variant="secondary">quantity(1750.3)</Text>
              <View style={{ flex: 1 }} />
              <Price>{quantity(1750.3)} SOL</Price>
            </Row>
          </Case>
        </Section>

        {/* --------------------------------------------------- the one rule */}

        <Section title="The one product rule">
          <SheetCard>
            <Text variant="bodySm" color={colors.ink45}>
              Green and red mean profit and loss, nothing else. Never selection, focus,
              branding or emphasis. Selection is white-on-dark. On this page every green
              and red belongs to a price, a P&L figure, a candle, a TP/SL band, or the
              agent-live status dot — and every selected pill, segment and tab is white.
            </Text>
            <View style={{ flexDirection: 'row', gap: space.s10, marginTop: space.s16 }}>
              <Pill label="Selected" selected />
              <Pill label="Not selected" />
              <Value variant="pnlHero" color={colors.up} style={{ fontSize: 22, lineHeight: 26 }}>
                +$318.40
              </Value>
            </View>
          </SheetCard>
        </Section>

        <View style={{ height: space.s44 }} />
      </ScrollView>
    </Screen>
  );
}
