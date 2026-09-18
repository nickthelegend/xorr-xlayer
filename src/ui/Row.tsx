/**
 * Row.tsx — the hairline list row.
 *
 * design.md §5:
 *   height 48–66 · align-items:center · gap 12 · border-bottom: hairline
 *   no horizontal padding (the screen gutter provides it)
 *   [mark 30–34] [primary 14.5/600 + secondary 11.5/ink38] [flex:1] [value + delta]
 *
 * The final row keeps its border — the app treats it as a section terminator rather than
 * special-casing the last child. Pass `divider={false}` where a row genuinely ends a list
 * with nothing under it.
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import type { FigureKind } from './mask';
import { Press } from './Press';
import { Text, Price, type PriceTone } from './Text';
import { colors, divider as dividerStyle, size, space } from './tokens';

export interface RowProps {
  /** Leading mark — an `AgentOrb`, an asset square, a status dot. */
  left?: React.ReactNode;
  /** Row primary line. */
  title?: React.ReactNode;
  /**
   * Row secondary line, under the primary. A string, or a line in parts — a string beside a `FigureSpan` — which is
   * drawn in the same ink.
   */
  secondary?: React.ReactNode;
  /** Right-aligned value. */
  value?: React.ReactNode;
  /** Right-aligned delta, under the value. */
  delta?: React.ReactNode;
  /** P&L tone for `delta`. The only reason a row shows colour. */
  deltaTone?: PriceTone;
  /** Anything at the trailing edge instead of value/delta — a switch, a chevron, a pill. */
  /**
   * Between the title block and the value column. screens.md puts the watchlist sparkline
   * here — "a 90×30 sparkline between symbol and price" — which `right` cannot express,
   * because `right` sits after the price.
   */
  middle?: React.ReactNode;
  right?: React.ReactNode;
  /** §5: 48–66. Defaults to 56. */
  height?: number;
  /** The hairline under the row. */
  divider?: boolean;
  onPress?: () => void;
  /** Renders on the light sheet, so the divider and ink flip. */
  light?: boolean;
  /** Replaces the whole structured body — for a plain label/value pair. */
  children?: React.ReactNode;
  /**
   * What the row's figures are while balances are hidden (FEATURES.md #47, `mask.ts`): the value, the delta, and the
   * secondary line unless `secondaryFigure` says otherwise. The person's own money unless said, as a `Price` is — so a
   * row of market prices says `figure="market"`. A value or delta passed as an element says its own.
   */
  figure?: FigureKind;
  /** The secondary line's kind where it is not the value's: a run's date and label beside the units it filled. */
  secondaryFigure?: FigureKind;
  /** A title that carries a figure — a strategy's label, "$50 of WETH, weekly". Unsaid, a title is words. */
  titleFigure?: FigureKind;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Row({
  left,
  title,
  secondary,
  value,
  delta,
  deltaTone = 'neutral',
  middle,
  right,
  height = size.row,
  divider = true,
  onPress,
  light = false,
  children,
  figure = 'own',
  secondaryFigure,
  titleFigure,
  style,
  testID,
}: RowProps) {
  const body = children ?? (
    <>
      {left}
      {(title !== undefined || secondary !== undefined) && (
        <View style={{ flex: 1, minWidth: 0 }}>
          {typeof title === 'string' ? (
            <Text
              variant="rowPrimary"
              color={light ? colors.sheet.ink : colors.ink}
              numberOfLines={1}
              figure={titleFigure}
            >
              {title}
            </Text>
          ) : (
            title
          )}
          {/*
            A secondary line can carry money of its own — a holding's units, what a strategy spends a day — so it is a
            figure like the value column, and hides with it while balances are hidden.
          */}
          {typeof secondary === 'string' || Array.isArray(secondary) ? (
            <Text
              variant="secondarySm"
              color={light ? colors.sheet.muted : colors.ink38}
              numberOfLines={1}
              style={{ marginTop: space.s2 }}
              figure={secondaryFigure ?? figure}
            >
              {secondary}
            </Text>
          ) : (
            secondary
          )}
        </View>
      )}
      {title === undefined && secondary === undefined && <View style={{ flex: 1 }} />}
      {middle}
      {(value !== undefined || delta !== undefined) && (
        <View style={{ alignItems: 'flex-end' }}>
          {typeof value === 'string' ? (
            <Price
              variant="rowPrimary"
              color={light ? colors.sheet.ink : colors.ink}
              numberOfLines={1}
              figure={figure}
            >
              {value}
            </Price>
          ) : (
            value
          )}
          {typeof delta === 'string' ? (
            <Price
              variant="delta"
              tone={deltaTone}
              numberOfLines={1}
              style={{ marginTop: space.s2 }}
              figure={figure}
            >
              {delta}
            </Price>
          ) : (
            delta
          )}
        </View>
      )}
      {right}
    </>
  );

  const rowStyle: StyleProp<ViewStyle> = [
    {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.s12,
      height,
    },
    divider
      ? light
        ? { borderBottomWidth: 1, borderBottomColor: colors.sheet.tick }
        : dividerStyle
      : null,
    style,
  ];

  if (!onPress) {
    return (
      <View testID={testID} style={rowStyle}>
        {body}
      </View>
    );
  }

  return (
    <Press testID={testID} onPress={onPress} style={rowStyle} accessibilityRole="button">
      {body}
    </Press>
  );
}
