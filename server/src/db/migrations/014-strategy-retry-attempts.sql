-- A strategy that cannot reach the chain retries with backoff, and says so once.
--
-- A run that failed transiently — an RPC timeout, a 429 — releases its period so it can be tried
-- again (PLAN.md 1.6). It was tried again on the next tick, thirty seconds later, every time, and
-- each attempt wrote its own "Retrying" row: an hour of RPC trouble was a hundred and twenty
-- identical rows per strategy in an append-only trail. `retry_attempts` counts the streak, so the
-- wait can grow and the trail can record the first attempt and not the rest. A run that reaches any
-- answer — filled, nothing to do, blocked, failed for good — resets it.
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS retry_attempts INTEGER NOT NULL DEFAULT 0;
