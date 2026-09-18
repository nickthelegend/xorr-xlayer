/**
 * Which wallet a signed-in user may call theirs (2026-09-13).
 *
 * `/wallet/connect` trusted the address in the request body and upserted it with
 * `ON CONFLICT (address) DO UPDATE SET user_id = EXCLUDED.user_id` — so any signed-in user could move
 * any wallet row to their own account. That row is the only link between a person and the wallet the
 * bot trades (one delegate key serves everyone), so the takeover reached `/orders`, `/positions/close`
 * and `/panic/flatten` on someone else's permission, and every new address drew a test-ETH drip.
 *
 * Two rules now, one in each half:
 *   - the address must be a wallet on the caller's own Privy account — Privy verifies that link, a
 *     request body cannot; and
 *   - an existing row is never moved to a different user. The upsert only touches a row the caller
 *     already owns, and a conflict is reported rather than resolved in the caller's favour.
 */
import { getAddress, isAddress } from 'viem';
import { one } from '../db/index.js';
import type { LinkedWallet } from './privy.js';
import type { WalletRow } from '../routes/wallet-context.js';

/** The caller's own wallet at this address, whichever case either side spelled it in. */
export function findLinkedWallet(
  wallets: readonly LinkedWallet[],
  address: string,
): LinkedWallet | undefined {
  if (!isAddress(address, { strict: false })) return undefined;
  const wanted = getAddress(address);
  return wallets.find((w) => isAddress(w.address, { strict: false }) && getAddress(w.address) === wanted);
}

export type BindResult =
  | { status: 'bound'; row: WalletRow; inserted: boolean }
  | { status: 'owned_by_another_user' };

/**
 * Register `address` for `userId`, or refuse. Never reassigns: when the row belongs to someone else,
 * nothing is written and the caller is told.
 *
 * `(xmax = 0)` is true only for a row this statement inserted, which is what "first sight" means for
 * the gas drip. It is asked of the write itself rather than of a read before it, so two concurrent
 * first connects cannot both believe they were first.
 */
export async function bindWallet(params: {
  id: string;
  userId: string;
  address: string;
  kind: 'embedded' | 'connected';
  cluster: string;
}): Promise<BindResult> {
  const row = await one<WalletRow & { inserted: boolean }>(
    `INSERT INTO wallets (id, user_id, address, kind, cluster, active_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (address) DO UPDATE
       SET kind = EXCLUDED.kind, active_at = now()
       WHERE wallets.user_id = EXCLUDED.user_id
     RETURNING *, (xmax = 0) AS inserted`,
    [params.id, params.userId, params.address, params.kind, params.cluster],
  );
  if (!row) return { status: 'owned_by_another_user' };
  const { inserted, ...wallet } = row;
  return { status: 'bound', row: wallet, inserted };
}
