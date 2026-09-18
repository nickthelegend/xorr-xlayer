/**
 * How an xStock's backing has moved, from attestations the executor has recorded.
 *
 * `observations` travels with the points on purpose. A line drawn from two readings and one drawn
 * from two hundred look alike and claim very different things, and the screen has to be able to
 * say which it is holding rather than letting the shape imply it.
 */
import { API_BASE } from './apiBase';

export type ReservePoint = {
  ratio: number;
  sharesHeld: number;
  circulatingSupply: number;
  asOf: string;
};

export type ReservesHistory = {
  symbol: string;
  observations: number;
  points: readonly ReservePoint[];
  from: string | null;
  to: string | null;
};

export async function fetchReservesHistory(
  symbol: string,
  signal?: AbortSignal,
): Promise<ReservesHistory | null> {
  try {
    const res = await fetch(
      `${API_BASE}/xstocks/${encodeURIComponent(symbol)}/reserves/history`,
      { signal },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as ReservesHistory;
    return Array.isArray(body?.points) ? body : null;
  } catch {
    return null;
  }
}

/**
 * What the chart should say about how much it is drawing from.
 *
 * Always mentions the count. A reader who knows a line rests on two observations reads it very
 * differently from one who assumes it rests on months, and only one of those readings is fair.
 */
export function provenance(history: ReservesHistory): string {
  const n = history.observations;
  if (n === 0) return 'No attestations recorded yet.';
  if (n === 1) return 'One attestation recorded so far — not enough to show a trend.';
  return `${n} attestations recorded since we began watching.`;
}
