import { describe, expect, it } from 'vitest';
import {
  MINUS,
  axisLabel,
  businessDaysFromNow,
  clock,
  compactMoney,
  countdown,
  day,
  mmss,
  money,
  movePhrase,
  percent,
  price,
  quantity,
  roundsToZero,
  signedMoney,
  toMinus,
  when,
} from './index';

describe('3.5 formatting rules — state.md', () => {
  it('money uses thousands separators, never bare toFixed', () => {
    // The exact review finding: toFixed on a 4-figure number drops the separator.
    expect(money(4862.18)).toBe('$4,862.18');
    expect(money(1059.84)).toBe('$1,059.84');
    expect((1059.84).toFixed(2)).toBe('1059.84'); // what the bug looked like
    expect(money(63.28)).toBe('$63.28');
  });

  it('negatives use U+2212, never a hyphen', () => {
    expect(MINUS).toBe('−');
    expect(money(-370.02)).toBe(`${MINUS}$370.02`);
    expect(money(-370.02)).not.toContain('-');
    expect(percent(-14.6)).toBe(`${MINUS}14.6%`);
    expect(toMinus('-1.2%')).toBe(`${MINUS}1.2%`);
  });

  it('prices format by magnitude', () => {
    expect(price(66560)).toBe('$66,560'); // >= 1000: no decimals + separators
    expect(price(3412.1)).toBe('$3,412'); // ditto
    expect(price(88.32)).toBe('$88.32'); // < 1000: 2dp
    expect(price(0.1842)).toBe('$0.1842'); // sub-dollar: 4dp
  });

  it('percentages carry an explicit sign at 1dp', () => {
    expect(percent(1)).toBe('+1.0%');
    expect(percent(-1)).toBe(`${MINUS}1.0%`);
    expect(percent(2.4)).toBe('+2.4%');
    expect(percent(0.67, { digits: 2 })).toBe('+0.67%');
  });

  it('crypto quantities are 4dp', () => {
    expect(quantity(12.4)).toBe('12.4000');
    expect(quantity(1750.3, 2)).toBe('1,750.30');
    // The order-ticket conversion: amount / 88.32 to 4dp.
    expect(quantity(250 / 88.32)).toBe('2.8306');
  });

  it('signed money for P&L', () => {
    expect(signedMoney(318.4)).toBe('+$318.40');
    expect(signedMoney(-96)).toBe(`${MINUS}$96.00`);
    expect(signedMoney(1204)).toBe('+$1,204.00');
  });

  /*
   * A figure that prints as zero is never negative. USDC's 24-hour change of −0.0001% printed "−0.00%" on the
   * watchlist: a minus in front of zeros, a fall no digit showed. An explicit sign still reads "+", as every zero
   * percentage does under the formatting rules.
   */
  it('judges the minus on the figure as printed, so zero is never negative', () => {
    expect(percent(-0.0001, { digits: 2 })).toBe('+0.00%');
    expect(percent(0.004, { digits: 2 })).toBe('+0.00%');
    expect(percent(0)).toBe('+0.0%');
    expect(percent(-0.05)).toBe(`${MINUS}0.1%`);
    expect(signedMoney(-0.004)).toBe('+$0.00');
    expect(money(-0.001)).toBe('$0.00');
    expect(quantity(-0.00001)).toBe('0.0000');
    expect(roundsToZero(0.0049, 2)).toBe(true);
    expect(roundsToZero(0.005, 2)).toBe(false);
  });

  /*
   * Screens printed `toLocaleString('en-US')` — "9/14/2026, 7:08:08 AM", seconds and all. Built from local components so
   * the test holds in any zone the suite runs in.
   */
  it('says a moment the way a person reads one', () => {
    const now = new Date(2026, 8, 15, 12, 0).getTime();
    expect(when(new Date(2026, 8, 14, 7, 8, 8).getTime(), now)).toBe('Sep 14, 7:08 AM');
    expect(when(new Date(2025, 11, 31, 23, 5).getTime(), now)).toBe('Dec 31, 2025, 11:05 PM');
    expect(day(new Date(2026, 8, 14).getTime(), now)).toBe('Sep 14');
    expect(day(new Date(2025, 0, 2).getTime(), now)).toBe('Jan 2, 2025');
    expect(clock(new Date(2026, 8, 14, 7, 8, 8).getTime())).toBe('7:08 AM');
    expect(when(Number.NaN, now)).toBe('—');
    expect(clock(Number.NaN)).toBe('—');
  });

  it('compact notional for stat tiles', () => {
    expect(compactMoney(182_400_000)).toBe('$182.4M');
    expect(compactMoney(1_060_000_000)).toBe('$1.06B');
  });

  it('axis labels derive from the projection, in K', () => {
    expect(axisLabel(66740)).toBe('66.7K');
    expect(axisLabel(65060)).toBe('65.1K');
  });

  it('countdowns', () => {
    expect(countdown(8078)).toBe('02:14:38'); // screen 25 "Next funding"
    expect(mmss(252)).toBe('4:12'); // screen 12 "expires 4:12"
    expect(mmss(0)).toBe('0:00');
    expect(mmss(-5)).toBe('0:00');
  });

  it('settlement dates are relative, not the hardcoded "Tue, Sep 8" [G42]', () => {
    // Friday 2026-09-04 + 2 business days = Tuesday 2026-09-08.
    const friday = new Date('2026-09-04T12:00:00Z');
    expect(businessDaysFromNow(2, friday)).toBe('Tue, Sep 8');
    // and it moves with the calendar, which the hardcoded string could not.
    const monday = new Date('2026-09-07T12:00:00Z');
    expect(businessDaysFromNow(2, monday)).toBe('Wed, Sep 9');
  });
});

describe('movePhrase', () => {
  it('names the direction the figure supports', () => {
    expect(movePhrase(1.24)).toBe('up 1.2%');
    expect(movePhrase(-0.42)).toBe('down 0.4%');
  });

  it("says flat when the change rounds to nothing — never 'down 0.0%'", () => {
    expect(movePhrase(-0.04)).toBe('flat');
    expect(movePhrase(0)).toBe('flat');
    expect(movePhrase(0.049)).toBe('flat');
  });

  it('keeps a direction for the smallest change that still shows', () => {
    expect(movePhrase(0.05)).toBe('up 0.1%');
    expect(movePhrase(-0.05)).toBe('down 0.1%');
  });
});
