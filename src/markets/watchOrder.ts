/**
 * The order someone puts their own watchlist in.
 *
 * The list itself is not theirs: `/market/watchable` is what a strategy can follow on this network,
 * so it gains and loses rows as the executor's coverage changes. A saved order therefore has to
 * survive a list that moves underneath it, and the two ways of getting that wrong are opposite:
 *
 *   drop a symbol that is no longer watchable and you lose the user's arrangement the first time
 *   an upstream has a bad hour;
 *
 *   hide a symbol the user has never ordered and a market the executor just started supporting is
 *   invisible until they think to re-save.
 *
 * So the saved order is a preference applied to the live list, never a copy of it. Anything saved
 * and no longer watchable is skipped without being forgotten, and anything watchable and unordered
 * goes at the end where it can be seen.
 */

/**
 * Apply a saved order to the list that is actually watchable.
 *
 * Saved symbols first, in their saved order, keeping only the ones still present. Then everything
 * else, in the order the executor gave it — which is a deliberate choice over alphabetical: the
 * executor lists what it can follow, and inventing a second sort for the remainder would make a
 * newly-supported market harder to spot rather than easier.
 */
export function applyOrder(watchable: readonly string[], saved: readonly string[]): string[] {
  const live = new Set(watchable);
  const placed = new Set<string>();
  const out: string[] = [];

  for (const symbol of saved) {
    // A saved symbol the executor no longer offers is skipped here and still kept in storage: it
    // comes back in position if the executor starts offering it again.
    if (live.has(symbol) && !placed.has(symbol)) {
      out.push(symbol);
      placed.add(symbol);
    }
  }
  for (const symbol of watchable) {
    if (!placed.has(symbol)) {
      out.push(symbol);
      placed.add(symbol);
    }
  }
  return out;
}

/**
 * Move one symbol one place, and give back the whole order to save.
 *
 * The whole list rather than a pair of positions, because that is what gets persisted: a partial
 * update would need the server to hold a second idea of what the list is, and the two would drift
 * the moment the watchable set changed.
 *
 * A move at either end returns the list unchanged rather than wrapping. Wrapping from the top to
 * the bottom is never what someone tapping "up" means.
 */
export function move(order: readonly string[], symbol: string, direction: 'up' | 'down'): string[] {
  const from = order.indexOf(symbol);
  if (from === -1) return [...order];
  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= order.length) return [...order];

  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Can this symbol move that way? The screen disables the control rather than offering a no-op. */
export function canMove(order: readonly string[], symbol: string, direction: 'up' | 'down'): boolean {
  const at = order.indexOf(symbol);
  if (at === -1) return false;
  return direction === 'up' ? at > 0 : at < order.length - 1;
}

/**
 * Whether an order is worth saving, compared to what is already stored.
 *
 * Every tap of a move button would otherwise be a write. This is one comparison and it keeps the
 * executor from recording an order identical to the one it already has.
 */
export function orderChanged(saved: readonly string[], next: readonly string[]): boolean {
  if (saved.length !== next.length) return true;
  return saved.some((symbol, i) => symbol !== next[i]);
}

/**
 * What to persist after a move.
 *
 * The symbols the user has arranged, including any they had ordered that are not watchable right
 * now — dropping those would quietly discard an arrangement because an upstream had a bad hour.
 * The unwatchable ones keep their place relative to the rest, so the list returns to what they set
 * when the executor starts offering them again.
 */
export function orderToSave(
  visible: readonly string[],
  saved: readonly string[],
  watchable: readonly string[],
): string[] {
  const live = new Set(watchable);
  const out = [...visible];

  /*
   * Re-insert each stored-but-absent symbol after whichever saved neighbour precedes it, so a
   * symbol that was third stays near third rather than being appended to the end.
   */
  saved.forEach((symbol, i) => {
    if (live.has(symbol) || out.includes(symbol)) return;
    const previous = saved.slice(0, i).reverse().find((s) => out.includes(s));
    const at = previous === undefined ? 0 : out.indexOf(previous) + 1;
    out.splice(at, 0, symbol);
  });

  return out;
}
