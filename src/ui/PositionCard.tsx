/**
 * PositionCard.tsx — one position, the way a trading desk shows it (2026-09-12).
 *
 * Symbol, side and status across the top with the live price; the recent price drawn beneath with the
 * levels that matter — where it was bought, where it takes profit, where it is stopped out — then the
 * numbers under the chart, how many trades built it, and why the bot holds it one tap away.
 *
 * Props only. Every number arrives formatted from a screen that read it from the executor, and a level
 * that does not exist — no stop set, say — is simply not drawn. Nothing here is a placeholder value.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { Press } from './Press';
import { Placeholder } from './States';
import { Price, Text, pnlTone, useSpokenFigure } from './Text';
import type { FigureKind } from './mask';
import { AreaChart } from './charts/AreaChart';
import { chart, colors, radius, space } from './tokens';

export type LevelTone = 'entry' | 'target' | 'stop';

export type PositionLevel = {
  label: string;
  value: number;
  /** The value as the screen formats prices. */
  formatted: string;
  tone: LevelTone;
};

/** One figure under the chart. The person's own money unless `figure` says otherwise — a size in units, say. */
export type PositionStat = { label: string; value: string; value2?: number; figure?: FigureKind };

export interface PositionCardProps {
  symbol: string;
  side: 'long' | 'short';
  /** The live price, formatted. */
  price: string;
  /** Unrealised P&L, formatted with its sign, plus the raw number for its tone. */
  pnl: string;
  pnlPct: string;
  pnlValue: number;
  /** Closes for the chart: undefined while loading, empty when there is no history. */
  series: readonly number[] | undefined;
  levels: readonly PositionLevel[];
  stats: readonly PositionStat[];
  /** Fills that built this position. Undefined while the runs are loading. */
  trades: number | undefined;
  /** The bot's own recorded reason for the latest trade in this symbol, when there is one. */
  why?: string;
  onPress?: () => void;
}

const CHART_H = 120;
/** Room kept clear on the right for the level labels — wide enough for "ENTRY $80,157". */
const LABEL_W = 116;
const LEVEL_TONE: Readonly<Record<LevelTone, string>> = {
  entry: colors.ink55,
  target: colors.up,
  stop: colors.down,
};

function Pill({ label, bg, ink }: { label: string; bg: string; ink: string }) {
  return (
    <View style={{ paddingHorizontal: space.s8, paddingVertical: space.s2, borderRadius: radius.glyph, backgroundColor: bg }}>
      <Text variant="chipSm" color={ink}>
        {label}
      </Text>
    </View>
  );
}

