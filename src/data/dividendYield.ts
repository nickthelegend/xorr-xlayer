/**
 * What an xStock has paid its holders, as the app reads it.
 *
 * Backed reinvests dividends by moving the Scaled UI multiplier, so the yield is derived from the
 * multiplier's own history rather than from a calendar nobody publishes.
 *
 * `unmeasured` is a real answer and is kept distinct from zero all the way to the screen: a window
 * we have not watched long enough is not a window in which the token paid nothing.
 */
import { API_BASE } from './apiBase';

export type ExcludedStep = { from: number; to: number; factor: number; at: string; reason: string };

export type YieldWindow =
  | {
      status: 'measured';
      symbol: string;
      yieldFraction: number;
      annualisedFraction: number | null;
      observations: number;
      from: string;
      to: string;
      days: number;
      excluded: readonly ExcludedStep[];
    }
  | { status: 'unmeasured'; symbol: string; reason: string };

export async function fetchYield(symbol: string, signal?: AbortSignal): Promise<YieldWindow> {
  const unmeasured = (reason: string): YieldWindow => ({ status: 'unmeasured', symbol, reason });
  try {
    const res = await fetch(`${API_BASE}/xstocks/${encodeURIComponent(symbol)}/yield`, { signal });
    if (!res.ok) return unmeasured(`The executor answered ${res.status}.`);
    const body = (await res.json()) as YieldWindow;
    if (body?.status === 'measured' && Number.isFinite(body.yieldFraction)) return body;
    if (body?.status === 'unmeasured') return body;
    return unmeasured('The executor sent an answer this build cannot read.');
  } catch {
    return unmeasured('The executor could not be reached.');
  }
}

/**
 * The yield as a line of text, or null where there is nothing to draw.
 *
 * Returning null rather than "0.00%" is the whole point: a caller that gets null draws no line,
 * and a caller that gets a string draws a measurement somebody actually took.
 */
export function yieldLine(w: YieldWindow): string | null {
  if (w.status !== 'measured') return null;
  const pct = (w.yieldFraction * 100).toFixed(2);
  const over = w.days >= 1 ? `over ${Math.round(w.days)} days` : 'so far';
  return w.annualisedFraction !== null
    ? `${pct}% reinvested ${over} · ${(w.annualisedFraction * 100).toFixed(2)}% annualised`
    : `${pct}% reinvested ${over}`;
}
