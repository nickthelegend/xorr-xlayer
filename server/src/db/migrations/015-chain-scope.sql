-- Which chain a ledger row belongs to (PLAN.md 2.6).
--
-- `positions`, `strategies` and `strategy_runs` recorded what was bought, what should run and what
-- ran — but not where. A database that has served more than one chain (every developer's, and any
-- deployment that has been pointed at a fork and back) lists a position on a chain that does not
-- hold it, and schedules a strategy against a chain it was never set up on.
--
-- The chain comes from the session rather than from each statement: the executor's pool sets
-- `xorr.chain_key` in every connection's startup packet (db/index.ts), each column defaults to it,
-- and every wallet-wide or global read filters on it. A write cannot forget its chain, and a read
-- cannot cross one.

ALTER TABLE strategies    ADD COLUMN IF NOT EXISTS chain text;
ALTER TABLE strategy_runs ADD COLUMN IF NOT EXISTS chain text;
ALTER TABLE positions     ADD COLUMN IF NOT EXISTS chain text;

-- Existing rows take the chain of the executor running this migration: each deployed database has
-- served one executor. That is an inference, not a record — a row written under another chain before
-- this column existed cannot be told apart here, and checking listed units against the chain's own
-- balance (PLAN.md 2.7) is what catches one.
UPDATE strategies SET chain = current_setting('xorr.chain_key') WHERE chain IS NULL;
UPDATE strategy_runs r SET chain = s.chain FROM strategies s WHERE s.id = r.strategy_id AND r.chain IS NULL;
UPDATE positions SET chain = current_setting('xorr.chain_key') WHERE chain IS NULL;

ALTER TABLE strategies    ALTER COLUMN chain SET DEFAULT current_setting('xorr.chain_key'), ALTER COLUMN chain SET NOT NULL;
ALTER TABLE strategy_runs ALTER COLUMN chain SET DEFAULT current_setting('xorr.chain_key'), ALTER COLUMN chain SET NOT NULL;
ALTER TABLE positions     ALTER COLUMN chain SET DEFAULT current_setting('xorr.chain_key'), ALTER COLUMN chain SET NOT NULL;

-- A session that does not set the chain itself — a psql prompt, or a new connection from the previous
-- executor while a deploy drains it — gets the database's own: the chain of whoever migrated it.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET xorr.chain_key = %L', current_database(), current_setting('xorr.chain_key'));
END
$$;

-- One position per wallet, symbol and side on EACH chain.
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_wallet_id_symbol_side_key;
CREATE UNIQUE INDEX IF NOT EXISTS positions_wallet_chain_symbol_side_key ON positions (wallet_id, chain, symbol, side);

-- Reads that were scanning: a strategy's filled spend today (executor/run.ts), a wallet's strategies,
-- an agent's strategies when it is fired, and a wallet's proposals newest first.
CREATE INDEX IF NOT EXISTS strategy_runs_strategy_status_finished_idx ON strategy_runs (strategy_id, status, finished_at);
CREATE INDEX IF NOT EXISTS strategies_wallet_chain_idx ON strategies (wallet_id, chain);
CREATE INDEX IF NOT EXISTS strategies_agent_idx ON strategies (agent_id);
CREATE INDEX IF NOT EXISTS proposals_wallet_created_idx ON proposals (wallet_id, created_at);

-- No index on audit_log((payload->>'runId')). The leaderboard was the query that needed one, and it
-- no longer searches the trail (PLAN.md 2.2); an index nothing reads would be paid for on every append.
