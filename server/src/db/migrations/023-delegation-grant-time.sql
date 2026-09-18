-- When a grant took effect, and on which chain (PLAN.md 4.7, 4.8).
--
-- `/delegation/record` now reads a grant from its own transaction: the `Granted` event the delegation contract
-- emitted gives the owner, the delegate, the cap and the expiry, and the block that carried it gives the moment it
-- took effect. That moment is `granted_at`. It is what lets "Resume agents" re-grant for as long as the previous grant
-- ran — `expires_at - granted_at` — instead of for a default: the contract keeps the expiry, not the start.
--
-- Rows recorded before this have no `granted_at`, and none is inferred. `created_at` is when the row was written,
-- which trails the block by however long the app took to report it, so a length measured from it would be a guess
-- stored as a record. A resume with nothing on record asks the user to choose.
--
-- `chain`, as in 015-chain-scope.sql and 020-limit-orders.sql. A revoke marked every one of a wallet's rows revoked,
-- whichever chain they were granted on, and a fork of Base shares Base's chain id — so a database that has served more
-- than one chain answered one chain's question with another's grant. Existing rows take the chain of the executor
-- running this migration: the same inference 015 makes, with the same caveat.

ALTER TABLE delegations ADD COLUMN IF NOT EXISTS granted_at timestamptz;
ALTER TABLE delegations ADD COLUMN IF NOT EXISTS chain text;

UPDATE delegations SET chain = current_setting('xorr.chain_key') WHERE chain IS NULL;
ALTER TABLE delegations ALTER COLUMN chain SET DEFAULT current_setting('xorr.chain_key'), ALTER COLUMN chain SET NOT NULL;

-- The record of the grant in force, found by the wallet, the chain and the expiry `/delegation` reads from the contract.
CREATE INDEX IF NOT EXISTS delegations_wallet_chain_expiry_idx ON delegations (wallet_id, chain, expires_at);
