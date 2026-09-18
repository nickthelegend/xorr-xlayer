/**
 * What the asset screen says about the fills on its chart (FEATURES.md #77): an unmarked chart must never read as
 * "nothing filled" when the runs did not load, or were not read back far enough.
 */
import { describe, expect, it } from 'vitest';
import { chartFillsNote, listedFills } from './chartFills';

const base = { unread: false, knownFrom: null, windowStart: 1_000, marked: 0, ofToken: 0 };

describe('the sentence under the chart', () => {
  it('says the fills did not load, whatever else is true — an unread chart is not an empty one', () => {
    expect(chartFillsNote({ ...base, unread: true })).toEqual({ kind: 'unread' });
    expect(chartFillsNote({ ...base, unread: true, windowStart: undefined })).toEqual({ kind: 'unread' });
  });

  it('says how far back the record was read when a capped page starts inside the window', () => {
    expect(chartFillsNote({ ...base, knownFrom: 1_500, marked: 3, ofToken: 3 })).toEqual({
      kind: 'partial',
      since: 1_500,
    });
  });

  it('owes nothing about coverage when the page reaches back before the window, or is the whole record', () => {
    expect(chartFillsNote({ ...base, knownFrom: 500, marked: 2, ofToken: 2 })).toBeNull();
    expect(chartFillsNote({ ...base, marked: 2, ofToken: 2 })).toBeNull();
  });

  it('says the known fills are outside this range only when all of them are known', () => {
    expect(chartFillsNote({ ...base, ofToken: 4 })).toEqual({ kind: 'outside', count: 4 });
    // A partial record cannot claim none of its fills are in range.
    expect(chartFillsNote({ ...base, knownFrom: 2_000, ofToken: 4 })).toEqual({ kind: 'partial', since: 2_000 });
  });

  it('says nothing when there is no chart, or no fill of this token was ever read', () => {
    expect(chartFillsNote({ ...base, windowStart: undefined, ofToken: 4 })).toBeNull();
    expect(chartFillsNote(base)).toBeNull();
  });
});

describe('the fills listed beside the marks', () => {
  it('are the drawn ones, newest first, capped, with a count of the rest', () => {
    const marks = [{ at: 1 }, { at: 5 }, { at: 3 }, { at: 4 }];
    expect(listedFills(marks, 2)).toEqual({ shown: [{ at: 5 }, { at: 4 }], more: 2 });
    expect(listedFills(marks, 10)).toEqual({ shown: [{ at: 5 }, { at: 4 }, { at: 3 }, { at: 1 }], more: 0 });
    expect(listedFills([], 5)).toEqual({ shown: [], more: 0 });
  });
});
