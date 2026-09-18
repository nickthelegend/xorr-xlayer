/**
 * The value is in what it does NOT retry: a 404, a 422 and a 401 are answers, and making a correct
 * refusal arrive four times slower is not an improvement.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiError';
import { waitOutWarming } from './warming';

describe('waiting out a warming 503', () => {
  it('returns the value once the route stops warming', async () => {
    let calls = 0;
    const read = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new ApiError(503, 'warming');
      return 'the backtest';
    });
    await expect(waitOutWarming(read, 4, 1)).resolves.toBe('the backtest');
    expect(calls).toBe(3);
  });

  it('gives a 404 straight back, on the first attempt', async () => {
    const read = vi.fn(async () => {
      throw new ApiError(404, 'no such agent');
    });
    await expect(waitOutWarming(read, 4, 1)).rejects.toBeInstanceOf(ApiError);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('gives a 422 straight back — "not backtestable" is an answer', async () => {
    const read = vi.fn(async () => {
      throw new ApiError(422, 'not_backtestable');
    });
    await expect(waitOutWarming(read, 4, 1)).rejects.toBeInstanceOf(ApiError);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('stops after the budget and rethrows the 503 for the screen to show', async () => {
    const read = vi.fn(async () => {
      throw new ApiError(503, 'warming');
    });
    await expect(waitOutWarming(read, 3, 1)).rejects.toBeInstanceOf(ApiError);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-HTTP failure', async () => {
    const read = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(waitOutWarming(read, 4, 1)).rejects.toBeInstanceOf(TypeError);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
