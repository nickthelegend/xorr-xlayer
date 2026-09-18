/**
 * Everything a position can say about what backs it (PLAN.md §8.4).
 *
 * Three sources, and they answer different questions:
 *
 *   the mint        who the issuer is, what they can do to a holder's tokens, and what the
 *                   scaled-UI multiplier is right now — read on-chain.
 *   the attestor    how many real shares sit with a custodian against tokens in circulation.
 *   our own tables  how those two have moved, because neither source keeps history: the
 *                   attestation endpoint publishes only its latest observation, and the mint
 *                   carries only the current multiplier and at most one pending change.
 *
 * Rules the drawer is built on:
 *
 *   A field is drawn from a recorded value or it is absent. `null` here means "we have no record
 *   of this", and the screen says so in words — never a dash, which reads as zero.
 *
 *   An attestation is reported with its age. "1.0011x backed" with no timestamp implies
 *   "now", and an attestation from six days ago is a different claim from one taken this morning.
 *   `ageSeconds` is stated and `stale` is derived from it, so the screen never has to guess.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import {
  getMint,
  getTransferHook,
  getPausableConfig,
  getPermanentDelegate,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { connection as defaultConnection } from '../solana/connection.js';
import { readScaledUiConfig, tokenProgramForMint, toPublicKey } from '../solana/balances.js';
import { query } from '../db/index.js';
import { backingFor, backingHistory, type CustodyHolding } from './proof-of-reserves.js';
import { XSTOCKS, xStockKey } from './xstocks.js';

/**
 * An attestation older than this is called stale.
 *
 * Backed's attestor refreshes roughly every ten minutes and Chainlink relays daily, so a day
 * without a fresh observation is the point at which "as of now" stops being a fair description.
 */
const STALE_AFTER_SECONDS = 24 * 60 * 60;

export type MultiplierPoint = {
  multiplier: number;
  effectiveAt: string;
  observedAt: string;
};

export type BackingDetail = {
  symbol: string;
  name: string | null;
  mint: string;

  issuer: {
    /** Who can seize tokens from any account. `null` where the mint grants nobody that power. */
    permanentDelegate: string | null;
    /** Who can freeze an individual account. */
    freezeAuthority: string | null;
    mintAuthority: string | null;
    /** Whether the issuer can halt all transfers, and whether they currently have. */
    pausable: { authority: string; paused: boolean } | null;
    /** The configured transfer-hook program, or null where the extension points nowhere. */
    transferHookProgram: string | null;
  };

  reserves:
    | {
        verified: true;
        ratio: number;
        fullyBacked: boolean;
        sharesHeld: number;
        circulatingSupply: number;
        custodians: CustodyHolding[];
        /** The attestor's own observation time. */
        asOf: string;
        /** How old that observation is, in seconds, at the moment of this read. */
        ageSeconds: number;
        stale: boolean;
      }
    | { verified: false; reason: string };

  multiplier: {
    /** Null where the mint carries no scaled-UI extension at all. */
    current: number | null;
    /** When the current multiplier took effect, where the mint states it. */
    effectiveAt: string | null;
    /** A scheduled change the issuer has already published. */
    pending: { multiplier: number; effectiveAt: string } | null;
    /**
     * Changes we have actually recorded. Empty is a real answer — it means we have watched this
     * mint but seen no change yet, not that no change has ever happened.
     */
    history: MultiplierPoint[];
  };

  /** Attestations we have recorded, newest first. Empty where we have not recorded any. */
  attestationHistory: { ratio: number; sharesHeld: number; asOf: string }[];
};

/** Remember a multiplier as observed. Unchanged values collapse onto the existing row. */
export async function recordMultiplier(params: {
  mint: string;
  symbol: string | null;
  multiplier: number;
  decimals: number;
  effectiveAt: string;
  pending: { multiplier: number; effectiveAt: string } | null;
}): Promise<void> {
  await query(
    `INSERT INTO multiplier_observations
       (mint, symbol, multiplier, decimals, new_multiplier, new_multiplier_at, effective_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (mint, multiplier, effective_at) DO NOTHING`,
    [
      params.mint,
      params.symbol,
      params.multiplier,
      params.decimals,
      params.pending?.multiplier ?? null,
      params.pending?.effectiveAt ?? null,
      params.effectiveAt,
    ],
  ).catch(() => undefined);
}

