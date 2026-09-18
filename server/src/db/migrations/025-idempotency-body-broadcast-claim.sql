-- An Idempotency-Key that cannot act twice (http/idempotency.ts).
--
-- `request_hash` is the SHA-256 of the request's raw body, kept with the claim. A key matched on method and path alone,
-- so the same key with a different body replayed the first answer: a key kept past its answer returned this morning's
-- fill for this afternoon's order. A different body under the same key is refused now. Rows written before this have
-- none, and are still matched on method and path.
--
-- `broadcast_at` is when the request first put a transaction on a chain, written before the send (`markBroadcast`). Every
-- 5xx released the key so a retry would genuinely retry, and a close that broadcast and then answered 502 because its
-- receipt was late ran again on the retry. A 5xx after a broadcast is kept now, and a claim that died after one is
-- answered as possibly done and never run again.
--
-- `claim_id` is which attempt holds the key. A claim still unanswered after five minutes is abandoned, and one that sent
-- nothing is taken over by the next attempt; the attempt that lost it finds its id gone, and neither sends nor stores
-- nor releases anything under it. Null on rows from before this, which no running process holds.
--
-- No index: every read and write here is by the primary key.
ALTER TABLE idempotency ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE idempotency ADD COLUMN IF NOT EXISTS broadcast_at timestamptz;
ALTER TABLE idempotency ADD COLUMN IF NOT EXISTS claim_id text;
