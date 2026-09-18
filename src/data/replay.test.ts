/**
 * The replay mark, from the wire to the value a screen reads.
 *
 * `markReplayed` and `wasReplayed` are the whole of the carriage. They are tested apart from `api.ts` for
 * the reason `apiError.ts` exists at all: importing the transport pulls in the Expo runtime, and the part
 * worth testing was the part a test could not reach.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, REPLAYED, markReplayed, wasReplayed } from './apiError';

describe('the mark travels on the value, not in it', () => {
  it('does not appear among the fields', () => {
    // These bodies are spread, compared and serialised all over the app. A stray `replayed: true` key would
    // show up in every one of those places.
    const outcome = markReplayed({ status: 'filled', units: 0.0412 }, true);
    expect(Object.keys(outcome)).toEqual(['status', 'units']);
    expect(JSON.parse(JSON.stringify(outcome))).toEqual({ status: 'filled', units: 0.0412 });
    expect(wasReplayed(outcome)).toBe(true);
  });

  it('marks nothing when the answer was not a replay', () => {
    expect(wasReplayed(markReplayed({ status: 'filled' }, false))).toBe(false);
  });

  it('survives the value being handed around', () => {
    const outcome = markReplayed({ status: 'filled' }, true);
    const held: unknown = outcome;
    expect(wasReplayed(held)).toBe(true);
    // A COPY is a different value and carries nothing: a screen that rebuilds an outcome has rebuilt it.
    expect(wasReplayed({ ...outcome })).toBe(false);
  });

  it('is keyed on a global symbol, so two module instances agree', () => {
    expect(REPLAYED).toBe(Symbol.for('xorr.idempotentReplay'));
  });
});

describe('a refusal that was replayed', () => {
  it('reads off the error itself', () => {
    const e = new ApiError(409, '409', { error: 'refused_by_policy' }, 'req-1', undefined, true);
    expect(wasReplayed(e)).toBe(true);
    expect(wasReplayed(new ApiError(409, '409', { error: 'refused_by_policy' }))).toBe(false);
  });
});

describe('things that are not answers', () => {
  it('says no rather than throwing', () => {
    for (const v of [undefined, null, 0, '', 'filled', []]) expect(wasReplayed(v), String(v)).toBe(false);
  });
});
