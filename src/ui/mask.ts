/**
 * mask.ts — what a figure shows while balances are hidden (FEATURES.md #47).
 *
 * One tap on Home's balance hides the person's money on every screen: what they hold, what it is worth, what they made
 * and what they moved. Nothing public hides. A price, a quote, a day's change, a funding rate or a market's size says
 * nothing about how much anyone has, and a market screen of dots stops working for no one's privacy.
 *
 * The first version could not tell the two apart. `Price` is handed a formatted string and a quote is written exactly as
 * a holding is, so every dollar figure was masked and Markets read "••••" for BTC. So a figure now says what it is — a
 * `FigureKind`, given where it is drawn — and this decides what each kind shows. Pure, so it is tested where it is written.
 *
 * Percentages and counts stay, since neither says how much. A dash stays: an unknown value masked would pass for a known
 * one. And an amount being typed stays, because an order its author cannot read is not private, it is unusable.
 */
import { Children, cloneElement, isValidElement, type ReactNode } from 'react';

/** Four dots, whatever the figure. A mask as long as the number it covers would say roughly how big that number is. */
export const MASK = '••••';

/**
 * What a figure is: the one thing hidden balances ask of it.
 *
 *   own     The person's money in dollars: a balance, a holding's worth, a P&L, a fill, a cap, proceeds. Its dollar
 *           figures hide, and the words, counts and percentages beside them stay.
 *   units   The person's money in a token's units: "1.5000 WETH", a USDC balance. Every amount in it hides; the unit stays.
 *   market  A price, or public market data. What one unit costs — the market's, a quote's, or the level a position was
 *           entered at or stops at — a change, a funding rate, a market cap, a route's quote for a size nobody holds.
 *           None of it says how much anyone has. Never hidden.
 *   input   An amount being typed or picked. Never hidden.
 */
export type FigureKind = 'own' | 'units' | 'market' | 'input';

/** What a figure hides: nothing, its dollar figures, or every amount in it. */
export type MaskMode = 'none' | 'dollars' | 'amounts';

/**
 * A dollar figure as this app writes one — `money`, `price`, `signedMoney`, `compactMoney` — taking its sign and the "<"
 * in front of dust with it, so the mask does not leave "−" saying which way it went or "< " saying how small it is.
 */
const DOLLARS = /(?:<\s?)?[+−-]?\$\d[\d,]*(?:\.\d+)?[KMB]?/g;

/** Any amount, with a dollar sign or without. A trailing "%" is read with it, so a percentage can be left whole. */
const AMOUNTS = /(?:<\s?)?[+−-]?\$?\d[\d,]*(?:\.\d+)?[KMB]?%?/g;

/**
 * How a figure hides. Shown balances hide nothing; `null` and an unsaid kind are text that is no figure — words, or one
 * character of a figure that was masked whole before it was split.
 */
export function maskMode(hidden: boolean, figure: FigureKind | null | undefined): MaskMode {
  if (!hidden) return 'none';
  if (figure === 'own') return 'dollars';
  if (figure === 'units') return 'amounts';
  return 'none';
}

/** The figure as it shows. A dash or a placeholder stays as it is: an unknown value masked would pass for a known one. */
export function maskFigure(text: string, mode: MaskMode): string {
  if (mode === 'none') return text;
  if (mode === 'dollars') return text.replace(DOLLARS, MASK);
  return text.replace(AMOUNTS, (amount) => (amount.endsWith('%') ? amount : MASK));
}

/** A masked figure as a screen reader says it. The dots would otherwise be read out as "bullet", four times. */
export function spokenFigure(text: string): string {
  return text.split(MASK).join('hidden');
}

/** A line of text with its figures masked, and the whole of it as a screen reader should hear it. */
export type MaskedLine = {
  children: ReactNode;
  /** Undefined where part of the line is not text, such as an icon: there is then no one sentence to say instead. */
  spoken: string | undefined;
};

/**
 * A line as it shows while balances are hidden, or undefined when the mask changes nothing — so a line is drawn exactly
 * as it came unless there is something in it to hide.
 *
 * A line is often more than one string. "Realises +$12.00 and frees $300.00." draws its two figures in their own ink,
 * as `<Text>` spans inside the sentence, and "0.4890 · avg $2,410.00" is a holding's units beside a price. So the line's
 * own words hide by the line's kind, and a span inside it by its own `figure` where it gives one, and by the line's where
 * it does not. The spoken sentence is assembled from the same pieces, because a nested span's own label is never read:
 * a screen reader reads the outermost text, and would read the dots.
 */
export function maskLine(
  children: ReactNode,
  figure: FigureKind | null | undefined,
  hidden: boolean,
): MaskedLine | undefined {
  if (!hidden) return undefined;
  let changed = false;
  let readable = true;
  let spoken = '';

  const walk = (node: ReactNode, kind: FigureKind | null | undefined): ReactNode => {
    if (typeof node === 'string' || typeof node === 'number') {
      const text = String(node);
      const shown = maskFigure(text, maskMode(true, kind));
      spoken += shown;
      if (shown === text) return node;
      changed = true;
      return shown;
    }
    if (node === null || node === undefined || typeof node === 'boolean') return node;
    // Keyed by `Children.map`, since the parts are handed back as a new list.
    if (Array.isArray(node)) return Children.map(node, (child: ReactNode) => walk(child, kind));
    if (isValidElement<{ figure?: FigureKind | null; children?: ReactNode }>(node)) {
      const { figure: own, children: inner } = node.props;
      if (inner === undefined) {
        readable = false;
        return node;
      }
      const shown = walk(inner, own === undefined ? kind : own);
      return shown === inner ? node : cloneElement(node, undefined, shown);
    }
    readable = false;
    return node;
  };

  const shown = walk(children, figure);
  return changed ? { children: shown, spoken: readable ? spokenFigure(spoken) : undefined } : undefined;
}
