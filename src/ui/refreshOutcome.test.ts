import { describe, expect, it } from 'vitest';
import {
  isRefreshing,
  refreshMessage,
  refreshStep,
  REFRESH_IDLE,
  type RefreshState,
} from './refreshOutcome';

const refreshing: RefreshState = { kind: 'refreshing' };
const failed: RefreshState = { kind: 'failed', message: 'Couldn’t reach the executor.' };

describe('refreshStep — a failed refresh is not a finished one', () => {
  /*
   * The bug this exists for: the control ended every refresh with `.finally(() => setRefreshing(false))`, so a read
   * that threw retracted the spinner exactly as one that answered. The gesture people use when they suspect the screen
   * is stale would leave it stale and say it had worked — a success nobody can doubt, which is worse than an error.
   */
  it('keeps the failure instead of returning to idle', () => {
    const state = refreshStep(refreshing, { type: 'failed', message: 'Network is down.' });
    expect(state).toEqual({ kind: 'failed', message: 'Network is down.' });
    expect(isRefreshing(state)).toBe(false);
    expect(refreshMessage(state)).toBe('Network is down.');
  });

  it('says nothing at all when it worked', () => {
    const state = refreshStep(refreshing, { type: 'succeeded' });
    expect(state).toEqual(REFRESH_IDLE);
    expect(refreshMessage(state)).toBeUndefined();
  });

  /*
   * Content arriving is its own confirmation; a banner on every pull trains people to ignore the one that matters.
   *
   * Scoped to the refresh that actually succeeded. A `succeeded` arriving while `failed` belongs to an OLDER attempt
   * and deliberately changes nothing — see "the machine is total" below, where that case is pinned the other way.
   */
  it('a completed refresh reports nothing', () => {
    for (const from of [REFRESH_IDLE, refreshing]) {
      expect(refreshMessage(refreshStep(from, { type: 'succeeded' }))).toBeUndefined();
    }
  });
});

describe('when the failure goes away', () => {
  /* As the next read STARTS, not when it finishes: the old failure is about a read that is no longer the current one. */
  it('clears on the next attempt starting, not on its result', () => {
    const started = refreshStep(failed, { type: 'started' });
    expect(started).toEqual({ kind: 'refreshing' });
    expect(refreshMessage(started)).toBeUndefined();
  });

  it('clears when the reader dismisses it', () => {
    expect(refreshStep(failed, { type: 'dismissed' })).toEqual(REFRESH_IDLE);
  });

  /* Nothing about drawing the screen again makes the last read have worked, so nothing else clears it. */
  it('survives everything else', () => {
    expect(refreshStep(failed, { type: 'succeeded' })).toEqual(failed);
  });
});

describe('the machine is total', () => {
  /*
   * A `succeeded` or `failed` arriving while idle is a second resolution of an older promise, or a race between two
   * pulls. It must not clear a failure that belongs to a later attempt, or invent a failure for a read nobody started.
   */
  it('ignores a result for a refresh that is not in flight', () => {
    expect(refreshStep(REFRESH_IDLE, { type: 'succeeded' })).toEqual(REFRESH_IDLE);
    expect(refreshStep(REFRESH_IDLE, { type: 'failed', message: 'stale' })).toEqual(REFRESH_IDLE);
    expect(refreshStep(failed, { type: 'failed', message: 'newer' })).toEqual(failed);
  });

  it('ignores a dismissal when there is nothing to dismiss', () => {
    expect(refreshStep(REFRESH_IDLE, { type: 'dismissed' })).toEqual(REFRESH_IDLE);
    expect(refreshStep(refreshing, { type: 'dismissed' })).toEqual(refreshing);
  });

  it('can always be started', () => {
    for (const from of [REFRESH_IDLE, refreshing, failed]) {
      expect(refreshStep(from, { type: 'started' })).toEqual({ kind: 'refreshing' });
    }
  });

  it('only ever spins while refreshing', () => {
    expect(isRefreshing(REFRESH_IDLE)).toBe(false);
    expect(isRefreshing(refreshing)).toBe(true);
    expect(isRefreshing(failed)).toBe(false);
  });
});
