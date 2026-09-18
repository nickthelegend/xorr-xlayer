-- Corporate actions we have told a holder about (PLAN.md §8.4).
--
-- The schedule itself is not stored: it is the mint's own pending Scaled UI multiplier, read
-- on-chain. This table exists only to remember who has already been told, so a sweep running every
-- thirty seconds does not send the same split warning every thirty seconds — the fastest way to
-- make someone turn off notifications and lose the ones that matter.
--
-- Keyed on the action itself (mint, the multiplier it moves to, and when it takes effect) rather
-- than on a timestamp, so an issuer amending an announced action — a different ratio, or a new
-- date — is a different row and is announced again. That is the correct behaviour: an amendment is
-- news.
CREATE TABLE IF NOT EXISTS corporate_action_notices (
  id             BIGSERIAL PRIMARY KEY,
  wallet_id      TEXT        NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  mint           TEXT        NOT NULL,
  symbol         TEXT        NOT NULL,
  new_multiplier NUMERIC     NOT NULL,
  effective_at   TIMESTAMPTZ NOT NULL,
  notified_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet_id, mint, new_multiplier, effective_at)
);

CREATE INDEX IF NOT EXISTS corporate_action_notices_wallet
  ON corporate_action_notices (wallet_id, notified_at DESC);
