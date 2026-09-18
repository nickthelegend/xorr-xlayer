/**
 * Everything the backing drawer shows about one xStock.
 *
 * The shape is deliberately full of `null`s. A field we have no record of arrives as `null` and
 * is rendered as a sentence — never as a dash, which a reader takes for zero, and never omitted,
 * which a reader takes for "not applicable". "We don't know who can pause this" and "nobody can
 * pause this" are different facts about a security.
 */
import { API_BASE } from './apiBase';
import type { Custodian } from './backing';

export type MultiplierPoint = { multiplier: number; effectiveAt: string; observedAt: string };

export type BackingDetail = {
  symbol: string;
  name: string | null;
  /** The ERC-4626 wrapper on X Layer — what trades and what a wallet holds. */
  address: string;
  /** The raw rebasing xStock behind the wrapper, where the issuer's roles live. */
  raw: string;
  /** The issuer's powers over the RAW token. Each address is null where it could not be read. */
  issuer: {
    /** Can reassign every role below, and owns the ProxyAdmin that can upgrade the contract. */
    owner: string | null;
    /** Can create new tokens. */
    minter: string | null;
    /** Can burn — only its own balance; burning a holder's balance reverts on chain. */
    burner: string | null;
    /** Can halt all transfers. */
    pauser: string | null;
    /** Can change the corporate-action multiplier. */
    multiplierUpdater: string | null;
    /** The contract whose list blocks an address from sending or receiving. */
    sanctionsList: string | null;
    /** The EIP-1967 ProxyAdmin: whoever controls it can replace the token's code. */
    upgradeAdmin: string | null;
    /** A non-zero minter is set. Null when the minter could not be read. */
    canMint: boolean | null;
    /** A non-zero pauser is set. Null when the pauser could not be read. */
    canPause: boolean | null;
    /** Whether transfers are halted right now. Null when it could not be read. */
    paused: boolean | null;
  };
  /** The same questions of the wrapper, which has its own owner, pauser and proxy. */
  wrapper: {
    owner: string | null;
    pauser: string | null;
    upgradeAdmin: string | null;
    paused: boolean | null;
  };
  /** Tokens in existence on X Layer, in whole tokens. Null where unread. */
  supply: {
    /** Raw xStocks on X Layer, wrapped or not. */
    raw: number | null;
    /** Wrapper shares outstanding. */
    wrapped: number | null;
    /** Raw xStocks the wrapper holds (`totalAssets()`). */
    wrappedAssets: number | null;
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
