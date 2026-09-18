/**
 * Withdrawals (PLAN.md 4.9): the allowlist the executor holds, the check it makes before a signature, the transfer it
 * prepares for "withdraw everything", and the record of what a signed withdrawal moved — plus the existing executor
 * routes "withdraw everything" is built from.
 *
 * These mirror `server/src/routes/withdrawals.ts` field for field. Times are milliseconds by the executor's database
 * clock, never this device's. Raw amounts stay strings: they are uint256 values, and a number would round them.
 *
 * A refusal (400, 403, 404, 409) or a failure (502) that carries a `status` in its body is the executor's own sentence,
 * so it is returned for the caller to show rather than thrown as a status code.
 */
import { api, ApiError } from './api';
import type { Keyed } from './intentKey';

export type WithdrawalAddress = {
  address: string;
  label: string;
  addedAt: number;
  /** When the executor's clock lets anything be sent to it. */
  usableAt: number;
  /** Decided by the executor's database when the list was read. */
  usable: boolean;
};

export type WithdrawalAddressBook = {
  coolingOffHours: number;
  /** The executor's clock at the moment every `usable` in `addresses` was decided. */
  serverTime: number;
  addresses: WithdrawalAddress[];
};

/** The executor refused, and said why. `detail` is written for the person reading it. */
export type Refusal = { status: 'blocked'; reason: string; detail: string };

export type AddOutcome =
  | { status: 'added'; coolingOffHours: number; entry: WithdrawalAddress }
  | (Refusal & { entry?: WithdrawalAddress });

export type RemoveOutcome = { status: 'removed'; address: string; label: string } | Refusal;

export type CheckOutcome =
  | { status: 'usable'; address: string; label: string; usableAt: number }
  | (Refusal & { label?: string; usableAt?: number });

export type PreparedWithdrawal = {
  status: 'prepared';
  /** The call the owner signs: `transfer(destination, amountRaw)` on the token. */
  call: { to: string; data: `0x${string}` };
  token: { symbol: string; address: string; decimals: number };
  /** The whole balance, exactly, in the token's units. */
  amount: string;
  amountRaw: string;
  destination: { address: string; label: string };
};

export type PrepareOutcome = PreparedWithdrawal | (Refusal & { label?: string; usableAt?: number });

export type RecordedTransfer = {
  token: string;
  symbol: string | null;
  to: string;
  amount: string | null;
  amountRaw: string;
  /** The allowlist's name for the destination, when it has one. */
  label: string | null;
  usable: boolean;
};

export type RecordOutcome =
  | {
      status: 'confirmed';
      txHash: string;
      transfers: RecordedTransfer[];
      /** USDC Aave paid back, when the transaction was an exit from it. */
      aave: { amount: string; amountRaw: string } | null;
      duplicate: boolean;
    }
  | { status: 'reverted'; txHash: string; detail: string }
  | { status: 'unknown'; detail: string }
  | Refusal;

/** What selling everything would sell (`/panic/preview`). A wallet the executor has no row for gets only the first two. */
export type SellPreview = {
  legs: { symbol: string; units: number; usd: number }[];
  totalUsd: number;
  dustBelowUsd?: number;
  skipped?: string[];
};

/** One whole position sold through the permission (`/positions/close`). A `no_wallet` refusal carries no detail. */
export type CloseOutcome =
  | { status: 'closed'; symbol: string; units: number; usd: number; measured: boolean; txHash: string }
  | { status: 'blocked'; reason: string; detail?: string }
  | { status: 'failed'; symbol?: string; error: string };

/**
 * What this wallet has in savings (`/yield/position`) — the one type for this endpoint.
 *
 * There were two, and they disagreed: `useAaveWithdraw` declared `apy` always present, so Yield multiplied
 * it by a hundred and a response without it read "NaN% a year". The executor sends `apy` only once it has
 * read the reserve — never for a wallet it has no row for — and says in `reason` why `available` is false.
 */
export type AavePosition = {
  suppliedUsd: number;
  available: boolean;
  /** A fraction, not points: 0.0388 is 3.88%. */
  apy?: number;
  /** A sentence, or `no_wallet` when the executor has no wallet row for this session. */
  reason?: string;
  pool?: string;
  aToken?: string;
  asset?: string;
};

/** The exit from Aave the owner signs (`/yield/withdraw-calldata`). */
export type AaveWithdrawCall = { to: string; data: `0x${string}`; isMax: boolean };

/** The executor's written refusal when the response carried one; the error itself otherwise. */
async function refusalOr<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (e) {
    if (e instanceof ApiError && e.body && typeof e.body === 'object' && 'status' in e.body) return e.body as T;
    throw e;
  }
}

export const withdrawals = {
  /* the allowlist */
  addresses: () => api.get<WithdrawalAddressBook>('/withdrawal-addresses'),
  add: (label: string, address: string) =>
    refusalOr(api.post<AddOutcome>('/withdrawal-addresses', { label, address })),
  // A body, not a path: the executor's access log prints paths, and this is where someone keeps their money.
  remove: (address: string) => refusalOr(api.post<RemoveOutcome>('/withdrawal-addresses/remove', { address })),
  check: (address: string) => refusalOr(api.post<CheckOutcome>('/withdrawal-addresses/check', { address })),

  /* withdrawing */
  prepareAll: (to: string, token: string) =>
    refusalOr(api.post<PrepareOutcome>('/withdrawals/prepare-all', { to, token })),
  record: (txHash: string) => refusalOr(api.post<RecordOutcome>('/withdrawals/record', { txHash })),

  /* the rest of "withdraw everything", which the executor already served */
  sellPreview: () => api.get<SellPreview>('/panic/preview'),
  close: (symbol: string, write?: Keyed) =>
    refusalOr(api.post<CloseOutcome>('/positions/close', { symbol, fraction: 1 }, write)),
  aavePosition: () => api.get<AavePosition>('/yield/position'),
  // `usd: null` is all of it: Aave's max sentinel, the only way to leave no interest behind.
  aaveWithdrawCall: () => api.post<AaveWithdrawCall>('/yield/withdraw-calldata', { usd: null }),
} as const;