export function PositionCard({
  symbol,
  side,
  price,
  pnl,
  pnlPct,
  pnlValue,
  series,
  levels,
  stats,
  trades,
  why,
  onPress,
}: PositionCardProps) {
  const [open, setOpen] = useState(false);
  const tone = pnlTone(pnlValue);
  /*
   * While balances are hidden (FEATURES.md #47) the card hides what is the person's — its P&L and the figures under the
   * chart — and keeps what is a price: the live price, and the entry, target and stop on the chart, which say where the
   * market is and nothing of how much is held. Its label is said the same way.
   */
  const say = useSpokenFigure();

  /*
   * One vertical scale for the line AND the levels, so a stop drawn under the chart really is below
   * every price on it. The same inset `AreaChart` uses, so the two agree to the pixel.
   */
  const values = [...(series ?? []), ...levels.map((l) => l.value)];
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const padBy = (max - min || Math.abs(max) || 1) * 0.08;
  const bounds = { min: min - padBy, max: max + padBy };
  const inset = chart.area.strokeWidth / 2;
  const yOf = (v: number) => inset + ((bounds.max - v) / (bounds.max - bounds.min)) * (CHART_H - inset * 2);

  const status = tone === 'up' ? 'IN PROFIT' : tone === 'down' ? 'UNDERWATER' : 'FLAT';
  const statusBg = tone === 'up' ? colors.upBg : tone === 'down' ? colors.downBg : colors.neutralBg;
  const statusInk = tone === 'up' ? colors.up : tone === 'down' ? colors.down : colors.ink55;

  return (
    <Press
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${symbol} ${side}. ${price}. ${say(pnl, 'own')}, ${pnlPct}.`}
      style={{ borderRadius: radius.panel, backgroundColor: colors.surfaceAlt, padding: space.s16, gap: space.s14 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s8, flexShrink: 1 }}>
          <Text variant="cardTitle">{symbol}</Text>
          <Pill label={side.toUpperCase()} bg={colors.neutralBg} ink={colors.ink65} />
          <Pill label={status} bg={statusBg} ink={statusInk} />
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Price variant="rowPrimary" figure="market">
            {price}
          </Price>
          <Price variant="footnote" tone={tone}>
            {`${pnl} · ${pnlPct}`}
          </Price>
        </View>
      </View>

      {series === undefined ? (
        <Placeholder height={CHART_H} style={{ borderRadius: radius.tile }} />
      ) : series.length < 2 ? (
        <View style={{ height: CHART_H, alignItems: 'center', justifyContent: 'center' }}>
          <Text variant="footnote" color={colors.ink55}>
            No price history yet
          </Text>
        </View>
      ) : (
        <View style={{ height: CHART_H }}>
          <View style={{ position: 'absolute', left: 0, right: LABEL_W, top: 0 }}>
            <AreaChart
              data={series}
              height={CHART_H}
              bounds={bounds}
              color={tone === 'down' ? colors.down : colors.up}
              inset={inset}
              drawIn
            />
          </View>
          {levels.map((level) => {
            const y = yOf(level.value);
            return (
              <React.Fragment key={level.label}>
                <View
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: LABEL_W,
                    top: y,
                    height: 1,
                    backgroundColor: LEVEL_TONE[level.tone],
                    opacity: 0.6,
                  }}
                />
                <View
                  style={{
                    position: 'absolute',
                    right: 0,
                    width: LABEL_W - space.s6,
                    top: y - space.s8,
                    paddingHorizontal: space.s6,
                    paddingVertical: space.s2,
                    borderRadius: radius.glyph,
                    backgroundColor: colors.control,
                  }}
                >
                  <Text variant="chipSm" color={LEVEL_TONE[level.tone]} numberOfLines={1}>
                    {`${level.label} ${level.formatted}`}
                  </Text>
                </View>
              </React.Fragment>
            );
          })}
        </View>
      )}

      <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.hairline, paddingTop: space.s12 }}>
        {stats.map((s) => (
          <View key={s.label} style={{ flex: 1 }}>
            <Text variant="eyebrowSm">{s.label}</Text>
            <Price
              variant="rowPrimary"
              tone={s.value2 !== undefined ? pnlTone(s.value2) : 'neutral'}
              style={{ marginTop: space.s4 }}
              numberOfLines={1}
              figure={s.figure}
            >
              {s.value}
            </Price>
          </View>
        ))}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        {trades === undefined ? (
          <Placeholder width={70} height={12} />
        ) : (
          <Text variant="secondarySm" color={colors.ink55}>
            {trades === 1 ? '1 trade' : `${trades} trades`}
          </Text>
        )}
        {why ? (
          <Press
            onPress={() => setOpen((o) => !o)}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={open ? 'Hide why this trade' : 'Why this trade'}
          >
            <Text variant="secondarySm" color={colors.ink65}>
              {open ? 'Why this trade ▲' : 'Why this trade ▼'}
            </Text>
          </Press>
        ) : null}
      </View>
      {open && why ? (
        <Text variant="secondarySm" color={colors.ink55}>
          {why}
        </Text>
      ) : null}
    </Press>
  );
}

/** The card's shape while positions load — the same outline it will arrive in. */
export function PositionCardSkeleton() {
  return (
    <View style={{ borderRadius: radius.panel, backgroundColor: colors.surfaceAlt, padding: space.s16, gap: space.s14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Placeholder width={140} height={18} />
        <Placeholder width={80} height={18} />
      </View>
      <Placeholder height={CHART_H} style={{ borderRadius: radius.tile }} />
      <View style={{ flexDirection: 'row', gap: space.s10 }}>
        <Placeholder width="30%" height={30} />
        <Placeholder width="30%" height={30} />
        <Placeholder width="30%" height={30} />
      </View>
    </View>
  );
}
