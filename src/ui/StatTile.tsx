/**
 * StatTile.tsx — a labelled number.
 *
 * Two shapes, both from the prototype:
 *   `StatTile`  #0C0C0D · radius 16 · padding 12–13 · eyebrow over a 17/700 value
 *   `StatGrid`  a 2-column grid whose 1px gaps are the card border showing through,
 *               so the dividing lines are hairlines rather than drawn strokes
 *
 * The value is a `<Value>`: tabular, so a grid of four numbers keeps its columns when the
 * digits change. §7: the eyebrow is `ink30`, which §7 reserves for decorative labels —
 * that is exactly what it is here, with the real information in the value below it.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Eyebrow } from './Eyebrow';
import type { FigureKind } from './mask';
import { Value } from './Text';
import { colors, radius, space } from './tokens';

export interface StatTileProps {
  label: string;
  /** Already formatted. */
  value: string;
  /**
   * What the value is while balances are hidden (FEATURES.md #47, `mask.ts`). Unsaid, a tile is not the person's money
   * and is drawn as it is: tiles hold a market's figures, a backtest's ratios and counts, and a proposal's prices.
   */
  figure?: FigureKind;
  /** Green and red here mean P&L — a return, a drawdown. A trade count is never coloured. */
  color?: string;
  /** The tighter 14.5/600 value used inside a `StatGrid`. */
  compact?: boolean;
  /** A tile sharing a row with three others. `StatRow` sets this; see the note below. */
  dense?: boolean;
  /** Drop the tile's own fill — `StatGrid` supplies it. */
  transparent?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The prototype pads these `12px 13px` (`13px 15px` in the grid). 13 and 15 are not on
 * design.md §3's spacing scale, so these round to the scale — which is also within a
 * point of the prototype.
 *
 * The dense case is a real difference, not a rounding. Four tiles across a 402pt screen
 * leave 84.5pt each; `+11.8%` at 17/700 with tabular figures measures 65.8pt in Inter and
 * about 57 in the SF Pro the prototype was drawn against, so the prototype's 13pt padding
 * fits there and wraps here. `StatRow` therefore pads its tiles at 8 — the widest value
 * on the scale that keeps a six-glyph figure on one line.
 */
const TILE_PADDING_V = space.s12;
const TILE_PADDING_H = space.s12;
const DENSE_PADDING_H = space.s8;
const GRID_PADDING_V = space.s14;
const GRID_PADDING_H = space.s16;

export function StatTile({
  label,
  value,
  color,
  compact = false,
  dense = false,
  transparent = false,
  figure,
  style,
  testID,
}: StatTileProps) {
  return (
    <View
      testID={testID}
      style={[
        {
          flex: 1,
          backgroundColor: transparent ? 'transparent' : colors.surface,
          borderRadius: transparent ? 0 : radius.tile,
          paddingVertical: compact ? GRID_PADDING_V : TILE_PADDING_V,
          paddingHorizontal: compact
            ? GRID_PADDING_H
            : dense
              ? DENSE_PADDING_H
              : TILE_PADDING_H,
        },
        style,
      ]}
    >
      <Eyebrow small color={colors.ink30} numberOfLines={1}>
        {label}
      </Eyebrow>
      {/* The label may truncate; the value may not. An ellipsised number hides digits —
          `+1,234....` could be anything — and on a trading surface a clipped figure is a
          correctness problem, not a layout one. A value too long for its tile wraps and
          grows the row instead, which is visibly wrong rather than quietly wrong. The
          dense padding above is what keeps every realistic value on one line. */}
      <Value
        variant={compact ? 'rowPrimary' : 'cardTitleLg'}
        color={color}
        style={{ marginTop: space.s4 }}
        figure={figure}
      >
        {value}
      </Value>
    </View>
  );
}

export interface StatGridProps {
  items: readonly StatTileProps[];
  /** 2 (the contract screen) or the length of `items` in a single row. */
  columns?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The hairline-gap grid. The 1px gutters are the `cardBorder` colour showing between
 * tiles, which is why the whole grid clips to one radius and the tiles have none.
 */
export function StatGrid({ items, columns = 2, style, testID }: StatGridProps) {
  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 1,
          borderRadius: radius.card,
          overflow: 'hidden',
          backgroundColor: colors.cardBorder,
        },
        style,
      ]}
    >
      {items.map((item, index) => (
        <View
          key={`${item.label}-${index}`}
          style={{
            /* Basis is a couple of points under the exact share so a row of `columns`
               fits with the 1px gutters and the next tile is forced to wrap; flexGrow
               then takes each cell back out to (100% − gutters) / columns. */
            flexBasis: columns === 1 ? '100%' : `${100 / columns - 2}%`,
            flexGrow: 1,
            minWidth: 0,
            backgroundColor: colors.surface,
            /* `row` is load-bearing. `StatTile` carries `flex: 1`, which is what makes a
               row of tiles share its width — but `flex: 1` also means `flexBasis: 0`, and
               in a COLUMN container that zeroes the tile's HEIGHT. The cell then sizes to
               a zero-height child and the grid renders as four empty boxes with hairline
               gutters and no text in them. Laying the cell out as a row puts the tile's
               basis back on the axis it was written for. */
            flexDirection: 'row',
          }}
        >
          <StatTile {...item} compact transparent />
        </View>
      ))}
    </View>
  );
}

/** A plain row of tiles with real gaps — the backtest stats. */
export function StatRow({
  items,
  style,
  testID,
}: {
  items: readonly StatTileProps[];
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View testID={testID} style={[{ flexDirection: 'row', gap: space.s8 }, style]}>
      {items.map((item, index) => (
        <StatTile key={`${item.label}-${index}`} dense {...item} />
      ))}
    </View>
  );
}
