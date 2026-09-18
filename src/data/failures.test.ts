/**
 * The failure table, against the answers the executor actually sends.
 *
 * Every body in here was copied from `server/src` rather than invented: the shapes are what the routes,
 * the limiter, the idempotency layer and the error handler put on the wire. A test written against made-up
 * bodies would pass for as long as nobody looked at the server.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, NotSignedIn, TimedOut } from './apiError';
import { SessionExpired } from '@/auth/expiry';
import { classify, waitSentence } from './failures';

const APP = path.resolve(import.meta.dirname, '../../app');

function routeExists(href: string): boolean {
  const rel = href.replace(/^\//, '');
  const groups = readdirSync(APP, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('('))
    .map((e) => e.name);
  return [APP, ...groups.map((g) => path.join(APP, g))].some((base) =>
    ['.tsx', '.ts'].some(
      (ext) => existsSync(path.join(base, `${rel}${ext}`)) || existsSync(path.join(base, rel, `index${ext}`)),
    ),
  );
}

const api = (status: number, body?: unknown, extra: { retryAfterSec?: number } = {}) =>
  new ApiError(status, `${status}`, body, 'req-abcdef123456', extra.retryAfterSec);

describe('not now, and the answer says when', () => {
  it('reads the limiter’s 429 as a wait with its retry-after', () => {
    // `server/src/http/rate-limit.ts` sets the header and this body.
    const f = classify(api(429, { error: 'rate_limited', detail: 'Too many requests.' }, { retryAfterSec: 42 }));
    expect(f).toMatchObject({ kind: 'throttled', retryable: true, retryAfterSec: 42, outcomeUnknown: false });
    // The server's own sentence, not the table's.
    expect(f.message).toBe('Too many requests.');
  });

  it('reads a cold upstream as a wait rather than a failure or a zero', () => {
    // `StillFetching` in `server/src/http/errors.ts`: 503, `warming`, retry-after.
    const f = classify(api(503, { error: 'warming', detail: 'Reading balances for the first time.' }, { retryAfterSec: 5 }));
    expect(f).toMatchObject({ kind: 'source-unavailable', retryable: true, retryAfterSec: 5 });
  });
});

describe('the outcome, which is not the same question as the failure', () => {
  it('never says a timeout failed', () => {
    const f = classify(new TimedOut('/orders', 180_000, 'req-abcdef123456'));
    expect(f.kind).toBe('timeout');
    expect(f.outcomeUnknown).toBe(true);
    expect(f.message).toMatch(/may still be working/i);
    expect(f.fix?.href).toBe('/activity');
  });

  it('keeps a 5xx unknown, because a proxy answers for an executor that is still working', () => {
    expect(classify(api(502, { error: 'boom' })).outcomeUnknown).toBe(true);
    expect(classify(api(500, { error: 'boom' })).outcomeUnknown).toBe(true);
  });

  it('carries the executor’s own "it may have gone through" through intact', () => {
    // `outcomeUnknown()` in `server/src/http/idempotency.ts`.
    const f = classify(
      api(409, {
        error: 'request_outcome_unknown',
        message: 'An earlier attempt with this key stopped without answering after it had sent a transaction.',
      }),
    );
    expect(f).toMatchObject({ kind: 'outcome-unknown', retryable: false, outcomeUnknown: true });
    expect(f.fix?.href).toBe('/activity');
  });

  it('knows a transport failure sent nothing at all', () => {
    for (const message of ['Network request failed', 'Failed to fetch', 'fetch failed', 'ECONNREFUSED']) {
      const f = classify(new Error(message));
      expect(f.kind, message).toBe('offline');
      expect(f.outcomeUnknown, message).toBe(false);
      // None of those three runtime sentences reaches a screen.
      expect(f.message, message).not.toContain('fetch');
    }
  });

  it('treats a duplicate still in flight as neither done nor failed', () => {
    const f = classify(api(409, { error: 'request_in_flight', message: 'An identical request is still being processed.' }));
    expect(f).toMatchObject({ kind: 'duplicate', retryable: false, outcomeUnknown: true });
  });
});

describe('the fix, where there is one', () => {
  it('sends a missing permission to the screen that grants one', () => {
    const f = classify(api(409, { error: 'no_delegation', detail: 'No active trading permission on-chain.' }));
    expect(f).toMatchObject({ kind: 'no-permission', retryable: false });
    expect(f.fix).toEqual({ label: 'Grant permission', href: '/safety' });
  });

  it('sends a spent cap to the limits', () => {
    expect(classify(api(409, { error: 'over_cap' })).fix?.href).toBe('/limits');
    expect(classify(api(409, { error: 'refused_by_policy' })).fix?.href).toBe('/limits');
  });

  it('sends a chain that cannot settle to the networks, and offers no retry', () => {
    const f = classify(api(409, { error: 'not_settleable_here', message: 'NVDAc cannot be settled on base-fork.' }));
    expect(f).toMatchObject({ kind: 'rejected', retryable: false });
    expect(f.fix?.href).toBe('/networks');
  });

  it('only ever points at a screen that exists', () => {
    const codes = [
      'no_delegation',
      'delegation_expired',
      'over_cap',
      'refused_by_policy',
      'not_tradable',
      'not_settleable_here',
      'request_outcome_unknown',
      'no_wallet',
      'needs_gas',
    ];
    for (const error of codes) {
      const fix = classify(api(409, { error })).fix;
      expect(fix, error).toBeDefined();
      expect(routeExists(fix!.href), `${error} → ${fix!.href}`).toBe(true);
    }
    expect(routeExists(classify(new TimedOut('/orders', 1000)).fix!.href)).toBe(true);
  });
});

describe('a retry is offered only where repeating the request could answer differently', () => {
  it('does not offer one for a refusal that will stand', () => {
    for (const error of ['no_delegation', 'over_cap', 'not_tradable', 'invalid_amount', 'idempotency_key_reused']) {
      expect(classify(api(409, { error })).retryable, error).toBe(false);
    }
  });

  it('offers one for everything that is weather', () => {
    for (const error of ['rate_limited', 'warming', 'chain_read_failed', 'subgraph_unavailable', 'price_unavailable']) {
      expect(classify(api(503, { error })).retryable, error).toBe(true);
    }
  });
});

describe('the server’s sentence is never overwritten', () => {
  it('prefers prose in `message`, `detail` and then the code', () => {
    expect(classify(api(409, { error: 'refused_by_policy', message: 'Today’s cap is spent.' })).message).toBe(
      'Today’s cap is spent.',
    );
    expect(classify(api(409, { error: 'refused_by_policy', detail: 'Today’s cap is spent.' })).message).toBe(
      'Today’s cap is spent.',
    );
  });

  it('falls back to the table’s own sentence, never to a status code', () => {
    const f = classify(api(409, { error: 'no_delegation' }));
    expect(f.message).toBe('No trading permission is granted, so nothing can be placed.');
    expect(f.message).not.toMatch(/409|executor answered/);
  });

  it('never says "Something went wrong"', () => {
    const answers = [
      api(400, { error: 'invalid_request' }),
      api(500, {}),
      api(502, undefined),
      new Error('some unforeseen thing'),
      new TimedOut('/orders', 5_000),
    ];
    for (const a of answers) expect(classify(a).message).not.toMatch(/something went wrong/i);
  });
});

describe('a 500 whose `error` field is a thrown message, not a code', () => {
  it('does not look it up in the table', () => {
    // `errorResponse` puts `err.message` in `error` for anything it does not recognise.
    const f = classify(api(500, { error: 'Cannot read properties of undefined (reading \'usd\')' }));
    expect(f.kind).toBe('server-fault');
    expect(f.ref).toBe('req-abcd');
  });
});

describe('what the chain says', () => {
  it('tells a busy network apart from a refusing one', () => {
    expect(classify(new Error('max fee per gas less than block base fee')).kind).toBe('congested');
    expect(classify(new Error('replacement transaction underpriced')).kind).toBe('congested');
    expect(classify(new Error('execution reverted: TF')).kind).toBe('rejected');
    // A refusal is an answer, so there is nothing to retry.
    expect(classify(new Error('execution reverted')).retryable).toBe(false);
    expect(classify(new Error('max fee per gas too low')).retryable).toBe(true);
  });
});

describe('signed out is not a failure', () => {
  it('says nothing was asked', () => {
    const f = classify(new NotSignedIn('/positions'));
    expect(f).toMatchObject({ kind: 'signed-out', retryable: false, outcomeUnknown: false });
  });

  it('reads a 401 the same way', () => {
    expect(classify(api(401, { error: 'unauthorized', detail: 'Missing bearer token.' })).kind).toBe('signed-out');
  });
});

describe('waitSentence', () => {
  it('rounds rather than counting down, so nobody watches the number', () => {
    expect(waitSentence(1)).toBe('Try again in a moment.');
    expect(waitSentence(5)).toBe('Try again in a moment.');
    expect(waitSentence(12)).toBe('Try again in about 15 seconds.');
    expect(waitSentence(40)).toBe('Try again in about 40 seconds.');
  });

  it('switches to minutes where seconds stop being useful', () => {
    expect(waitSentence(60)).toBe('Try again in about a minute.');
    expect(waitSentence(61)).toBe('Try again in about 2 minutes.');
    expect(waitSentence(240)).toBe('Try again in about 4 minutes.');
  });
});

/**
 * A session that ended while the app was open.
 *
 * The same KIND as being signed out and a different event: nothing was wrong, the app was working a
 * moment ago, and the reader is owed that rather than "This needs you to be signed in" turning up
 * on a screen they were already using.
 */
describe('a session that expired mid-use', () => {
  it('is not reported as a fault', () => {
    const f = classify(new SessionExpired('/positions'));
    expect(f.kind).toBe('signed-out');
    expect(f.outcomeUnknown).toBe(false);
  });

  it('keeps its own sentence rather than the generic one', () => {
    // "This needs you to be signed in" is the right sentence for a signed-out visitor and the wrong
    // one for someone whose session just ran out under them.
    const f = classify(new SessionExpired('/positions'));
    expect(f.message).toMatch(/your session ended/i);
    expect(f.message).toContain('/positions');
  });

  it('offers the route that fixes it, not a retry', () => {
    // Repeating the request answers the same way until they sign in.
    const f = classify(new SessionExpired('/wallet'));
    expect(f.retryable).toBe(false);
    expect(f.fix).toEqual({ label: 'Sign in', href: '/' });
  });
});
