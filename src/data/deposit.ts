/**
 * Money in (PLAN.md 4.4, 4.5): what the wallet holds, read from the chain, and the faucet.
 *
 * These mirror `GET /wallet/funds`, `GET /faucet` and `POST /faucet` field for field. Raw amounts stay strings: they are
 * uint256 values, and a number would round them. Every nullable is nullable because the executor could not know it, and a
 * zero would be a different claim.
 */
import { api, ApiError } from './api';
import type { Keyed } from './intentKey';

/**
 * The two things a deposit lands as: USDC to trade with, and OKB — X Layer's gas token — to sign with. The executor
 * names the native balance `eth` (its field name from the EVM build); on X Layer that amount is OKB.
 */
export type WalletFunds = {
  owner: string;
  chain: string;
  usdc: { address: string; raw: string; amount: number };
  /** Native OKB, in wei-scaled raw units and whole OKB. */
  eth: { raw: string; amount: number };
  /** When the executor read them, in milliseconds. */
  readAt: number;
};

/** What this deployment's faucet can send, and whether this wallet may ask for it now. */
export type FaucetStatus = {
  chain: string;
  available: boolean;
  /** Why nothing can be sent, as an identifier — `detail` is the sentence. Null when something can. */
  reason: string | null;
  detail: string;
  /** A real holder impersonated on a fork, or the faucet key on a testnet. */
  source: 'fork-holder' | 'faucet-key' | null;
  from: string | null;
  /** USDC one request sends. */
  usdc: number | null;
  usdcRaw: string | null;
  /** The OKB a fork wallet is raised to for gas. Null on a testnet. */
  ethFloor: number | null;
  windowHours: number;
  /** Null for an account with no wallet registered yet. */
  wallet: {
    address: string;
    lastClaimAt: number | null;
    /** When this wallet may ask again, while it may not. Null once it may. */
    nextAt: number | null;
    canAsk: boolean;
  } | null;
};

/** How raising a fork wallet's OKB (the `eth` field) went: what it held, what was added and what it holds — or why nothing was added. */
export type EthTopUp =
  | { floor: number; before: number; added: number; after: number | null }
  | { floor: number; failed: string };

/** What asking the faucet came back as: what arrived and in which transaction, or why nothing was sent. */
export type FaucetOutcome =
  | {
      status: 'sent';
      chain: string;
      source: 'fork-holder' | 'faucet-key';
      from: string;
      to: string;
      txHash: string;
      block: string;
      /** A block explorer link, or `fork:<hash>` where no explorer has the transaction. */
      explorer: string;
      /** `after` is null when the balance could not be read back; the receipt is what proved the arrival. */
      usdc: { amount: number; raw: string; before: number; after: number | null };
      eth: EthTopUp | null;
      claimedAt: number;
      nextAt: number;
      /** False when the USDC arrived and the executor could not write it down; `detail` says so. */
      recorded: boolean;
      detail?: string;
    }
  | { status: 'blocked'; reason: string; detail: string; lastClaimAt?: number; nextAt?: number }
  | { status: 'failed'; error: string; txHash?: string };

export function walletFunds(): Promise<WalletFunds> {
  return api.get<WalletFunds>('/wallet/funds');
}

export function faucetStatus(): Promise<FaucetStatus> {
  return api.get<FaucetStatus>('/faucet');
}

/**
 * Ask the faucet. A refusal (409) or a failure (502) carries the executor's own sentence in its body, so it is returned for
 * the screen to show rather than thrown as a status code.
 *
 * `write` is the claim's `Idempotency-Key` (FEATURES.md #29). Optional only because onboarding's Fund screen still claims
 * without one.
 */
export async function requestFaucet(write?: Keyed): Promise<FaucetOutcome> {
  try {
    return await api.post<FaucetOutcome>('/faucet', {}, write);
  } catch (e) {
    if (e instanceof ApiError && e.body && typeof e.body === 'object' && 'status' in e.body) {
      return e.body as FaucetOutcome;
    }
    throw e;
  }
}
