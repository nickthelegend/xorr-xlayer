/**
 * Is an xStock actually backed by the share it claims to represent?
 *
 * Backed's attestor publishes shares held against tokens in circulation; the executor reads that
 * and hands back either a measured ratio or the reason it has none. Both are answers about the
 * asset, so both arrive as a 200 — there is no error case to catch here, only a shape to handle.
 *
 * A network failure is `unverified` too. Every path out of this function that is not a reading
 * from the attestor says so, because the alternative is a tokenized-equity app drawing a
 * confident "1:1" nobody measured.
 */
import { API_BASE } from './apiBase';

export type Custodian = { provider: string; quantity: number; symbol: string };

export type Backing =
  | {
      verified: true;
      symbol: string;
      /** sharesHeld / circulatingSupply. At or above 1 is fully backed. */
      ratio: number;
      fullyBacked: boolean;
      sharesHeld: number;
      circulatingSupply: number;
      custodians: readonly Custodian[];
      /** When the attestor observed it — not when we asked. */
      asOf: string;
    }
  | { verified: false; symbol: string; reason: string };

export async function fetchBacking(symbol: string, signal?: AbortSignal): Promise<Backing> {
  try {
    const res = await fetch(`${API_BASE}/xstocks/${encodeURIComponent(symbol)}/backing`, { signal });
    if (!res.ok) {
      return { verified: false, symbol, reason: `The executor answered ${res.status}.` };
    }
    const body = (await res.json()) as Backing;
    // Trust the shape only as far as the flag: anything malformed is an unread attestation.
    if (body?.verified === true && Number.isFinite((body as { ratio: number }).ratio)) return body;
    if (body?.verified === false) return body;
    return { verified: false, symbol, reason: 'The executor sent an answer this build cannot read.' };
  } catch {
    return { verified: false, symbol, reason: 'The executor could not be reached.' };
  }
}

/**
 * How a ratio should read on a badge.
 *
 * Deliberately not a percentage: "100.1%" invites a reader to wonder about the 0.1, when the fact
 * that matters is whether the share is there at all. Over-collateralisation is normal — the
 * custodian holds whole shares while supply moves continuously.
 */
export function backingLabel(b: Backing): string {
  if (!b.verified) return 'Backing unverified';
  return b.fullyBacked ? '1:1 backed' : 'Under-backed';
}