async function multiplierHistory(mint: string, limit = 30): Promise<MultiplierPoint[]> {
  const rows = await query<{ multiplier: string; effective_at: Date; observed_at: Date }>(
    `SELECT multiplier, effective_at, observed_at FROM multiplier_observations
      WHERE mint = $1 ORDER BY effective_at DESC, observed_at DESC LIMIT $2`,
    [mint, limit],
  ).catch(() => []);

  return rows.map((r) => ({
    multiplier: Number(r.multiplier),
    effectiveAt: r.effective_at.toISOString(),
    observedAt: r.observed_at.toISOString(),
  }));
}

export async function backingDetail(
  symbolOrMint: string,
  conn: Connection = defaultConnection,
): Promise<BackingDetail | null> {
  const key = xStockKey(symbolOrMint) ?? symbolOrMint;
  const token = XSTOCKS[key];
  if (!token) return null;

  const mintPk = toPublicKey(token.address);
  const prog = tokenProgramForMint(mintPk);

  const issuer: BackingDetail['issuer'] = {
    permanentDelegate: null,
    freezeAuthority: null,
    mintAuthority: null,
    pausable: null,
    transferHookProgram: null,
  };
  let current: number | null = null;
  let effectiveAt: string | null = null;
  let pending: { multiplier: number; effectiveAt: string } | null = null;

  try {
    const mintInfo = await getMint(conn, mintPk, 'confirmed', prog);
    issuer.freezeAuthority = mintInfo.freezeAuthority?.toBase58() ?? null;
    issuer.mintAuthority = mintInfo.mintAuthority?.toBase58() ?? null;

    if (prog.equals(TOKEN_2022_PROGRAM_ID)) {
      issuer.permanentDelegate = getPermanentDelegate(mintInfo)?.delegate.toBase58() ?? null;

      const pause = getPausableConfig(mintInfo);
      issuer.pausable = pause
        ? { authority: pause.authority.toBase58(), paused: pause.paused }
        : null;

      const hook = getTransferHook(mintInfo);
      issuer.transferHookProgram =
        hook && !hook.programId.equals(PublicKey.default) ? hook.programId.toBase58() : null;

      const scale = readScaledUiConfig(mintInfo);
      if (scale) {
        current = scale.multiplier;
        effectiveAt = scale.effectiveAt;
        pending = scale.pending ?? null;
        void recordMultiplier({
          mint: token.address,
          symbol: token.symbol,
          multiplier: scale.multiplier,
          decimals: mintInfo.decimals,
          effectiveAt: scale.effectiveAt,
          pending,
        });
      }
    }
  } catch {
    // Leave the issuer fields null: "we have no record of this" is the honest shape, and the
    // screen renders that as words rather than as a dash.
  }

  const status = await backingFor(token.symbol);
  const reserves: BackingDetail['reserves'] =
    status.status === 'verified'
      ? (() => {
          const b = status.backing;
          const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(b.asOf)) / 1000));
          return {
            verified: true as const,
            ratio: b.ratio,
            fullyBacked: b.ratio >= 1,
            sharesHeld: b.sharesHeld,
            circulatingSupply: b.circulatingSupply,
            custodians: b.custodians,
            asOf: b.asOf,
            ageSeconds,
            stale: ageSeconds > STALE_AFTER_SECONDS,
          };
        })()
      : { verified: false as const, reason: status.reason };

  const [history, attestations] = await Promise.all([
    multiplierHistory(token.address),
    backingHistory(token.symbol),
  ]);

  return {
    symbol: token.symbol,
    name: token.name ?? null,
    mint: token.address,
    issuer,
    reserves,
    multiplier: { current, effectiveAt, pending, history },
    attestationHistory: attestations.map((a) => ({
      ratio: a.ratio,
      sharesHeld: a.sharesHeld,
      asOf: a.asOf,
    })),
  };
}
