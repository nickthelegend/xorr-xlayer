/**
 * The scrub's rules apart from its drawing (FEATURES.md #45): a tick per new point but never a buzz, the moment under
 * the finger written as precisely as the series was read, and a label that stays clear of the point it reads.
 */
import { describe, expect, it } from 'vitest';
import { NO_TICK, TICK_GAP_MS, labelAnchor, scrubTick, scrubTime, scrubber, type TickState } from './scrub';

/** Runs a drag through the tick rule and returns the points that ticked. */
function ticksFor(moves: readonly (readonly [index: number, at: number])[]): number[] {
  let state: TickState = NO_TICK;
  const ticked: number[] = [];
  for (const [index, at] of moves) {
    const { tick, next } = scrubTick(state, index, at);
    if (tick) ticked.push(index);
    state = next;
  }
  return ticked;
}

describe('the scrub’s tick', () => {
  it('ticks for the first point a drag lands on', () => {
    expect(ticksFor([[3, 1_000]])).toEqual([3]);
  });

  it('stays quiet while the finger stays on one point', () => {
    expect(ticksFor([[3, 1_000], [3, 1_200], [3, 1_400]])).toEqual([3]);
  });

  it('ticks for every point on a slow drag', () => {
    expect(ticksFor([[0, 0], [1, 200], [2, 400]])).toEqual([0, 1, 2]);
  });

  it('does not buzz through a fast drag, and ticks again once the gap has passed', () => {
    expect(TICK_GAP_MS).toBeGreaterThan(0);
    expect(
      ticksFor([
        [0, 0],
        [1, 20],
        [2, 40],
        [3, 60],
        [4, TICK_GAP_MS + 5],
        [5, TICK_GAP_MS + 20],
      ]),
    ).toEqual([0, 4]);
  });
});

describe('a drag, move by move', () => {
  it('reports every point, ticks by the rule, and forgets the drag when the finger lifts', () => {
    let now = 0;
    let ticks = 0;
    const points: (number | null)[] = [];
    const drag = scrubber(
      {
        point: (index) => {
          points.push(index);
        },
        tick: () => {
          ticks += 1;
        },
      },
      () => now,
    );
    drag.move(2);
    now = 10;
    drag.move(3); // a new point, but inside the gap: it moves the crosshair and does not tick
    now = 20;
    drag.move(3);
    drag.end();
    now = 30;
    drag.move(3); // a new drag ticks on its first point, however soon after the last
    expect(points).toEqual([2, 3, 3, null, 3]);
    expect(ticks).toBe(2);
  });
});

describe('the moment under the finger', () => {
  const DAY = 24 * 60 * 60_000;
  // Monday 14 September 2026, 14:30 UTC.
  const at = Date.UTC(2026, 8, 14, 14, 30);

  it('reads a day to the minute, with its weekday', () => {
    expect(scrubTime(at, DAY, 'UTC')).toMatch(/^Mon 2:30\sPM$/u);
  });

  it('reads a week or a month to the minute, with its date', () => {
    expect(scrubTime(at, 7 * DAY, 'UTC')).toMatch(/^Sep 14, 2:30\sPM$/u);
    expect(scrubTime(at, 30 * DAY, 'UTC')).toMatch(/^Sep 14, 2:30\sPM$/u);
  });

  it('reads a year to the day, where an hour would mean nothing', () => {
    expect(scrubTime(at, 365 * DAY, 'UTC')).toBe('Sep 14, 2026');
  });
});

describe('where the label sits', () => {
  const box = { width: 200, height: 100 };

  it('beside the hairline on the roomier side, at the end of the box away from the dot', () => {
    expect(labelAnchor(20, 80, box, 8)).toEqual({ left: 28, top: 0 });
    expect(labelAnchor(150, 10, box, 8)).toEqual({ right: 58, bottom: 0 });
  });
});
