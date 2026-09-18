-- Small facts the executor learns once and must not forget on restart.
--
-- The first is the Privy policy id. Privy mints one when the policy is created and there is no
-- way to look it up afterwards: `GET /v1/policies` answers 405 — the API creates, reads by id and
-- patches, and does not list. So an executor that keeps the id in memory creates a fresh,
-- duplicate policy on every deploy, and the wallets keep pointing at the first one, which nothing
-- will ever update again.
--
-- A file would not do either: the container is rebuilt on every deploy, which is exactly how the
-- delegate key came to be regenerated and every existing grant left naming a key nobody held.
-- Same class of bug, so the same answer — put it in the database that outlives the process.
--
-- Deliberately a key/value table rather than a column somewhere: this is deployment-scoped
-- configuration the executor discovers at runtime, not a property of a user, a wallet or a
-- strategy, and giving it a row in one of those would be a lie about what owns it.
CREATE TABLE IF NOT EXISTS app_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
