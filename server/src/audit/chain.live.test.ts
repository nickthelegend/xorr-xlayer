/**
 * The hash chain under CONCURRENCY, against a real database.
 *
 * `log.test.ts` proves the hashing is deterministic. It cannot prove the property that actually
 * broke: `append` read the tail with `lastHash` and then wrote a row committing to it, with nothing
 * holding the two together. Two appends for one wallet in flight at once both read the same tail,
 * both claimed it, and the chain was severed from that point on — permanently, because the trail is
 * append-only by trigger and a break cannot be repaired.
 *
 * It was not theoretical. `/verify` on a real wallet reported **"chain broken at entry 2"**, and
 * creating the unique index in migration 008 failed with the duplicate as evidence. The
 * tamper-evidence claim was failing for a reason that had nothing to do with tampering.
 *
 * So this fires twenty appends at once and checks the chain end to end. Live, because a lock in
 * Postgres cannot be tested without Postgres.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { append, verify } from './log.js';
import { query } from '../db/index.js';

/** A throwaway wallet per run — the rows cannot be deleted afterwards, by design. */
async function scratchWallet(): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO wallets (id, user_id, address, kind, cluster)
     VALUES ($1, $2, $3, 'embedded', 'test')`,
    [id, `did:privy:chain-test-${id}`, `0x${id.replace(/-/g, '').slice(0, 40)}`],
  );
  return id;
}

describe('the audit chain holds under concurrent writes', () => {
  it('twenty simultaneous appends produce one unbroken chain', async () => {
    const walletId = await scratchWallet();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        append({
          walletId,
          agent: 'concurrency',
          action: `entry ${i}`,
          detail: 'written at the same moment as nineteen others',
          kind: 'trade',
        }),
      ),
    );

    const v = await verify(walletId);
    expect(v.checked).toBe(20);
    expect(v.brokenAtSeq, `chain broke at ${v.brokenAtSeq}`).toBeUndefined();
    expect(v.ok).toBe(true);
  }, 60_000);

  it('every row commits to exactly one predecessor', async () => {
    const walletId = await scratchWallet();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        append({ walletId, agent: 'concurrency', action: `e${i}`, detail: '', kind: 'trade' }),
      ),
    );
    // The shape the unique index in migration 008 enforces: no two rows share a `prev_hash`.
    const dupes = await query<{ n: string }>(
      `SELECT count(*) AS n FROM (
         SELECT prev_hash FROM audit_log WHERE wallet_id = $1 GROUP BY 1 HAVING count(*) > 1
       ) d`,
      [walletId],
    );
    expect(Number(dupes[0]?.n ?? 0)).toBe(0);
  }, 60_000);

  it('refuses to let the trail be rewritten, which is why a break cannot be repaired', async () => {
    const walletId = await scratchWallet();
    await append({ walletId, agent: 'concurrency', action: 'once', detail: '', kind: 'trade' });
    await expect(
      query(`UPDATE audit_log SET action = 'edited' WHERE wallet_id = $1`, [walletId]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      query(`DELETE FROM audit_log WHERE wallet_id = $1`, [walletId]),
    ).rejects.toThrow(/append-only/i);
  }, 30_000);
});
