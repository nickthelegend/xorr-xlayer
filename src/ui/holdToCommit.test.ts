/**
 * The stop's hold, step by step (FEATURES.md #3).
 *
 * What a person feels is here: a finger lifted early sends nothing, a finished hold commits exactly once, and a screen
 * reader, a key or an assistive click is never asked for a gesture it cannot make.
 */
import { describe, expect, it } from 'vitest';
import { CLICK_AFTER_RELEASE_MS, HOLD_IDLE, HOLD_MS, holdRemaining, holdStep, type HoldEvent } from './holdToCommit';

/** Events from rest: where they leave the button, and how many commits they made. */
function run(events: HoldEvent[]) {
  let state = HOLD_IDLE;
  let commits = 0;
  for (const event of events) {
    const next = holdStep(state, event);
    state = next.state;
    if (next.commit) commits += 1;
  }
  return { state, commits };
}

const down = (at: number, hold = true): HoldEvent => ({ type: 'down', at, hold });
const up = (at: number): HoldEvent => ({ type: 'up', at });
const elapsed = (at: number): HoldEvent => ({ type: 'elapsed', at });
const activate = (at: number): HoldEvent => ({ type: 'activate', at });
const settled: HoldEvent = { type: 'settled' };

describe('holding the stop', () => {
  it('commits when the timer fires on a press held the whole way', () => {
    const { state, commits } = run([down(0), elapsed(HOLD_MS)]);
    expect(commits).toBe(1);
    expect(state.phase).toBe('committed');
  });

  it('sends nothing when the finger lifts early — nor through the click the lift produces', () => {
    const { state, commits } = run([down(0), up(HOLD_MS - 1), activate(HOLD_MS - 1)]);
    expect(commits).toBe(0);
    expect(state.phase).toBe('idle');
  });

  it('is not committed by a timer that fires before the hold is over, and knows how much is left', () => {
    const { state, commits } = run([down(0), elapsed(HOLD_MS - 1)]);
    expect(commits).toBe(0);
    expect(state.phase).toBe('holding');
    expect(holdRemaining(state, HOLD_MS - 1)).toBe(1);
  });

  it('counts a press held the whole way when the timer runs late and the finger lifts first', () => {
    expect(run([down(0), up(HOLD_MS + 50)]).commits).toBe(1);
  });

  it('commits once: the lift, its click and a late timer after a commit do nothing', () => {
    expect(run([down(0), elapsed(HOLD_MS), up(900), activate(900), elapsed(1000)]).commits).toBe(1);
  });

  it('starts nothing while the stop it committed is still running', () => {
    expect(
      run([down(0), elapsed(HOLD_MS), up(700), down(800), elapsed(800 + HOLD_MS), up(1500), activate(5000)]).commits,
    ).toBe(1);
  });

  it('can be held again once that stop has settled', () => {
    expect(run([down(0), elapsed(HOLD_MS), up(700), settled, down(2000), elapsed(2000 + HOLD_MS)]).commits).toBe(2);
  });

  it('does not let a stop that settles before the finger lifts commit again through that finger’s click', () => {
    expect(run([down(0), elapsed(HOLD_MS), settled, up(900), activate(901)]).commits).toBe(1);
  });

  it('commits nothing when switched off mid-hold, even as the finger lifts', () => {
    const { state, commits } = run([down(0), { type: 'cancel' }, elapsed(HOLD_MS), up(700), activate(700)]);
    expect(commits).toBe(0);
    expect(state.phase).toBe('idle');
  });
});

describe('where a hold is not possible', () => {
  it('commits on one activation when a screen reader or a key made the press', () => {
    expect(run([down(0, false), up(40), activate(40)]).commits).toBe(1);
  });

  it('commits on an activation no press came before — an assistive click', () => {
    expect(run([activate(0)]).commits).toBe(1);
  });

  it('takes an activation long after a cancelled hold as one of its own', () => {
    expect(run([down(0), up(100), activate(100 + CLICK_AFTER_RELEASE_MS + 1)]).commits).toBe(1);
  });
});

it('holds for 600 ms, with the click slack well inside it', () => {
  expect(HOLD_MS).toBe(600);
  expect(CLICK_AFTER_RELEASE_MS).toBeLessThan(HOLD_MS);
});
