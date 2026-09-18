-- A business treasury: a company's wallet that the bot trades inside limits an operator sets (PLAN.md 4.14).
--
-- The wallet is a Privy server wallet owned by this deployment's key quorum, with the deployment's policy attached: it may
-- approve the delegation, grant this executor's key and revoke, and Privy refuses anything else before a signature
-- exists. It is registered in `wallets` like any other owner, so the delegation, the runs and the audit trail treat it as
-- the owner it is on-chain; `kind` gains 'treasury' for it.
--
-- Its `wallets.user_id` is not the operator's DID. `currentWallet` answers "which wallet is this person on" from that
-- column, and a treasury filed under the operator could become the wallet their own screens read and trade. The operator
-- is recorded here instead, and every treasury route reads them from here.
--
-- One treasury per operator per chain. `chain` defaults to the session's, as in 015-chain-scope.sql: a fork's treasury is
-- not Base Sepolia's.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'wallets'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE wallets DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE wallets ADD CONSTRAINT wallets_kind_check CHECK (kind IN ('embedded', 'connected', 'treasury'));

CREATE TABLE IF NOT EXISTS business_treasuries (
  id               text PRIMARY KEY,
  chain            text NOT NULL DEFAULT current_setting('xorr.chain_key'),
  -- The signed-in person who set it up, and the only one who can act on it: a Privy DID.
  operator_user_id text NOT NULL,
  wallet_id        text NOT NULL UNIQUE REFERENCES wallets(id) ON DELETE CASCADE,
  -- Privy's id for the server wallet: what every signing request names.
  privy_wallet_id  text NOT NULL UNIQUE,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The operator's treasury on this chain, and the rule that there is one.
CREATE UNIQUE INDEX IF NOT EXISTS business_treasuries_operator_chain_idx ON business_treasuries (operator_user_id, chain);
