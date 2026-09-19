/**
 * Finding a market by typing roughly what it is called.
 *
 * Search matched a substring, which is exact matching with a friendlier name: "nvidia" found
 * nothing because the symbol is `NVDAx` and the catalogue name is "NVIDIA Corporation xStock", and
 * "aple" found nothing at all. A trading app whose search only works when you already know the
 * ticker is a list with a filter on it.
 *
 * The rule here is a SUBSEQUENCE: every character of the query must appear in the candidate, in
 * order, but not necessarily together. "nvda" matches "NVIDIA Corporation" and "tsl" matches
 * "Tesla". That is forgiving enough for a typo that drops a letter and strict enough that a query
 * still has to be about the thing it matched — which matters more here than on an ordinary search,
 * because what someone does with the result is spend money on it.
 *
 * What it deliberately does NOT do is edit distance. "NVDA" and "NVDX" are one character apart and
 * are different assets; a matcher that treats a wrong character as nearly right is a matcher that
 * will eventually offer somebody the wrong stock.
 */

/** Where a query matched, and how well. Higher is better; ties are broken by the caller. */
export type FuzzyMatch = {
  /** 0 when nothing matched. Nothing else about the number means anything on its own. */
  score: number;
  /** The character positions that matched, for highlighting. Empty when the score is 0. */
  positions: number[];
};

const NO_MATCH: FuzzyMatch = { score: 0, positions: [] };

/*
 * The weights. Their absolute values are arbitrary; only the order between them is a decision:
 *
 *   a match at the very start beats one in the middle          — "tes" should find Tesla first;
 *   a match at a word boundary beats one inside a word         — "c" in "Corporation" over "Inc";
 *   consecutive matched characters beat scattered ones         — "nvda" contiguous over n-v-d-a;
 *   a shorter candidate beats a longer one, all else equal     — `NVDAx` over "NVIDIA Corporation".
 */
const START_BONUS = 12;
const BOUNDARY_BONUS = 8;
const CONTIGUOUS_BONUS = 6;
const BASE = 1;

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  return prev === ' ' || prev === '-' || prev === '.' || prev === '/';
}

/**
 * Score `query` against `candidate`, case-insensitively.
 *
 * Greedy left-to-right: the first position that can match each query character is taken. That is
 * not always the highest-scoring alignment — an exhaustive search would be — but it is linear, it
 * is what the eye does reading a highlighted result, and a search over a few dozen instruments has
 * no need to be cleverer than the person reading it.
 */
export function fuzzyScore(query: string, candidate: string): FuzzyMatch {
  const q = query.trim().toLowerCase();
  if (!q) return NO_MATCH;
  const text = candidate.toLowerCase();

  const positions: number[] = [];
  let score = 0;
  let at = 0;

  for (const ch of q) {
    const found = text.indexOf(ch, at);
    // One character of the query with nowhere left to go means the whole query does not match.
    if (found === -1) return NO_MATCH;

    score += BASE;
    if (found === 0) score += START_BONUS;
    else if (isBoundary(text, found)) score += BOUNDARY_BONUS;
    if (positions.length > 0 && found === positions[positions.length - 1]! + 1) {
      score += CONTIGUOUS_BONUS;
    }

    positions.push(found);
    at = found + 1;
  }

  /*
   * Shorter candidates win ties.
   *
   * Without this "NVDAx" and "NVIDIA Corporation xStock" score identically for "nvda" and the
   * order between them is whatever the input order happened to be. The divisor keeps this strictly
   * smaller than any single bonus, so it breaks ties without ever overturning a better match.
   */
  return { score: score + 1 / (text.length + 1), positions };
}

/** One thing that can be searched: whatever fields a query may legitimately match. */
export type Searchable = {
  /** The ticker, which is what most people type. */
  symbol: string;
  /** The full name. "nvidia" has to find NVDAx. */
  name: string;
};

/**
 * One row per instrument, keeping the first.
 *
 * Search draws from two sources that overlap: the market catalogue, which already lists the eleven wrapped xStocks
 * with their price and their change, and `/market/xstocks`, which lists the same tokens with their sector and the
 * cost breakdown. Concatenated, a search for "tesla" answered TSLAx twice — the same token at the same price, under
 * two different subtitles, opening two different screens. The catalogue row comes first and wins; a token only the
 * xStocks feed knows still gets its row.
 */
export function oneRowPerSymbol<T extends { symbol: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.symbol.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Rank `items` against a query, dropping what does not match at all.
 *
 * Each item is scored against its symbol and its name and keeps the better of the two, so a query
 * that is clearly a ticker is not dragged down by a long company name and vice versa.
 *
 * An empty query returns the items unchanged rather than nothing: the screen shows a starting list
 * before anyone types, and a search that empties the moment it opens looks broken.
 */
export function fuzzyRank<T extends Searchable>(items: readonly T[], query: string): T[] {
  const q = query.trim();
  if (!q) return [...items];

  const scored = items
    .map((item) => ({
      item,
      score: Math.max(fuzzyScore(q, item.symbol).score, fuzzyScore(q, item.name).score),
    }))
    .filter((s) => s.score > 0);

  /*
   * Stable within a score.
   *
   * `Array.prototype.sort` is specified stable, so equally-good matches keep the order their source
   * gave them — which is the catalogue's own order, and is more meaningful than an arbitrary
   * reshuffle on every keystroke.
   */
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/** Did this query match at all? The screen uses it to decide between "no results" and a list. */
export function fuzzyMatches(query: string, item: Searchable): boolean {
  const q = query.trim();
  if (!q) return true;
  return fuzzyScore(q, item.symbol).score > 0 || fuzzyScore(q, item.name).score > 0;
}
