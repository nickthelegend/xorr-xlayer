/**
 * The markets someone looked at recently, offered before they type.
 *
 * Search opens on the first twelve of whatever the catalogue happens to list, which is a sample of
 * a list rather than a starting point: on a screen reached by tapping a magnifying glass, the most
 * useful thing to show is what this person keeps coming back to. Almost every search in a trading
 * app is a repeat of an earlier one.
 *
 * Kept on the DEVICE rather than the executor, deliberately. It is a convenience, not a record —
 * losing it costs a few taps, and sending "which markets is this person interested in" to a server
 * that has no other reason to know would be collecting something for nothing.
 *
 * Symbols only. Nothing is stored about the price, the time or what was done next, so a recent that
 * is no longer in the catalogue simply stops being offered.
 */

/**
 * How many to keep.
 *
 * Enough to be worth having, short enough that the list is still a shortcut. Past about six the
 * reader is scanning rather than recognising, and scanning is what the search box is for.
 */
export const MAX_RECENTS = 6;

/**
 * Record a visit, most recent first.
 *
 * A repeat moves to the front rather than appearing twice — the list is a set in visit order, and
 * the same symbol twice would push something genuinely different off the end.
 */
export function remember(recents: readonly string[], symbol: string): string[] {
  const clean = symbol.trim();
  if (!clean) return [...recents];
  return [clean, ...recents.filter((s) => s !== clean)].slice(0, MAX_RECENTS);
}

/**
 * The recents worth showing, given what the catalogue currently holds.
 *
 * A symbol the app can no longer price or trade is dropped rather than offered — tapping it would
 * open a screen about an asset that is not there. It stays in storage, so a market that comes back
 * is offered again without the user having to find it a second time.
 */
export function visibleRecents(recents: readonly string[], known: ReadonlySet<string>): string[] {
  return recents.filter((s) => known.has(s));
}

/**
 * What the search screen shows before anyone types.
 *
 * Recents first, then the catalogue's own order to fill the rest — never only recents. A list that
 * showed nothing but the last six markets would make the search screen useless for finding a
 * seventh, which is the one thing it exists for.
 */
export function openingList(params: {
  recents: readonly string[];
  catalogue: readonly string[];
  known: ReadonlySet<string>;
  limit: number;
}): { symbol: string; recent: boolean }[] {
  const shown = visibleRecents(params.recents, params.known);
  const seen = new Set(shown);
  const rest = params.catalogue.filter((s) => !seen.has(s));

  return [
    ...shown.map((symbol) => ({ symbol, recent: true })),
    ...rest.map((symbol) => ({ symbol, recent: false })),
  ].slice(0, Math.max(params.limit, shown.length));
}
