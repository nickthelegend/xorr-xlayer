/**
 * Limit orders (PLAN.md 3.15): the 1inch orders makers have published to the executor, and taking one through the
 * trading permission.
 *
 * These mirror `GET /limit-orders` and `POST /limit-orders/:hash/fill` field for field. The raw amounts stay strings:
 * they are uint256 values, and a number would round them.
 */
import { api, ApiError } from './api';
import type { Keyed } from './intentKey';

/**
 * `open` can be taken now. `filled` was taken through this executor; `invalidated` had its nonce spent elsewhere — filled
 * by someone else or cancelled by its maker; `unfunded` means the maker no longer holds or allows what it sells; and
 * `unknown` is a chain read that failed, which is neither a yes nor a no.
 */
export type LimitOrderStatus = 'open' | 'filled' | 'invalidated' | 'expired' | 'unfunded' | 'unknown';

export type LimitOrder = {
  hash: string;
  maker: string;
  /** The token the order sells, and the one it is paid in. */
  sells: string;
  pays: string;
  makingAmount: string;
  takingAmount: string;
  /** How much it sells, and what taking all of it costs. */
  size: number;
  cost: number;
  /** What one unit costs, in the token it is paid in. */
  price: number;
  nonce: string;
  /** Milliseconds; null for an order that never expires. */
  expiresAt: number | null;
  createdAt: number;
  status: LimitOrderStatus;
  /** Null when the chain could not be read. */
  fillable: boolean | null;
  detail: string;
  filledAt: number | null;
  fillTx: string | null;
  takenByYou: boolean;
};

export type LimitOrderList = {
  /** False where nothing settles: `orders` is empty and `detail` says why. */
  settles: boolean;
  chain: string;
  detail: string | null;
  orders: LimitOrder[];
};

/** What taking an order came back as: what arrived, or why nothing moved. */
export type LimitFillOutcome =
  | {
      status: 'filled';
      hash: string;
      bought: string;
      received: number;
      paid: number;
      price: number;
      /** False when the balance could not be read back, and `received` is the size the contract guaranteed. */
      measured: boolean;
      venue: string;
      txHash: string;
    }
  | { status: 'blocked'; reason: string; detail: string }
  | { status: 'failed'; error: string; txHash?: string };

export function limitOrders(): Promise<LimitOrderList> {
  return api.get<LimitOrderList>('/limit-orders');
}

/**
 * Take one whole order. A refusal (400, 404, 409) or a failure (502) carries the executor's own sentence in its body, so
 * it is returned for the screen to show rather than thrown as a status code, as `system.swap` does.
 */
export async function fillLimitOrder(hash: string, write?: Keyed): Promise<LimitFillOutcome> {
  try {
    return await api.post<LimitFillOutcome>(`/limit-orders/${encodeURIComponent(hash)}/fill`, {}, write);
  } catch (e) {
    if (e instanceof ApiError && e.body && typeof e.body === 'object' && 'status' in e.body) {
      return e.body as LimitFillOutcome;
    }
    throw e;
  }
}
