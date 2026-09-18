/**
 * What resuming a paused strategy does.
 *
 * Both rules here replace behaviour that cost money rather than clarity: a `watch` strategy that
 * came back from a pause able to spend, and a resume that fired a real buy seconds after the tap.
 */
import { describe, expect, it } from 'vitest';
import { nextRunOnResume, resumeMovedSchedule, stateOnResume } from './resume.js';

describe('which state a resume returns to', () => {
  it('puts a watching strategy back to watching', () => {
    // `watch` exists to record what a strategy WOULD do and move nothing. Resuming it into `live`
    // hands it the ability to spend, which nobody asked for and nothing announced.
    expect(stateOnResume('watch')).toBe('watch');
  });

  it('puts a live one back to live', () => {
    expect(stateOnResume('live')).toBe('live');
  });

  it('defaults an older row with nothing recorded to live', () => {
    // Paused before the column existed. `live` is what a resume did then, and quietly demoting
    // someone's live strategy to watch would be its own surprise.
    expect(stateOnResume(null)).toBe('live');
    expect(stateOnResume(undefined)).toBe('live');
  });

  it('refuses to return to a state a resume cannot mean', () => {
    // `draft` and `ended` are not things a pause can be undone into.
    expect(stateOnResume('draft')).toBe('live');
    expect(stateOnResume('ended')).toBe('live');
    expect(stateOnResume('paused')).toBe('live');
  });
});

describe('when a resumed strategy next runs', () => {
  const now = new Date('2026-09-17T12:00:00Z');

  it('leaves a due time the user set, when it is still ahead', () => {
    const ahead = new Date('2026-09-18T09:00:00Z');
    expect(nextRunOnResume(ahead, 'daily', now)).toBe(ahead);
  });

  it('moves a due time that has passed, so a resume never spends immediately', () => {
    /*
     * Paused Monday, resumed Friday. `periodKey` would bucket the overdue run under FRIDAY — not
     * the Monday it was due — so a real buy settles seconds after a tap that said "resume".
     */
    const overdue = new Date('2026-09-14T09:00:00Z');
    const next = nextRunOnResume(overdue, 'daily', now)!;
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('moves it one slot from now, not one slot from the date it missed', () => {
    // A daily paused for a month would otherwise need thirty steps to reach the present, each one
    // a period the user was not running.
    const longOverdue = new Date('2026-08-01T09:00:00Z');
    const next = nextRunOnResume(longOverdue, 'daily', now)!;
    expect(next).toEqual(new Date('2026-09-18T12:00:00Z'));
  });

  it('respects the cadence it was set to', () => {
    const overdue = new Date('2026-08-01T09:00:00Z');
    expect(nextRunOnResume(overdue, 'weekly', now)).toEqual(new Date('2026-09-24T12:00:00Z'));
    expect(nextRunOnResume(overdue, 'monthly', now)).toEqual(new Date('2026-10-17T12:00:00Z'));
  });

  it('leaves a one-shot alone, which has no next slot to move to', () => {
    const overdue = new Date('2026-09-14T09:00:00Z');
    expect(nextRunOnResume(overdue, null, now)).toBe(overdue);
  });

  it('leaves a strategy with no due time at all alone', () => {
    expect(nextRunOnResume(null, 'daily', now)).toBeNull();
  });

  it('treats a due time exactly now as passed', () => {
    // Equal is not ahead, and the scheduler selects `next_run_at <= now`.
    const next = nextRunOnResume(new Date(now.getTime()), 'daily', now)!;
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('saying whether the schedule moved', () => {
  it('is true when the resume pushed it forward', () => {
    // A silent change to when someone's money moves reads as a bug the first time it surprises them.
    expect(
      resumeMovedSchedule(new Date('2026-09-14T09:00:00Z'), new Date('2026-09-18T12:00:00Z')),
    ).toBe(true);
  });

  it('is false when it was left where the user set it', () => {
    const same = new Date('2026-09-18T09:00:00Z');
    expect(resumeMovedSchedule(same, new Date(same.getTime()))).toBe(false);
  });

  it('is false when there was no due time either side', () => {
    expect(resumeMovedSchedule(null, null)).toBe(false);
    expect(resumeMovedSchedule(null, new Date())).toBe(false);
  });
});
