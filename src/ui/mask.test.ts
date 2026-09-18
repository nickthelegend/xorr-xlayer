/**
 * Hidden balances (FEATURES.md #47): what a figure shows while they are hidden.
 *
 * The figures are the formatters' own output rather than hand-typed strings, so a change to how money is written that
 * the mask no longer recognises fails here instead of leaving an amount on screen. And the screens are read for the
 * mistake a quiet default invites: a market price drawn as though it were a balance, and masked.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactMoney, money, percent, price, quantity, signedMoney } from '@/format';
import { MASK, maskFigure, maskLine, maskMode, spokenFigure, type FigureKind } from './mask';

/** A span of a line, as `<Text>` and `FigureSpan` are to `maskLine`: children, and perhaps a kind of its own. */
const Span = (props: { figure?: FigureKind | null; children?: ReactNode }) => props.children;

describe('maskMode', () => {
  it('masks nothing while balances are shown, whatever the figure is', () => {
    for (const kind of ['own', 'units', 'market', 'input', null, undefined] as const) {
      expect(maskMode(false, kind), String(kind)).toBe('none');
    }
  });

  it("hides the dollar figures of the person's money, and every amount of it in units", () => {
    expect(maskMode(true, 'own')).toBe('dollars');
    expect(maskMode(true, 'units')).toBe('amounts');
  });

  it('never hides a market figure, an amount being typed, or text that is no figure', () => {
    for (const kind of ['market', 'input', null, undefined] as const) {
      expect(maskMode(true, kind), String(kind)).toBe('none');
    }
  });
});

describe('a market price is never masked', () => {
  // What a market screen draws: prices at every magnitude, a move, a market's size, a rate, a quote, a fee, a range.
  const market = [
    price(66560),
    price(88.32),
    price(0.1842),
    money(2410),
    signedMoney(-96),
    compactMoney(182_400_000),
    percent(-5.4),
    `${quantity(0.0421)} WETH`,
    `On us · ≈ ${money(0.02)}`,
    `${money(2400, { fractionDigits: 0 })}–${money(2600, { fractionDigits: 0 })}`,
  ];

  it('as a figure', () => {
    for (const figure of market) expect(maskFigure(figure, maskMode(true, 'market')), figure).toBe(figure);
  });

  it('as a line, which is then drawn exactly as it came', () => {
    for (const figure of market) expect(maskLine(figure, 'market', true), figure).toBeUndefined();
  });

  it('nor beside a holding, where only the holding hides', () => {
    // Holdings: "0.4890 · avg $2,410.00". The units are the person's; what one unit cost is a price.
    const line = maskLine([createElement(Span, { key: 'units', figure: 'units' }, quantity(0.489)), ` · avg ${money(2410)}`], 'market', true);
    expect(line?.spoken).toBe(`hidden · avg ${money(2410)}`);
  });
});

describe('an amount being typed is never masked', () => {
  it('however it is written', () => {
    for (const typed of ['$250', '250', money(250), `${quantity(1.5)} WETH`]) {
      expect(maskFigure(typed, maskMode(true, 'input')), typed).toBe(typed);
      expect(maskLine(typed, 'input', true), typed).toBeUndefined();
    }
  });
});

describe("the person's money in dollars", () => {
  const own = (text: string) => maskFigure(text, maskMode(true, 'own'));

  it('hides every dollar figure the formatters write, sign and all', () => {
    const figures = [
      money(4862.18),
      money(-4.22),
      money(1600, { fractionDigits: 0 }),
      signedMoney(590),
      signedMoney(-96),
      price(66560),
      price(0.1842),
      compactMoney(182_400_000),
    ];
    for (const figure of figures) expect(own(figure), figure).toBe(MASK);
  });

  it('keeps the words and percentages beside a figure', () => {
    expect(own(`${signedMoney(12.4)} · ${percent(0.5)} open`)).toBe(`${MASK} · +0.5% open`);
    expect(own(`${money(1600, { fractionDigits: 0 })}/day`)).toBe(`${MASK}/day`);
    expect(own(`≈ ${money(0.01)}`)).toBe(`≈ ${MASK}`);
    expect(own(`Added ${money(100)}.`)).toBe(`Added ${MASK}.`);
  });

  it('does not say how small dust is', () => {
    expect(own(`< ${money(0.01)}`)).toBe(MASK);
  });

  it('leaves counts, units, percentages and unknowns alone', () => {
    const figures = [quantity(0.489), `${quantity(1.5)} WETH`, percent(-5.4), '12 trades', '3/9', '55%', '—', '· · ·'];
    for (const figure of figures) expect(own(figure), figure).toBe(figure);
  });
});

describe("the person's money in units", () => {
  const units = (text: string) => maskFigure(text, maskMode(true, 'units'));

  it('hides every amount, and keeps the unit it is in', () => {
    expect(units(quantity(1234.5, 2))).toBe(MASK);
    expect(units(`${quantity(1.5)} WETH`)).toBe(`${MASK} WETH`);
    expect(units(`Sold ${quantity(0.5)} WETH for ${money(1200)}.`)).toBe(`Sold ${MASK} WETH for ${MASK}.`);
    // The executor writes a panic sale's amount as dollars with the token after it.
    expect(units(`${money(1234.56)} USDC`)).toBe(`${MASK} USDC`);
  });

  it('does not say how small dust is', () => {
    expect(units(`< ${quantity(0.0001)} WETH`)).toBe(`${MASK} WETH`);
  });

  it('keeps a percentage whole, sign and all', () => {
    expect(units(`${quantity(1.5)} WETH · ${percent(2)}`)).toBe(`${MASK} WETH · +2.0%`);
    expect(units(percent(-5.4))).toBe(percent(-5.4));
  });

  it('never masks a dash, a placeholder or a word', () => {
    for (const unknown of ['—', '· · ·', 'No token moved', 'nothing']) expect(units(unknown), unknown).toBe(unknown);
  });
});

