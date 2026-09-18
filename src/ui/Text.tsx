/**
 * Text.tsx — the one text primitive.
 *
 * Nothing in the app renders RN's `Text` directly. Every string goes through here so that
 * `includeFontPadding: false`, tabular figures and a family-name-selected weight are not
 * things a screen can forget.
 *
 * `<Value>` and `<Price>` are the numeric wrappers. They re-assert `fontVariant` *after*
 * the caller's style, so a stray `fontVariant: []` further up can't turn proportional
 * figures back on in a price column.
 *
 * Two accessibility defaults live here for the same reason (FEATURES.md #74, #86, PLAN.md 5.11): a screen's title is
 * announced as a heading, and each role has a ceiling on how far the phone's text size may grow it.
 *
 * And hidden balances (FEATURES.md #47) are applied here, where every figure is drawn: a text that says what figure it is
 * (`figure`, `mask.ts`) hides the person's money while balances are hidden, and is heard as "hidden" where it was.
 */
import React from 'react';
import {
  Text as RNText,
  type StyleProp,
  type TextProps as RNTextProps,
  type TextStyle,
} from 'react-native';
import { type as typeScale, variantColor, type TypeVariant } from './type';
import { colors } from './tokens';
import { maskFigure, maskLine, maskMode, spokenFigure, type FigureKind } from './mask';
/*
 * App state, read by the design system in this one place: whether balances are hidden (FEATURES.md #47). A tap on Home
 * has to reach every figure on every screen at once, and figures are drawn here. A provider would need the root layout,
 * and a prop would need every screen that shows money.
 */
import { useStore } from '@/state/store';

/** Forced tabular figures. Applied last so a caller's style cannot drop them. */
const lockTabular: TextStyle = { fontVariant: ['tabular-nums'] };

/**
 * How far each role may grow with the phone's text size.
 *
 * Unbounded, a hero balance at the largest accessibility size runs off its line, and a pill's label clips inside a
 * fixed 34pt control. So reading text grows the most, because rows wrap; titles and figures grow less, because they
 * hold one line; and the words inside a fixed-height control grow least. A `Record` over every variant, so a new role
 * cannot ship without a ceiling. The web ignores this and follows the browser's zoom.
 */
const FONT_SCALE_CAP: Readonly<Record<TypeVariant, number>> = {
  heroAmount: 1.15,
  heroBalance: 1.15,
  pnlHero: 1.15,
  priceLg: 1.15,
  priceMd: 1.2,
  priceSm: 1.3,
  amountLg: 1.15,
  amountMd: 1.2,
  onboardingTitle: 1.3,
  titleLg: 1.3,
  screenTitle: 1.3,
  sheetTitle: 1.3,
  cardTitleLg: 1.4,
  cardTitle: 1.4,
  rowPrimaryLg: 1.5,
  rowPrimary: 1.5,
  value: 1.4,
  bodyLg: 1.6,
  body: 1.6,
  bodySm: 1.6,
  secondary: 1.6,
  secondarySm: 1.6,
  delta: 1.3,
  control: 1.2,
  button: 1.2,
  orbName: 1.3,
  orbStatus: 1.3,
  chipSm: 1.2,
  chip: 1.2,
  chipLg: 1.2,
  chipDelta: 1.2,
  eyebrow: 1.3,
  eyebrowSm: 1.3,
  tag: 1.2,
  tagSm: 1.2,
  tabLabel: 1.2,
  footnote: 1.6,
  footnoteSm: 1.6,
};

/** The roles that title a screen or a sheet. Announced as headings, so a screen reader can move between screens' parts. */
const HEADINGS: ReadonlySet<TypeVariant> = new Set<TypeVariant>(['onboardingTitle', 'titleLg', 'screenTitle', 'sheetTitle']);

export type PriceTone = 'neutral' | 'up' | 'down';

const toneColor: Readonly<Record<PriceTone, string | undefined>> = {
  neutral: undefined,
  up: colors.up,
  down: colors.down,
};

export interface TextProps extends Omit<RNTextProps, 'style'> {
  /** Which role in design.md §2 this string plays. */
  variant?: TypeVariant;
  /** Overrides the variant's default ink. */
  color?: string;
  align?: TextStyle['textAlign'];
  style?: StyleProp<TextStyle>;
  children?: React.ReactNode;
  /**
   * What figure this text is, for hidden balances (`FigureKind` in mask.ts): the person's money (`own`, `units`), or a
   * figure that never hides (`market`, `input`). It covers the whole line, spans inside it included, except a span that
   * gives its own. Unsaid, a text is words and is never masked; `null` is a figure already masked, drawn as it came.
   */
  figure?: FigureKind | null;
}

export const Text = React.forwardRef<RNText, TextProps>(function Text({ figure, ...rest }, ref) {
  // Only a figure asks the store, so the words on every screen do not each subscribe to it.
  return figure ? <FigureText ref={ref} figure={figure} {...rest} /> : <PlainText ref={ref} {...rest} />;
});

