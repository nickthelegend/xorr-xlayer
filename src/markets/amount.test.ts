/**
 * The rules an amount is held to before anything is sent, and the sentences they produce.
 */
import { describe, expect, it } from 'vitest';
import {
  AMOUNT_DECIMALS,
  ORDER_MAX_USD,
  ORDER_MIN_USD,
  checkAmount,
  decimalsTyped,
} from './amount';

type Rest = Omit<Parameters<typeof checkAmount>[0], 'text'>;

const check = (text: string, rest: Rest = {}) => checkAmount({ text, ...rest });

describe('an amount still being typed is not an amount being got wrong', () => {
  it('says nothing about an empty field', () => {
    expect(check('')).toEqual({ state: 'empty' });
    expect(check('   ')).toEqual({ state: 'empty' });
  });

  it('says nothing about a zero, which is where the keypad starts', () => {
    // `keypadPress` leaves '0' behind after a backspace to empty, so refusing it would put a red
    // sentence under every field the moment someone cleared it.
    expect(check('0')).toEqual({ state: 'empty' });
    expect(check('0.')).toEqual({ state: 'empty' });
    expect(check('0.00')).toEqual({ state: 'empty' });
    expect(check('.')).toEqual({ state: 'empty' });
  });
});

describe('precision', () => {
  it('counts the digits typed, not the digits the number has', () => {
    expect(decimalsTyped('12')).toBe(0);
    expect(decimalsTyped('12.')).toBe(0);
    expect(decimalsTyped('12.5')).toBe(1);
    // 0.10 and 0.1 are the same number and not the same typing. Cents are two digits either way.
    expect(decimalsTyped('0.10')).toBe(2);
  });

  it('refuses a fraction of a cent, and says the rule rather than the mistake', () => {
    expect(check('12.345')).toEqual({
      state: 'refused',
      code: 'too-precise',
      reason: 'Amounts are to the cent.',
    });
    expect(AMOUNT_DECIMALS).toBe(2);
  });

  it('takes exactly two decimals', () => {
    expect(check('12.34')).toEqual({ state: 'ok', usd: 12.34 });
  });
});

describe('the executor’s own bounds', () => {
  it('refuses below the minimum with the minimum in it', () => {
    expect(check('0.001')).toMatchObject({ code: 'below-minimum' });
    // A sub-cent amount is also over-precise, and only one of the two sentences helps: "to the cent"
    // would leave someone typing $0.00, where the floor tells them to type $0.01.
    expect(check('0.005')).toMatchObject({ code: 'below-minimum', reason: 'The smallest order is $0.01.' });
    expect(check('0.01')).toEqual({ state: 'ok', usd: ORDER_MIN_USD });
  });

  it('refuses above the ceiling the route enforces', () => {
    expect(check(String(ORDER_MAX_USD + 1))).toMatchObject({
      code: 'above-maximum',
      reason: 'The largest order is $1,000,000.',
    });
    expect(check(String(ORDER_MAX_USD))).toEqual({ state: 'ok', usd: ORDER_MAX_USD });
  });

  it('takes a caller’s tighter bounds over the defaults', () => {
    expect(check('5', { minUsd: 10 })).toMatchObject({ code: 'below-minimum', reason: 'The smallest order is $10.00.' });
    expect(check('5000', { maxUsd: 1_000 })).toMatchObject({ code: 'above-maximum' });
  });
});

describe('what can pay for it', () => {
  const available = { usd: 320, reason: (usd: number) => `You have $${usd.toFixed(2)}.` };

  it('refuses more than there is, in the caller’s own words', () => {
    expect(check('500', { available })).toEqual({
      state: 'refused',
      code: 'insufficient',
      reason: 'You have $320.00.',
    });
  });

  it('allows spending all of it', () => {
    expect(check('320', { available })).toEqual({ state: 'ok', usd: 320 });
  });

  it('never blames the balance for a malformed amount', () => {
    // "$0.001 is more than you have" for someone holding $320 sends them to the wrong fix.
    expect(check('0.001', { available })).toMatchObject({ code: 'below-minimum' });
    expect(check('2000000', { available })).toMatchObject({ code: 'above-maximum' });
  });

  it('does not refuse while the balance is still unread', () => {
    expect(check('500')).toEqual({ state: 'ok', usd: 500 });
  });
});

describe('what is not a number', () => {
  it('refuses text and negatives', () => {
    expect(check('abc')).toMatchObject({ code: 'not-a-number' });
    expect(check('-5')).toMatchObject({ code: 'not-a-number' });
  });
});
