/**
 * Everything the backing drawer shows about one xStock.
 *
 * The shape is deliberately full of `null`s. A field we have no record of arrives as `null` and
 * is rendered as a sentence — never as a dash, which a reader takes for zero, and never omitted,
 * which a reader takes for "not applicable". "We don't know who can freeze this" and "nobody can
 * freeze this" are different facts about a security.
 */
import { API_BASE } from './apiBase';
import type { Custodian } from './backing';

export type MultiplierPoint = { multiplier: number; effectiveAt: string; observedAt: string };

export type BackingDetail = {
  symbol: string;
  name: string | null;
  mint: string;
  issuer: {
    permanentDelegate: string | null;
    freezeAuthority: string | null;
    mintAuthority: string | null;
    pausable: { authority: string; paused: boolean } | null;
    transferHookProgram: string | null;
  };
  reserves:
    | {
        verified: true;
        ratio: number;
        fullyBacked: boolean;
        sharesHeld: number;
        circulatingSupply: number;
        custodians: readonly Custodian[];
        asOf: string;
        ageSeconds: number;
        stale: boolean;
      }
    | { verified: false; reason: string };
  multiplier: {
    current: number | null;
    effectiveAt: string | null;
    pending: { multiplier: number; effectiveAt: string } | null;
    history: readonly MultiplierPoint[];
  };
  attestationHistory: readonly { ratio: number; sharesHeld: number; asOf: string }[];
};

export async function fetchBackingDetail(
  symbol: string,
  signal?: AbortSignal,
): Promise<BackingDetail | null> {
  try {
    const res = await fetch(`${API_BASE}/xstocks/${encodeURIComponent(symbol)}/backing/detail`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as BackingDetail;
    return body?.symbol ? body : null;
  } catch {
    return null;
  }
}

/**
 * How old an attestation is, in words.
 *
 * Always says when, because "1.0011x backed" with no time attached reads as "right now". An
 * attestation from last week is a different claim from one taken this morning, and the drawer has
 * to let a reader tell them apart at a glance.
 */
export function attestationAge(ageSeconds: number): string {
  if (ageSeconds < 90) return 'just now';
  const minutes = Math.round(ageSeconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** What a missing field should say. Never a dash — a dash reads as zero. */
export const NO_RECORD = 'No record';
