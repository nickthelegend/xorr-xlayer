/**
 * allocation.ts — a portfolio split by sector, as shares of the whole.
 *
 * The arithmetic behind the donut, kept pure and apart from the drawing so the part that can be silently wrong — a
 * share that does not add up, a holding quietly dropped, a sector invented for an asset that has none — is the part a
 * test can reach.
 *
 * ## Unclassified is a bucket, not a gap
 *
 * An asset whose sector nothing could tell us is **Unclassified**, drawn and labelled as such. It is never guessed from
 * the ticker, never folded into "Other" beside real sectors, and never dropped — dropping it would silently renormalise
 * every other slice, so a portfolio half of which is unclassified would draw as though the classified half were the
 * whole thing. That is the one failure mode a donut has, and it is invisible: the chart still adds to 100%.
 *
 * It also always sorts **last**, however large it is. The other slices are sorted by size because that is the ranking
 * the reader is looking for; Unclassified is not a sector competing in that ranking, it is the absence of an answer, and
 * putting it second because it happens to be big would read as a category of its own.
 */

/** The label for an asset whose sector is not known. Exported so the drawing and the tests agree on the exact word. */
export const UNCLASSIFIED = 'Unclassified';

export type Holding = {
  symbol: string;
  /** The sector, as an authority gave it. Null, undefined or blank all mean "not known", never "none". */
  sector?: string | null;
  /** What the holding is worth now, in USD. */
  valueUsd: number;
};

export type AllocationSlice = {
  sector: string;
  valueUsd: number;
  /** 0–1 of the whole. */
  share: number;
  /** The symbols in this slice, largest first — what the legend names. */
  symbols: string[];
  /** This is the not-known bucket rather than a sector. */
  unclassified: boolean;
};

export type Allocation = {
  slices: AllocationSlice[];
  /** The total the shares are of. Zero when there is nothing to draw. */
  totalUsd: number;
};

/**
 * Whether a value can take part in an allocation.
 *
 * A holding worth nothing, worth a negative amount, or worth something unreadable is not a share of the portfolio and
 * must not become a zero-width slice: the donut would carry a legend entry for something invisible, which reads as a
 * rendering bug rather than as the holding being empty.
 */
function counts(valueUsd: number): boolean {
  return Number.isFinite(valueUsd) && valueUsd > 0;
}

/** The sector as a key, or `UNCLASSIFIED`. Whitespace is not an answer. */
function sectorKey(sector: string | null | undefined): string {
  const trimmed = (sector ?? '').trim();
  return trimmed === '' ? UNCLASSIFIED : trimmed;
}

/**
 * Group holdings into sector slices.
 *
 * Shares are of the total of everything that counts, so they add to 1 whenever there is anything at all — including the
 * unclassified part, which is exactly the point.
 */
export function allocationBySector(holdings: readonly Holding[]): Allocation {
  const counted = holdings.filter((h) => counts(h.valueUsd));
  const totalUsd = counted.reduce((sum, h) => sum + h.valueUsd, 0);
  if (totalUsd <= 0) return { slices: [], totalUsd: 0 };

  const bySector = new Map<string, { valueUsd: number; holdings: Holding[] }>();
  for (const h of counted) {
    const key = sectorKey(h.sector);
    const bucket = bySector.get(key) ?? { valueUsd: 0, holdings: [] };
    bucket.valueUsd += h.valueUsd;
    bucket.holdings.push(h);
    bySector.set(key, bucket);
  }

  const slices: AllocationSlice[] = [...bySector.entries()].map(([sector, bucket]) => ({
    sector,
    valueUsd: bucket.valueUsd,
    share: bucket.valueUsd / totalUsd,
    symbols: [...bucket.holdings].sort((a, b) => b.valueUsd - a.valueUsd).map((h) => h.symbol),
    unclassified: sector === UNCLASSIFIED,
  }));

  /*
   * Largest first, with the not-known bucket pinned last whatever its size, and ties broken by name so the same
   * portfolio draws the same way twice. An unstable order would move slices and their colours between two reads of a
   * portfolio that did not change.
   */
  slices.sort((a, b) => {
    if (a.unclassified !== b.unclassified) return a.unclassified ? 1 : -1;
    if (b.valueUsd !== a.valueUsd) return b.valueUsd - a.valueUsd;
    return a.sector.localeCompare(b.sector);
  });

  return { slices, totalUsd };
}

/**
 * Where each slice starts and ends around the ring, clockwise from twelve o'clock, as fractions of the circle.
 *
 * Laid out from the running total rather than by accumulating each slice's own share, so rounding cannot leave a hairline
 * gap between two segments that are meant to touch.
 */
export function sliceArcs(slices: readonly AllocationSlice[]): { start: number; end: number }[] {
  const arcs: { start: number; end: number }[] = [];
  let running = 0;
  for (const slice of slices) {
    const start = running;
    running += slice.share;
    arcs.push({ start, end: running });
  }
  return arcs;
}
