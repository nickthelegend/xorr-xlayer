/**
 * scrub.ts — the rules of dragging across a line chart (FEATURES.md #45), apart from the drawing.
 *
 * Which point a finger is on comes from `nearestIndex` in line.ts, the projection the line itself is drawn with. What
 * is here: when the phone ticks, what a drag remembers between moves, how the moment under the finger is written, and
 * which side of the hairline the label takes. Tested without a renderer or a haptic engine — the tick and the clock
 * are handed in.
 */

/**
 * The least time between two ticks.
 *
 * A tick belongs to a change of point, and a slow drag gets one for every point it crosses. A fast drag crosses a
 * dozen points in a fraction of a second, and a tick for each of those is a buzz — so after one tick the next waits
 * this long, and the points crossed in between still move the crosshair, silently.
 */
export const TICK_GAP_MS = 90;

/** The point the finger was last on, and when the phone last ticked. */
export interface TickState {
  index: number | null;
  at: number;
}

/** Nothing has ticked yet, so the first point a drag lands on always does. */
export const NO_TICK: TickState = Object.freeze({ index: null, at: Number.NEGATIVE_INFINITY });

/** Whether the phone ticks for the finger arriving on `index` at `now`, and what to remember for the next arrival. */
export function scrubTick(
  last: TickState,
  index: number,
  now: number,
  gapMs: number = TICK_GAP_MS,
): { tick: boolean; next: TickState } {
  if (index === last.index) return { tick: false, next: last };
  if (now - last.at < gapMs) return { tick: false, next: { index, at: last.at } };
  return { tick: true, next: { index, at: now } };
}

/**
 * A drag's memory from one move to the next: the point the finger is on, and when the phone last ticked.
 *
 * Made once per chart. `point` hears every move — a repeat is the caller's to ignore, and React state does — and
 * `tick` only when `scrubTick` says so. `end` forgets the drag, so the next one ticks on the first point it lands on.
 *
 * Outside the component on purpose. The gesture's callbacks are built during render, and a ref or a clock read inside
 * them is one React's compiler cannot tell apart from a read during render; here they are plainly neither.
 */
export function scrubber(
  on: { point: (index: number | null) => void; tick: () => void },
  clock: () => number = Date.now,
): { move: (index: number) => void; end: () => void } {
  let last: TickState = NO_TICK;
  return {
    move(index) {
      const { tick, next } = scrubTick(last, index, clock());
      last = next;
      if (tick) on.tick();
      on.point(index);
    },
    end() {
      last = NO_TICK;
      on.point(null);
    },
  };
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * The moment under the finger, as precisely as the series was read.
 *
 * A day's line is read to the minute and a year's to the day. One pattern for all of them either loses the hour on a
 * day or prints a meaningless 12:00 AM on a point that stands for a month. The phone's own time zone; `timeZone` is
 * there for tests, so what they check does not depend on where they run.
 */
export function scrubTime(at: number, spanMs: number, timeZone?: string): string {
  const d = new Date(at);
  if (spanMs <= 2 * DAY_MS) {
    return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone });
  }
  if (spanMs <= 62 * DAY_MS) {
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone });
}

/**
 * Where the label goes: beside the hairline on the side with more room, and at the end of the box away from the dot,
 * so the point the finger is reading is never underneath its own readout.
 */
export function labelAnchor(
  x: number,
  y: number,
  box: { width: number; height: number },
  gap: number,
): { left?: number; right?: number; top?: number; bottom?: number } {
  const across = x <= box.width / 2 ? { left: x + gap } : { right: box.width - x + gap };
  const down = y > box.height / 2 ? { top: 0 } : { bottom: 0 };
  return { ...across, ...down };
}
