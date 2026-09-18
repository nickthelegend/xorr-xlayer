-- A stop the executor enforces (PLAN.md 2.14).
--
-- "Stop all agents" was a revoke the user signs, or a flag in one browser's storage. The revoke is the
-- strongest stop there is — it holds even if this server is compromised — and it costs a transaction and a
-- new grant to undo. The flag stopped nothing the executor did. This is the stop in between: instant,
-- free, reversible, and read by every rule check.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS agents_stopped boolean NOT NULL DEFAULT false;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS agents_stopped_at timestamptz;
