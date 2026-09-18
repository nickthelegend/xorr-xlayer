-- One row per predecessor, enforced by the database.
--
-- `append` serialises itself with a per-wallet advisory lock, which is the fix. This is the
-- backstop for what a lock cannot cover: a second process, a future caller that forgets the
-- transaction, a hand-written INSERT. Two rows claiming the same `prev_hash` is precisely what a
-- broken chain looks like, and making it impossible is cheaper than detecting it afterwards.
--
-- WHY THIS IS CONDITIONAL
--
-- The race already happened. Creating this index on a database that ran the old code fails with
-- "Key (wallet_id, prev_hash)=(…) is duplicated" — which is the bug's own evidence, and exactly
-- the state `/verify` reports as "chain broken at entry N".
--
-- A break cannot be repaired. The audit trail is append-only by trigger and that is the property
-- the whole thing exists for: a log that can be rewritten to look correct proves nothing. So the
-- historical break stays, visible, and this index protects everything written from here on.
-- Silently skipping would hide it; failing the migration would block a deploy over history nobody
-- can change. It warns, loudly, and names the wallet.
DO $$
DECLARE
  broken int;
BEGIN
  SELECT count(*) INTO broken FROM (
    SELECT wallet_id, prev_hash FROM audit_log GROUP BY 1, 2 HAVING count(*) > 1
  ) d;

  IF broken > 0 THEN
    RAISE WARNING
      'audit_log has % wallet/prev_hash duplicate(s) from before the append lock existed. The '
      'chain is broken for those wallets and cannot be repaired — the trail is append-only by '
      'design. Skipping audit_log_chain_unique; /verify will keep reporting the break, which is '
      'correct. Recreate the index once those rows age out.', broken;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS audit_log_chain_unique ON audit_log (wallet_id, prev_hash);
  END IF;
END $$;