describe('maskLine', () => {
  it('changes nothing while balances are shown', () => {
    expect(maskLine(money(4862.18), 'own', false)).toBeUndefined();
  });

  it('changes nothing when there is nothing in the line to hide', () => {
    expect(maskLine('12 trades', 'own', true)).toBeUndefined();
    expect(maskLine(percent(1), 'units', true)).toBeUndefined();
    expect(maskLine(['Close ', 25, '%'], 'own', true)).toBeUndefined();
  });

  it('masks a line of one string, and says the mask as a word', () => {
    expect(maskLine(money(4862.18), 'own', true)).toEqual({ children: MASK, spoken: 'hidden' });
  });

  it("masks the spans of a sentence by the sentence's own kind, and reads it out whole", () => {
    // Position: "Realises +$12.00 and frees $300.00.", its figures in their own ink.
    const line = maskLine(
      ['Realises ', createElement(Span, null, signedMoney(12)), ' and frees ', createElement(Span, null, money(300)), '.'],
      'own',
      true,
    );
    expect(line?.spoken).toBe('Realises hidden and frees hidden.');
    const spans = (line?.children as ReactNode[]).filter(isValidElement) as ReactElement<{ children: string }>[];
    expect(spans.map((span) => span.props.children)).toEqual([MASK, MASK]);
  });

  it('leaves a span that says it is no figure as it came', () => {
    // One character of a rolling number, masked already with the figure it came from.
    const line = maskLine([createElement(Span, { key: 'digit', figure: null }, '5'), ` ${quantity(2)}`], 'units', true);
    expect(line?.spoken).toBe('5 hidden');
  });

  it('still masks a line with a part it cannot read, and then says nothing in its place', () => {
    const line = maskLine([createElement(Span, { key: 'mark' }), money(5)], 'own', true);
    expect(line?.spoken).toBeUndefined();
    expect(line?.children as ReactNode[]).toContain(MASK);
  });
});

describe('spokenFigure', () => {
  it('says the mask as a word', () => {
    expect(spokenFigure(MASK)).toBe('hidden');
    expect(spokenFigure(`${MASK} · +0.5% open`)).toBe('hidden · +0.5% open');
  });
});

describe('the screens say which of their figures are prices', () => {
  /*
   * A figure is the person's own unless it says otherwise. That is the safe way round for a balance, and it makes the
   * easy mistake a price that forgot to say so — masked on a market screen, which is the bug this rule was rebuilt for.
   * Market prices reach the screens formatted by `fmtPrice` or already as `.px`, so each place one meets a figure
   * component is read here and has to say `figure="market"`.
   */
  const APP = path.resolve(import.meta.dirname, '../../app');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '_dev') walk(p, out);
      } else if (/\.tsx$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /** Each opening tag of a component, whole: `>` inside braces — an arrow, a nested element — does not end it. */
  const openingTags = (src: string, tag: string): { text: string; end: number }[] => {
    const out: { text: string; end: number }[] = [];
    for (const m of src.matchAll(new RegExp(`<${tag}\\b`, 'g'))) {
      let i = m.index + m[0].length;
      let depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        else if (src[i] === '>' && depth === 0) break;
      }
      out.push({ text: src.slice(m.index, i + 1), end: i + 1 });
    }
    return out;
  };
  const PRICE = /fmtPrice\(|\.px\}/;
  const MARKET = /figure="market"/;

  const offenders: string[] = [];
  let marked = 0;
  for (const file of walk(APP)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const where = path.relative(APP, file);
    const check = (tag: string, reaches: boolean, text: string) => {
      if (!reaches) return;
      if (MARKET.test(text)) marked++;
      else offenders.push(`${where}: <${tag}> draws a market price without figure="market"`);
    };
    for (const t of openingTags(src, 'RollingNumber')) check('RollingNumber', PRICE.test(t.text), t.text);
    for (const t of openingTags(src, 'AreaChart')) check('AreaChart', /formatValue=\{fmtPrice\}/.test(t.text), t.text);
    for (const t of openingTags(src, 'Price')) {
      const children = t.text.endsWith('/>') ? '' : src.slice(t.end, src.indexOf('</Price>', t.end));
      check('Price', PRICE.test(children), t.text);
    }
    for (const t of openingTags(src, 'Row')) {
      // A value passed as its own element says its own kind; what is left is what the row draws itself.
      const own = t.text.replace(/<Price\b[\s\S]*?<\/Price>/g, '').replace(/<Text\b[\s\S]*?<\/Text>/g, '');
      check('Row', PRICE.test(own), own);
    }
  }

  it('finds them', () => {
    expect(marked).toBeGreaterThan(15);
  });

  it('marks every one of them as market', () => {
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
