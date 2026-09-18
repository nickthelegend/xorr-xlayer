-- Idempotency keys for state-changing requests.
--
-- `strategy_runs.period_key` already proves the pattern works and is the reason a retried or raced
-- strategy run cannot double-spend: the check IS the write, so there is no window between deciding
-- and acting. Nothing else had it. A double-tapped approve, a client retry after a timeout, or a
-- flaky mobile connection resending a grant were all free to happen twice.
--
-- The primary key is (user_id, key) rather than key alone: keys are chosen by clients, and one
-- client's UUID must never be able to collide with — or read back — another's response.
CREATE TABLE IF NOT EXISTS idempotency (
  user_id     text NOT NULL,
  key         text NOT NULL,
  method      text NOT NULL,
  path        text NOT NULL,
  -- Null until the handler finishes. A row with a null status is a request IN FLIGHT, which is
  -- what lets a concurrent duplicate be refused rather than run alongside the original.
  status      integer,
  body        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Replayable responses are not meant to be kept forever; this is what a sweep would use.
CREATE INDEX IF NOT EXISTS idempotency_created_idx ON idempotency (created_at);
