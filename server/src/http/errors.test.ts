/**
 * A failure answers with the status that tells the caller what to do next (PLAN.md 1.7).
 *
 * The case that mattered: a chain read that failed was caught inside the route and replaced with a
 * value — `usd: 0`, `null`, `revoked: true` — so the screen stated something false about the user's
 * money. `readChain` makes the failure an error, and this is where that error becomes a 502.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { errorResponse } from './errors.js';
import { ChainReadFailed, readChain } from './chain-read.js';
import { StillFetching } from './deadline.js';
import { NoWalletError } from '../routes/wallet-context.js';

function throwing(make: () => unknown) {
  const app = new Hono();
  app.get('/x', async () => {
    throw make();
  });
  app.onError(errorResponse);
  return app;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a chain read that failed', () => {
  it('is a 502 naming what could not be read — never a zero, never "nothing"', async () => {
    const res = await throwing(() => new ChainReadFailed('your balance', new Error('fetch failed'))).request('/x');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: 'chain_read_failed',
      message: 'Could not read your balance from the chain just now.',
    });
  });
});

describe('readChain', () => {
  it('passes an answer through, including an answer of nothing', async () => {
    expect(await readChain('your permission', async () => null)).toBeNull();
    expect(await readChain('your venues', async () => [])).toEqual([]);
    expect(await readChain('your balance', async () => 42)).toBe(42);
  });

  it('turns a read that threw into ChainReadFailed, keeping what it threw', async () => {
    const cause = new Error('The request took too long to respond.');
    const err = await readChain('your permission', async () => {
      throw cause;
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainReadFailed);
    expect((err as ChainReadFailed).underlying).toBe(cause);
    expect((err as ChainReadFailed).message).toBe('Could not read your permission from the chain just now.');
  });
});

describe('a chain read behind a screen (http/patience.ts)', () => {
  it('that the node never answers gives up at its deadline as ChainReadFailed, and keeps why', async () => {
    // viem's own bound is ten seconds an attempt over four; the app stops waiting at forty-five.
    const started = Date.now();
    const err = await readChain('your balance', () => new Promise<never>(() => {}), 50).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainReadFailed);
    expect(((err as ChainReadFailed).underlying as Error).message).toBe('no answer in 50ms');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('passes a price still on its way through as itself — a late price is not the chain failing', async () => {
    const late = new StillFetching('the price of WETH');
    const err = await readChain(
      'your balance',
      async () => {
        throw late;
      },
      1_000,
    ).catch((e: unknown) => e);
    expect(err).toBe(late);
  });

  it('answers in time exactly as a read without a deadline does', async () => {
    expect(await readChain('your balance', async () => 42, 1_000)).toBe(42);
    expect(await readChain('your permission', async () => null, 1_000)).toBeNull();
  });
});

describe('a read still waiting on upstream', () => {
  it('is a 503 warming with a retry-after and a sentence: a wait, not a failure and not a zero', async () => {
    const res = await throwing(() => new StillFetching('the price of WETH')).request('/x');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toMatchObject({
      error: 'warming',
      detail: 'The price of WETH is still being fetched; try again in a moment.',
    });
  });
});

describe('the failures that were already mapped keep their statuses', () => {
  it('no wallet is 409, a bad body is 400, and anything unexpected is 500', async () => {
    expect((await throwing(() => new NoWalletError()).request('/x')).status).toBe(409);
    expect((await throwing(() => z.object({ a: z.string() }).parse({})).request('/x')).status).toBe(400);
    expect((await throwing(() => new Error('boom')).request('/x')).status).toBe(500);
  });
});
