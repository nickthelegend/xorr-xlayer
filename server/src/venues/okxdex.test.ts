/**
 * OKX DEX (`venues/okxdex.ts`): the request signature OKX checks, and a route parsed only from what OKX actually said —
 * an incomplete answer is refused, and the floor is never looser than the leg's tolerance.
 */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OKX_APPROVE_SPENDER, okxConfigured, okxSign, parseOkxSwap, OkxDexError } from './okxdex.js';

afterEach(() => vi.unstubAllEnvs());

describe('signing', () => {
  it('is base64 HMAC-SHA256 over timestamp + method + path-with-query + body', () => {
    const ts = '2026-09-19T12:00:00.000Z';
    const path = '/api/v6/dex/aggregator/quote?chainIndex=196&amount=1000000';
    const expected = createHmac('sha256', 's3cret').update(`${ts}GET${path}`).digest('base64');
    expect(okxSign('s3cret', ts, 'GET', path)).toBe(expected);
    expect(okxSign('s3cret', ts, 'POST', '/x', '{"a":1}')).toBe(
      createHmac('sha256', 's3cret').update(`${ts}POST/x{"a":1}`).digest('base64'),
    );
  });

  it('is configured only when all three credentials are present', () => {
    vi.stubEnv('OKX_API_KEY', 'k');
    vi.stubEnv('OKX_SECRET_KEY', 's');
    vi.stubEnv('OKX_PASSPHRASE', '');
    expect(okxConfigured()).toBe(false);
    vi.stubEnv('OKX_PASSPHRASE', 'p');
    expect(okxConfigured()).toBe(true);
  });
});

describe('a swap route', () => {
  const tx = { to: '0x7c5bee2a8091c3ef39072f64f18fac913060aeaf', data: '0xabcdef', value: '0' };

  it('takes the router, calldata and the approval spender OKX pulls through', () => {
    const r = parseOkxSwap([{ routerResult: { toTokenAmount: '1000000' }, tx }], 0.5);
    expect(r.to.toLowerCase()).toBe(tx.to);
    expect(r.data).toBe('0xabcdef');
    expect(r.spender).toBe(OKX_APPROVE_SPENDER);
    expect(r.expectedOut).toBe(1_000_000n);
  });

  it('holds the floor to the tolerance, and to OKX\'s own minimum when that is tighter', () => {
    expect(parseOkxSwap([{ routerResult: { toTokenAmount: '1000000' }, tx }], 1).minOut).toBe(990_000n);
    expect(
      parseOkxSwap([{ routerResult: { toTokenAmount: '1000000' }, tx: { ...tx, minReceiveAmount: '995000' } }], 1).minOut,
    ).toBe(995_000n);
    // A looser stated minimum never widens the leg's own tolerance.
    expect(
      parseOkxSwap([{ routerResult: { toTokenAmount: '1000000' }, tx: { ...tx, minReceiveAmount: '1' } }], 1).minOut,
    ).toBe(990_000n);
  });

  it('refuses an answer with no transaction or no output amount rather than guessing one', () => {
    expect(() => parseOkxSwap([{ routerResult: { toTokenAmount: '1000' } }], 0.5)).toThrow(OkxDexError);
    expect(() => parseOkxSwap([{ tx }], 0.5)).toThrow(/no output amount/);
    expect(() => parseOkxSwap([], 0.5)).toThrow(OkxDexError);
  });
});
