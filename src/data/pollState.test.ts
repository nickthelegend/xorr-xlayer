/**
 * A polled balance never blanks on a failed read, and a failure never becomes a number (PLAN.md 4.5).
 */
import { describe, expect, it } from 'vitest';
import { emptyPoll, settlePoll } from './pollState';

describe('settlePoll', () => {
  it('takes an answer, and clears the failure before it', () => {
    const failed = settlePoll(emptyPoll<number>(), { ok: false, error: new Error('timed out'), at: 1 });
    expect(settlePoll(failed, { ok: true, data: 1000, at: 2 })).toEqual({
      data: 1000,
      dataAt: 2,
      error: undefined,
      errorAt: undefined,
    });
  });

  it('keeps the last answer through a failed read, and says when each happened', () => {
    const read = settlePoll(emptyPoll<{ usdc: number }>(), { ok: true, data: { usdc: 1000 }, at: 10 });
    const error = new Error('Could not read your balances from the chain just now.');
    expect(settlePoll(read, { ok: false, error, at: 20 })).toEqual({ data: { usdc: 1000 }, dataAt: 10, error, errorAt: 20 });
  });

  it('before any answer, a failure is only a failure: there is no number to show', () => {
    const state = settlePoll(emptyPoll<number>(), { ok: false, error: new Error('down'), at: 5 });
    expect(state.data).toBeUndefined();
    expect(state.dataAt).toBeUndefined();
    expect(state.error?.message).toBe('down');
  });
});
