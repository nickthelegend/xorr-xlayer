/**
 * The sentences that keep three different stops apart.
 *
 * Someone who paused a strategy and believed they had pulled the kill switch has a wrong model of
 * what their money is exposed to, and finds out at the worst possible time. These are checked
 * rather than trusted because copy is exactly the kind of thing that drifts back to being vague.
 */
import { describe, expect, it } from 'vitest';
import {
  KILL_SWITCH_LINK,
  KILL_SWITCH_ROUTE,
  PAUSE_IS_NOT_THE_KILL_SWITCH,
  pausedNote,
  stateBadge,
} from './pauseCopy';

describe('the line under the pause control', () => {
  it('says what stops', () => {
    expect(PAUSE_IS_NOT_THE_KILL_SWITCH).toMatch(/stops one strategy/i);
  });

  it('says what does not stop, in the same breath', () => {
    // A note that only said "pauses this strategy" leaves the reader to assume the rest.
    expect(PAUSE_IS_NOT_THE_KILL_SWITCH).toMatch(/permission stays live/i);
    expect(PAUSE_IS_NOT_THE_KILL_SWITCH).toMatch(/everything else keeps trading/i);
  });

  it('names the kill switch as the only thing that revokes on chain', () => {
    expect(PAUSE_IS_NOT_THE_KILL_SWITCH).toMatch(/only the kill switch revokes it on chain/i);
  });

  it('uses the word the rest of the app uses for the delegation', () => {
    // Safety and the audit trail both say "permission". A fourth name for one thing is how a user
    // ends up believing there are four things.
    expect(PAUSE_IS_NOT_THE_KILL_SWITCH).toContain('permission');
    expect(PAUSE_IS_NOT_THE_KILL_SWITCH).not.toMatch(/delegation|allowance policy/i);
  });

  it('points at the screen that actually has the switch', () => {
    expect(KILL_SWITCH_ROUTE).toBe('/safety');
    expect(KILL_SWITCH_LINK).toMatch(/kill switch/i);
  });
});

describe('what a paused row says it will come back as', () => {
  it('says a watching strategy resumes watching', () => {
    // It does not always come back the same, and the row is where someone can tell before they tap.
    expect(pausedNote('watch')).toBe('Paused · resumes watching');
  });

  it('says nothing extra for one that resumes live', () => {
    expect(pausedNote('live')).toBe('Paused');
    expect(pausedNote(undefined)).toBe('Paused');
  });
});

describe('the state badge', () => {
  it('names each state a strategy can be in', () => {
    expect(stateBadge('live', undefined)).toBe('Live');
    expect(stateBadge('watch', undefined)).toBe('Watch');
    expect(stateBadge('draft', undefined)).toBe('Draft');
    expect(stateBadge('ended', undefined)).toBe('Ended');
  });

  it('carries the resume hint through for a paused one', () => {
    expect(stateBadge('paused', 'watch')).toBe('Paused · resumes watching');
  });

  it('shows a state this build does not know by its own name', () => {
    // A newer executor's word beats a wrong guess at which of ours it meant.
    expect(stateBadge('cooling-off', undefined)).toBe('cooling-off');
  });
});