const PlainText = React.forwardRef<RNText, Omit<TextProps, 'figure'>>(function PlainText(
  { variant = 'body', color, align, style, accessibilityRole, maxFontSizeMultiplier, ...rest },
  ref,
) {
  return (
    <RNText
      ref={ref}
      accessibilityRole={accessibilityRole ?? (HEADINGS.has(variant) ? 'header' : undefined)}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? FONT_SCALE_CAP[variant]}
      {...rest}
      style={[
        typeScale[variant],
        { color: color ?? variantColor[variant] },
        align ? { textAlign: align } : null,
        style,
      ]}
    />
  );
});

/**
 * A text that is a figure. Shown balances draw it exactly as `PlainText` would; hidden, its money is masked, and a
 * screen reader hears "hidden" where the money was — in the text's own label too, where it was given one.
 */
const FigureText = React.forwardRef<RNText, Omit<TextProps, 'figure'> & { figure: FigureKind }>(function FigureText(
  { figure, children, accessibilityLabel, ...rest },
  ref,
) {
  const hidden = useBalancesHidden();
  const line = maskLine(children, figure, hidden);
  const label =
    accessibilityLabel === undefined
      ? line?.spoken
      : hidden
        ? spokenFigure(maskFigure(accessibilityLabel, maskMode(hidden, figure)))
        : accessibilityLabel;
  return (
    <PlainText ref={ref} accessibilityLabel={label} {...rest}>
      {line ? line.children : children}
    </PlainText>
  );
});

export type ValueProps = TextProps;

/**
 * A number the user reads as a quantity — stepper values, stat tiles, notionals.
 * design.md §5 puts these at 14.5/700; a taller variant can be passed explicitly.
 */
export const Value = React.forwardRef<RNText, ValueProps>(function Value(
  { variant = 'value', style, ...rest },
  ref,
) {
  return <Text ref={ref} variant={variant} {...rest} style={[style, lockTabular]} />;
});

export interface PriceProps extends TextProps {
  /** P&L tone. Green and red mean profit and loss — nothing else ever sets this. */
  tone?: PriceTone;
}

/**
 * The tone a P&L figure takes. Green means profit, red means loss, and **zero is neither**
 * — a flat position rendered in profit-green reads as a win that did not happen, which is
 * the one thing the colour law exists to prevent.
 *
 * Every screen that colours a signed figure goes through here, so "what does zero look
 * like" is answered once instead of per screen.
 *
 * Zero is judged at the figure's printed precision (`digits`, 2 by default). USDC's 24-hour change of −0.0001% printed
 * as 0.00% and still took the loss colour, a fall no digit on screen showed.
 */
export function pnlTone(value: number, digits = 2): PriceTone {
  if (Math.abs(value) < 0.5 * 10 ** -digits) return 'neutral';
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'neutral';
}

/** Whether balances are hidden — for a figure drawn outside `Price` that has to hide along with it. */
export function useBalancesHidden(): boolean {
  return useStore((s) => s.balancesHidden);
}

/**
 * A label as a screen reader should hear it while balances are hidden, for text no `<Text>` draws: a control's own
 * `accessibilityLabel`, which carries the figures it names. Shown balances hear it as written.
 */
export function useSpokenFigure(): (text: string, figure: FigureKind) => string {
  const hidden = useBalancesHidden();
  return (text, figure) => spokenFigure(maskFigure(text, maskMode(hidden, figure)));
}

/**
 * A span of a line that is a different figure from the rest of it, drawn in the line's own ink — the units in
 * "0.4890 · avg $2,410.00", where the quantity is the person's and the average is a price. Only inside a `<Text>` that
 * says what the rest of its line is, which is what reads the whole line out while balances are hidden.
 */
export function FigureSpan({ figure, children }: { figure: FigureKind; children: string }) {
  const hidden = useBalancesHidden();
  return maskFigure(children, maskMode(hidden, figure));
}

/**
 * A price or a P&L figure. `tone` is the only sanctioned way to colour text green or red.
 *
 * Pass an already-formatted string: state.md requires `toLocaleString('en-US')` with
 * explicit fraction digits, and U+2212 rather than a hyphen for negatives. This component
 * does not format — it would have to guess the fraction digits, and a guess in a price
 * column is worse than no help at all.
 *
 * Its `figure` is `own` unless it says otherwise, so while balances are hidden its dollar
 * figures are masked (FEATURES.md #47). That is the safe way round: a figure that forgot to
 * say shows dots, where a balance left showing is the one failure a privacy switch cannot
 * have. A price on a market screen says `figure="market"` and is never masked.
 */
export const Price = React.forwardRef<RNText, PriceProps>(function Price(
  { variant = 'rowPrimary', tone = 'neutral', color, style, figure = 'own', ...rest },
  ref,
) {
  return (
    <Text
      ref={ref}
      variant={variant}
      color={color ?? toneColor[tone]}
      figure={figure}
      {...rest}
      style={[style, lockTabular]}
    />
  );
});
