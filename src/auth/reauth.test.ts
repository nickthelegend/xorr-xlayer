/**
 * Telling someone their session ended, once.
 *
 * A phone with six screens mounted makes six reads, so six of them raise `SessionExpired` and the
 * app becomes a wall of the same sentence — none of which can be acted on, because the fix is not
 * on any of those screens.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_ENDED_DETAIL,
  SESSION_ENDED_TITLE,
  clearSessionEnded,
  noteSessionEnded,
  resetSessionEnded,
  sessionEndedAt,
  subscribeSessionEnded,
} from './reauth';

beforeEach(() => resetSessionEnded());

describe('recording that it ended', () => {
  it('starts with nothing to say', () => {
    expect(sessionEndedAt()).toBeNull();
  });

  it('records when it happened', () => {
    noteSessionEnded(1_000);
    expect(sessionEndedAt()).toBe(1_000);
  });

  it('is one event however many screens discover it', () => {
    // Six mounted screens make six reads. Re-notifying on each would re-render the prompt five
    // times for nothing, and would move the timestamp each time.
    const heard = vi.fn();
    subscribeSessionEnded(heard);

    noteSessionEnded(1_000);
    noteSessionEnded(1_050);
    noteSessionEnded(1_100);

    expect(heard).toHaveBeenCalledTimes(1);
    expect(sessionEndedAt()).toBe(1_000);
  });
});

describe('clearing it', () => {
  it('forgets, and says so once', () => {
    noteSessionEnded(1_000);
    const heard = vi.fn();
    subscribeSessionEnded(heard);

    clearSessionEnded();

    expect(sessionEndedAt()).toBeNull();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there was nothing to clear', () => {
    const heard = vi.fn();
    subscribeSessionEnded(heard);
    clearSessionEnded();
    expect(heard).not.toHaveBeenCalled();
  });

  it('lets a later expiry be recorded again', () => {
    // A session can end twice in one run of the app.
    noteSessionEnded(1_000);
    clearSessionEnded();
    noteSessionEnded(2_000);
    expect(sessionEndedAt()).toBe(2_000);
  });
});

describe('subscribing', () => {
  it('stops hearing after unsubscribing', () => {
    const heard = vi.fn();
    const off = subscribeSessionEnded(heard);
    off();
    noteSessionEnded(1_000);
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('what the prompt says', () => {
  it('names the cause', () => {
    // "Sign in" with no reason, on a screen someone was already using, reads as the app having
    // logged them out arbitrarily.
    expect(SESSION_ENDED_TITLE).toMatch(/session ended/i);
  });

  it('says what is untouched', () => {
    /*
     * A session ending is exactly the moment someone wonders whether their money is still where
     * they left it. The honest answer costs one sentence, and it is a property of the design: the
     * permission is on chain and the kill switch is signed by the user.
     */
    expect(SESSION_ENDED_DETAIL).toMatch(/nothing was changed/i);
    expect(SESSION_ENDED_DETAIL).toMatch(/on chain/i);
    expect(SESSION_ENDED_DETAIL).toMatch(/stopping your agents still works/i);
  });

  it('says what to do', () => {
    expect(SESSION_ENDED_DETAIL).toMatch(/sign in again/i);
  });
});
