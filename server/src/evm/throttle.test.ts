/**
 * The value of this helper is entirely in what it does NOT retry.
 *
 * A wrapper that retried everything would turn a dead contract into a slow one, which is worse
 * than a fast failure: the read still fails, four times later, and the reason is buried under
 * latency that looks like a network problem.
 */
import { describe, expect, it, vi } from 'vitest';
import { isThrottle, pastTheThrottle } from './throttle.js';

describe('retrying only an actual throttle', () => {
  it('recognises the words these endpoints actually use', () => {
    expect(isThrottle(new Error('RPC Request failed.\nDetails: over rate limit'))).toBe(true);
    expect(isThrottle(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(isThrottle(new Error('rate limit exceeded'))).toBe(true);
  });

  it('does not mistake a real contract failure for a throttle', () => {
    expect(isThrottle(new Error('execution reverted: PolicyRevoked()'))).toBe(false);
    expect(isThrottle(new Error('contract does not exist'))).toBe(false);
    // The one that matters: a limit that is the CONTRACT's, not the endpoint's.
    expect(isThrottle(new Error('DailyCapExceeded(1600000000, 1700000000)'))).toBe(false);
  });

  it('returns the value once the throttle clears', async () => {
    let calls = 0;
    const work = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('Details: over rate limit');
      return 'the answer';
    });
    expect(await pastTheThrottle(work, 4, 1)).toBe('the answer');
    expect(calls).toBe(3);
  });

  it('gives a real failure straight back, on the first attempt', async () => {
    const work = vi.fn(async () => {
      throw new Error('execution reverted');
    });
    await expect(pastTheThrottle(work, 4, 1)).rejects.toThrow('execution reverted');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('stops after the attempt budget and rethrows the throttle', async () => {
    const work = vi.fn(async () => {
      throw new Error('over rate limit');
    });
    await expect(pastTheThrottle(work, 2, 1)).rejects.toThrow('over rate limit');
    expect(work).toHaveBeenCalledTimes(3);
  });
});
