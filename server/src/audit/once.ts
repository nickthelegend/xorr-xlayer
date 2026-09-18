/**
 * A trail entry written once per transaction (PLAN.md X76).
 *
 * The trail is append-only: a duplicate can never be taken back out. `/delegation/record` and `/delegation/revoke` each
 * wrote their entry — and the grant its row — every time the app posted the same hash, so a retried request, or a second
 * press while the first was still waiting on the chain, recorded one grant as two and one stop as two.
 *
 * So the look and the write happen in the caller's transaction, under a lock on the hash: whoever takes it first finds
 * nothing and writes; whoever comes after waits for that transaction, then finds the entry and writes nothing. The lock is
 * a transaction lock, released at COMMIT or ROLLBACK, so a request that dies mid-write leaves nothing held.
 */

/** The part of a Postgres client this needs; a `PoolClient` inside `tx()` is one. */
export type Querier = { query(text: string, params?: unknown[]): Promise<{ rowCount: number | null }> };

/** Run `write` unless the trail already carries `action` for `signature` on this wallet. True when it wrote. */
export async function oncePerTransaction(
  client: Querier,
  key: { walletId: string; action: string; signature: string },
  write: () => Promise<void>,
): Promise<boolean> {
  const signature = key.signature.toLowerCase();
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`trail:${key.action}:${signature}`]);
  const seen = await client.query(
    'SELECT 1 FROM audit_log WHERE wallet_id = $1 AND action = $2 AND lower(signature) = $3 LIMIT 1',
    [key.walletId, key.action, signature],
  );
  if ((seen.rowCount ?? 0) > 0) return false;
  await write();
  return true;
}
