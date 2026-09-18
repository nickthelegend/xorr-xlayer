/**
 * What the xStocks catalog screen decides, kept out of the screen.
 *
 * Every rule here is one a reader could get wrong by looking at the list, so each is stated once and
 * checked once, in `catalog.test.ts`:
 *
 *   - a sector filter hides rows from OTHER sectors, never the unpriced rows of the one chosen;
 *   - "no price" is a state a row is in, and the screen says how many are in it rather than leaving
 *     it to be counted;
 *   - a row's secondary line names the underlying mark only when there IS one.
 *
 * `app/xstocks.tsx` renders the answers. It holds no logic of its own.
 */
import type { XStockRow } from '@/data/system';

/** The filter's first option. Not a sector, which is why the server's list does not carry it. */
export const ALL_SECTORS = 'All';

/**
 * The filter's options: every sector the catalog uses, behind "All".
 *
 * The sectors come from the server, derived there from the tokens themselves, so an xStock added under
 * a new sector reaches this filter without anyone editing a second list.
 */
export function sectorOptions(sectors: readonly string[]): string[] {
  return [ALL_SECTORS, ...sectors];
}

/**
 * The rows a sector shows.
 *
 * Unpriced rows stay. The sector is reference data about the listing and survives an outage while
 * the price does not, so a sector that dropped its unpriced rows would appear to empty out whenever
 * the feed went quiet — and "nothing is listed under Technology" is a different claim from "we
 * cannot price what is listed under Technology".
 */
export function bySector(rows: readonly XStockRow[], sector: string): XStockRow[] {
  return sector === ALL_SECTORS ? [...rows] : rows.filter((r) => r.sector === sector);
}

/** How many of these have no price. */
export function unpricedCount(rows: readonly XStockRow[]): number {
  return rows.filter((r) => r.feed !== 'live').length;
}

/**
 * The warning above the list, or null when every row has a price.
 *
 * All of them unpriced is a different sentence from some of them: the first means nothing here can
 * be bought at all, which is worth saying in those words rather than as a count the reader has to
 * compare against the length of the list.
 */
export function unpricedNote(rows: readonly XStockRow[]): string | null {
  const n = unpricedCount(rows);
  if (n === 0) return null;
  if (n === rows.length) return 'No prices right now. These can’t be bought until one arrives.';
  return `${n} of these have no price right now.`;
}

/**
 * The line under the symbol.
 *
 * With an issuer mark it names it, so the larger number above is visibly a DIFFERENT quantity — the
 * pool price, which is what a buy pays, against the exchange mark for the share itself. Without one
 * it is the sector alone: a label describing a number that is not on the row would be worse than no
 * label.
 */
export function secondaryLine(row: XStockRow, formatPrice: (n: number) => string): string {
  return row.underlyingPrice !== null
    ? `${row.sector} · share ${formatPrice(row.underlyingPrice)}`
    : row.sector;
}

/**
 * Whether a row can be acted on.
 *
 * A row with no price is still listed and still worth reading — it says the asset exists and cannot
 * be priced here — but an order ticket opened on it would have nothing to put in front of someone
 * before they commit money, so the row does not lead anywhere.
 */
export function isTradable(row: XStockRow): boolean {
  return row.feed === 'live' && row.price !== null;
}
