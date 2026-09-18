-- How much risk the agent may take, per wallet.
--
-- Every threshold the autonomous agent reasons with — trade size, how far into a band a breakout
-- counts, how close to a scheduled split it will go, how long it waits between entries — was a
-- constant in the code. Those are not implementation details; they are the whole of what "careful"
-- or "aggressive" means, and the person whose money it is had no way to say which they wanted.
--
-- Constrained rather than free text, for the same reason `proposals.decision` is: a value the code
-- does not recognise is a row the agent has to guess about, and a CHECK turns that into a write
-- that fails loudly at the moment someone introduces it.
--
-- NOT NULL DEFAULT 'balanced' so every existing wallet has an answer the instant this runs. A
-- nullable column would mean the agent reading NULL and deciding what that meant, in a place where
-- "no preference" and "the careful one" are very different instructions.
ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS risk_profile text NOT NULL DEFAULT 'balanced';

DO $$
BEGIN
  ALTER TABLE wallets
    ADD CONSTRAINT wallets_risk_profile_check
    CHECK (risk_profile IN ('conservative','balanced','aggressive'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
