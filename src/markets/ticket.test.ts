/**
 * The ticket refuses on screen what the wallet cannot do, with the reason — before the executor has to.
 */
import { describe, expect, it } from 'vitest';
import { sellMax, ticketLimit } from './ticket';

const sell = (held: number | 'loading' | 'unread', amountUsd = 250) =>
  ticketLimit({ side: 'sell', symbol: 'XBTC', amountUsd, cashUsd: 5_000, held });

describe('a sale is checked against the holding', () => {
  it('refuses a sale of something the wallet does not hold', () => {
    expect(sell(0)).toEqual({ state: 'refused', reason: 'You hold no XBTC.' });
    // A sale's leftover dust is not a holding.
    expect(sell(0.004)).toEqual({ state: 'refused', reason: 'You hold no XBTC.' });
  });

  it('refuses more than is held, and says how much is', () => {
    expect(sell(120.5)).toEqual({ state: 'refused', code: 'insufficient', reason: 'You hold $120.50 of XBTC.' });
  });

  it('lets a sale up to the whole holding through', () => {
    expect(sell(250)).toEqual({ state: 'ok' });
    expect(sell(1_000)).toEqual({ state: 'ok' });
  });

  it('does not pass a sale while the holding is unread, and says so when the read failed', () => {
    expect(sell('loading')).toEqual({ state: 'checking' });
    expect(sell('unread')).toEqual({ state: 'refused', reason: 'Your holding did not load.' });
  });

  it('never ignores the holding because cash would cover the amount', () => {
    expect(ticketLimit({ side: 'sell', symbol: 'WOKB', amountUsd: 10, cashUsd: 1e6, held: 0 }).state).toBe('refused');
  });
});

describe('a buy is checked against cash, where cash is known', () => {
  it('refuses more than the cash', () => {
    expect(ticketLimit({ side: 'buy', symbol: 'XBTC', amountUsd: 500, cashUsd: 320, held: 0 })).toEqual({
      state: 'refused',
      code: 'insufficient',
      reason: 'You have $320.00.',
    });
  });

  it('does not refuse on a balance it has not read, and never on the holding', () => {
    expect(ticketLimit({ side: 'buy', symbol: 'XBTC', amountUsd: 500, cashUsd: undefined, held: 'unread' })).toEqual({
      state: 'ok',
    });
  });
});

describe('Max on a sale', () => {
  it('is the holding to the cent below, never above it', () => {
    expect(sellMax(120.509)).toBe('120.5');
    expect(sellMax(99.999)).toBe('99.99');
    expect(Number(sellMax(0.01))).toBeLessThanOrEqual(0.01);
  });
});

describe('the amount itself, before any balance', () => {
  const buy = (text: string, cashUsd: number | undefined = 5_000) =>
    ticketLimit({ side: 'buy', symbol: 'XBTC', amountUsd: Number(text) || 0, cashUsd, held: 0, text });

  it('refuses under the executor’s floor rather than sending it', () => {
    expect(buy('0.001')).toEqual({
      state: 'refused',
      code: 'below-minimum',
      reason: 'The smallest order is $0.01.',
    });
  });

  it('refuses over the executor’s ceiling', () => {
    expect(buy('2000000')).toMatchObject({ code: 'above-maximum' });
  });

  it('refuses a fraction of a cent at a real size', () => {
    expect(buy('12.345')).toEqual({ state: 'refused', code: 'too-precise', reason: 'Amounts are to the cent.' });
  });

  it('passes an empty field, which the ticket disables rather than marks wrong', () => {
    expect(buy('')).toEqual({ state: 'ok' });
    expect(buy('0')).toEqual({ state: 'ok' });
  });

  it('holds a sale to the same rules once the position is read', () => {
    expect(
      ticketLimit({ side: 'sell', symbol: 'XBTC', amountUsd: 0.001, cashUsd: 5_000, held: 400, text: '0.001' }),
    ).toMatchObject({ code: 'below-minimum' });
  });

  it('still works for a caller that has only the number', () => {
    // `text` is optional, so the screens that pass a parsed amount keep the behaviour they had.
    expect(ticketLimit({ side: 'buy', symbol: 'XBTC', amountUsd: 500, cashUsd: 320, held: 0 })).toMatchObject({
      code: 'insufficient',
    });
  });
});

describe('the day\'s allowance', () => {
  it('refuses a buy over what the permission allows today, and names the amount left', () => {
    expect(ticketLimit({ side: 'buy', symbol: 'TSLAx', amountUsd: 250, cashUsd: 1_000, held: 0, remainingTodayUsd: 100 })).toEqual({
      state: 'refused',
      reason: 'Your permission allows $100.00 more today.',
    });
    expect(ticketLimit({ side: 'buy', symbol: 'TSLAx', amountUsd: 100, cashUsd: 1_000, held: 0, remainingTodayUsd: 100 }).state).toBe('ok');
  });
  it('says the day is spent when nothing is left, and never blocks a sale on it', () => {
    expect(ticketLimit({ side: 'buy', symbol: 'TSLAx', amountUsd: 10, cashUsd: 1_000, held: 0, remainingTodayUsd: 0 })).toEqual({
      state: 'refused',
      reason: 'Your permission has nothing left to spend today. It resets at midnight UTC.',
    });
    expect(ticketLimit({ side: 'sell', symbol: 'TSLAx', amountUsd: 10, cashUsd: 1_000, held: 50, remainingTodayUsd: 0 }).state).toBe('ok');
  });
  it('does not guess while the allowance is unread', () => {
    expect(ticketLimit({ side: 'buy', symbol: 'TSLAx', amountUsd: 250, cashUsd: 1_000, held: 0 }).state).toBe('ok');
  });
});
