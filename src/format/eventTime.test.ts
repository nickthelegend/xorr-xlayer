import { describe, expect, it } from 'vitest';
import { clock, eventTime } from './index';

describe('eventTime', () => {
  /*
   * The executor's `t` is its own clock, UTC on Railway: a buy at 12:55 AM in India read 07:25 PM (2026-09-26). The
   * moment is printed in this phone's zone instead, and `t` only stands in for an executor that sends no moment.
   */
  it("prints the moment in this device's time zone, not the executor's clock string", () => {
    const at = Date.UTC(2026, 8, 25, 19, 25);
    expect(eventTime({ t: '07:25 PM', at })).toBe(clock(at));
  });

  it("falls back to the executor's string when no moment came with it", () => {
    expect(eventTime({ t: '07:25 PM' })).toBe('07:25 PM');
    expect(eventTime({ t: '07:25 PM', at: Number.NaN })).toBe('07:25 PM');
  });
});
