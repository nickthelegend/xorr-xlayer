/**
 * A money action tapped again after a timeout carries the key it first went out with; anything asked afresh gets a new
 * one (FEATURES.md #29). The lifecycle runs end to end against the one boundary it has: a request handed a key.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, NotSignedIn, TimedOut } from './apiError';
import {
  IDEMPOTENCY_KEY_MAX,
  heldAfter,
  intentKeys,
  intentOf,
  keyForAsk,
  keyHeaders,
  newIdempotencyKey,
  outcomeKnown,
} from './intentKey';

const inFlight = () =>
  new ApiError(409, '409 Conflict', {
    error: 'request_in_flight',
    message: 'An identical request is still being processed.',
  });

/** Keys numbered in the order they are made, so a test can say which attempt sent which. */
function numbered() {
  let n = 0;
  return intentKeys(() => `key-${++n}`);
}

describe('a key', () => {
  it('fits inside the executor’s 200 characters, and does not repeat', () => {
    expect(IDEMPOTENCY_KEY_MAX).toBe(200);
    const keys = new Set(Array.from({ length: 1000 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(1000);
    for (const key of keys) expect(key.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX);
  });

  it('is plain hex, safe to send as a header', () => {
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f]+$/);
    expect(newIdempotencyKey(() => 0.999, 0xabc)).toBe(`${'f'.repeat(32)}abc`);
  });

  it('travels as the idempotency-key header, and a write without one sends none', () => {
    expect(keyHeaders({ idempotencyKey: 'abc' })).toEqual({ 'idempotency-key': 'abc' });
    expect(keyHeaders(undefined)).toEqual({});
    expect(keyHeaders({})).toEqual({});
  });
});

describe('an intent', () => {
  it('is the same ask however its fields were put together', () => {
    expect(intentOf({ from: 'USDC', to: 'XBTC', amount: '100', slippagePct: 0.3 })).toBe(
      intentOf({ slippagePct: 0.3, amount: '100', to: 'XBTC', from: 'USDC' }),
    );
  });

  it('is another ask when the amount, the token, the side or the tolerance changes', () => {
    const buy = intentOf({ side: 'buy', symbol: 'XBTC', usd: 250 });
    expect(intentOf({ side: 'buy', symbol: 'XBTC', usd: 251 })).not.toBe(buy);
    expect(intentOf({ side: 'buy', symbol: 'WOKB', usd: 250 })).not.toBe(buy);
    expect(intentOf({ side: 'sell', symbol: 'XBTC', usd: 250 })).not.toBe(buy);
    const swap = intentOf({ from: 'USDC', to: 'XBTC', amount: '100', slippagePct: 0.3 });
    expect(intentOf({ from: 'USDC', to: 'XBTC', amount: '100', slippagePct: 0.5 })).not.toBe(swap);
  });

  it('keeps its key when asked again, and gets a new one when anything else is asked', () => {
    let n = 0;
    const mint = () => `key-${++n}`;
    const first = keyForAsk(undefined, 'a', mint);
    expect(keyForAsk(first, 'a', mint)).toBe(first);
    expect(keyForAsk(first, 'b', mint)).toEqual({ intent: 'b', key: 'key-2' });
  });
});

describe('whether an attempt’s outcome is known', () => {
  it('is not, while the request may still be running or may have run', () => {
    expect(outcomeKnown(new TimedOut('/orders', 180_000, 'abc'))).toBe(false);
    expect(outcomeKnown(new TypeError('Network request failed'))).toBe(false);
    expect(outcomeKnown(new ApiError(502, '502 Bad Gateway'))).toBe(false);
    expect(outcomeKnown(new ApiError(504, '504 Gateway Timeout'))).toBe(false);
    expect(outcomeKnown(new ApiError(408, '408 Request Timeout'))).toBe(false);
    expect(outcomeKnown(inFlight())).toBe(false);
  });

  it('is, once the executor has answered, or when nothing was sent', () => {
    expect(
      outcomeKnown(new ApiError(409, '409', { status: 'blocked', reason: 'cap_spent', detail: 'The daily cap is spent.' })),
    ).toBe(true);
    expect(outcomeKnown(new ApiError(400, '400', { error: 'invalid_request' }))).toBe(true);
    expect(
      outcomeKnown(
        new ApiError(422, '422', {
          error: 'idempotency_key_reused',
          message: 'That key was already used for POST /orders.',
        }),
      ),
    ).toBe(true);
    // Stored against the key by the layer in front of the limiter: only a new key gets past it.
    expect(outcomeKnown(new ApiError(429, '429', { error: 'rate_limited' }))).toBe(true);
    expect(outcomeKnown(new NotSignedIn('/orders'))).toBe(true);
  });
});

describe('a screen’s keys', () => {
  const buy = { side: 'buy', symbol: 'XBTC', usd: 250 };

  it('send the same key when the same order is tapped again after a timeout', async () => {
    const keys = numbered();
    const sent: string[] = [];
    await expect(
      keys.send(buy, async (key) => {
        sent.push(key);
        throw new TimedOut('/orders', 180_000);
      }),
    ).rejects.toBeInstanceOf(TimedOut);
    await expect(
      keys.send(buy, async (key) => {
        sent.push(key);
        return { status: 'filled' };
      }),
    ).resolves.toEqual({ status: 'filled' });
    expect(sent).toEqual(['key-1', 'key-1']);
  });

  it('keep the key through a gateway timeout and while the executor says the first is still running', async () => {
    const keys = numbered();
    const sent: string[] = [];
    const attempt = (answer: () => Promise<unknown>) =>
      keys.send(buy, (key) => {
        sent.push(key);
        return answer();
      });
    await attempt(() => Promise.reject(new ApiError(504, '504 Gateway Timeout'))).catch(() => undefined);
    await attempt(() => Promise.reject(inFlight())).catch(() => undefined);
    await attempt(() => Promise.resolve({ status: 'filled' }));
    expect(sent).toEqual(['key-1', 'key-1', 'key-1']);
  });

  it('make a new key for a changed amount: that is a new order', async () => {
    const keys = numbered();
    const sent: string[] = [];
    await keys
      .send(buy, async (key) => {
        sent.push(key);
        throw new TimedOut('/orders', 180_000);
      })
      .catch(() => undefined);
    await keys.send({ ...buy, usd: 300 }, async (key) => {
      sent.push(key);
      return { status: 'filled' };
    });
    expect(sent).toEqual(['key-1', 'key-2']);
  });

  it('spend the key on an answer, so the same order placed again is a second order, not a replay', async () => {
    const keys = numbered();
    const sent: string[] = [];
    for (let i = 0; i < 2; i++) {
      await keys.send(buy, async (key) => {
        sent.push(key);
        return { status: 'filled' };
      });
    }
    expect(sent).toEqual(['key-1', 'key-2']);
  });

  it('spend it on a refusal too, so a later identical order is not answered with the stored refusal', async () => {
    const keys = numbered();
    const sent: string[] = [];
    const refused = new ApiError(409, '409', { status: 'blocked', reason: 'cap_spent', detail: 'The daily cap is spent.' });
    await keys
      .send(buy, async (key) => {
        sent.push(key);
        throw refused;
      })
      .catch(() => undefined);
    await keys
      .send(buy, async (key) => {
        sent.push(key);
        throw new ApiError(422, '422', { error: 'idempotency_key_reused' });
      })
      .catch(() => undefined);
    await keys.send(buy, async (key) => {
      sent.push(key);
      return { status: 'filled' };
    });
    expect(sent).toEqual(['key-1', 'key-2', 'key-3']);
  });

  it('pass on what the request threw, untouched', async () => {
    const keys = numbered();
    const refused = new ApiError(422, '422', {
      error: 'idempotency_key_reused',
      message: 'That key was already used for POST /orders.',
    });
    await expect(keys.send(buy, () => Promise.reject(refused))).rejects.toBe(refused);
  });

  it('share one key across a double tap, and a late in-flight answer does not revive the key the fill spent', async () => {
    const keys = numbered();
    const sent: string[] = [];
    let fill!: (value: unknown) => void;
    let refuse!: (error: unknown) => void;
    const first = keys.send(buy, (key) => {
      sent.push(key);
      return new Promise((resolve) => (fill = resolve));
    });
    const second = keys.send(buy, (key) => {
      sent.push(key);
      return new Promise((_, reject) => (refuse = reject));
    });
    fill({ status: 'filled' });
    await first;
    refuse(inFlight());
    await expect(second).rejects.toBeInstanceOf(ApiError);
    await keys.send(buy, async (key) => {
      sent.push(key);
      return { status: 'filled' };
    });
    expect(sent).toEqual(['key-1', 'key-1', 'key-2']);
  });

  it('never let an older attempt ending touch the key of a newer ask', () => {
    const older = { intent: 'a', key: 'key-1' };
    const newer = { intent: 'b', key: 'key-2' };
    expect(heldAfter(newer, older, false)).toBe(newer);
    expect(heldAfter(newer, older, true)).toBe(newer);
    expect(heldAfter(older, older, false)).toBe(older);
    expect(heldAfter(older, older, true)).toBeUndefined();
  });
});
