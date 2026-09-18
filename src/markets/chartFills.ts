/**
 * chartFills.ts — what the asset screen says under its chart about the fills marked on it (FEATURES.md #77).
 *
 * The marks themselves are placed by `src/ui/charts/marks.ts`. What is here is the part a mark cannot say by itself:
 * which of the drawn fills to list, and the one sentence that stops an unmarked chart from reading as "nothing filled"
 * when the truth is "we could not read" or "we did not read that far back".
 *
 * Pure, so every rule is tested without a screen.
 */

/** The sentence under the marks, when one is owed. */
export type ChartFillsNote =
  /** The runs did not load. The chart is unmarked because nothing was read, not because nothing filled. */
  | { kind: 'unread' }
  /** The runs read are a capped page, and it starts inside this chart's window: before `since`, fills may be missing. */
  | { kind: 'partial'; since: number }
  /** Every fill of this token is known, and none of them falls inside the range on screen. */
  | { kind: 'outside'; count: number };

/**
 * Which sentence, if any, belongs under this chart.
 *
 * `knownFrom` is `fillsKnownFrom` — null when the runs are the whole record. `windowStart` is the time of the chart's
 * first point, undefined when there is no chart. `marked` is how many fills the chart drew; `ofToken` how many fills of
 * this token were read at all.
 */
export function chartFillsNote(args: {
  unread: boolean;
  knownFrom: number | null;
  windowStart: number | undefined;
  marked: number;
  ofToken: number;
}): ChartFillsNote | null {
  if (args.unread) return { kind: 'unread' };
  if (args.windowStart === undefined) return null;
  if (args.knownFrom !== null && args.knownFrom > args.windowStart) {
    return { kind: 'partial', since: args.knownFrom };
  }
  if (args.marked === 0 && args.ofToken > 0) return { kind: 'outside', count: args.ofToken };
  return null;
}

/**
 * The drawn fills to list, newest first, at most `limit` of them — and how many drawn ones that leaves off.
 *
 * Only what the chart drew: a list that named a fill the chart did not mark would disagree with the picture beside it.
 */
export function listedFills<T extends { at: number }>(
  marks: readonly T[],
  limit: number,
): { shown: T[]; more: number } {
  const newest = [...marks].sort((a, b) => b.at - a.at);
  return { shown: newest.slice(0, limit), more: Math.max(0, newest.length - limit) };
}
