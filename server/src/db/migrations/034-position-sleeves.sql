-- Which strategy opened which part of a position.
--
-- `positions` is UNIQUE on (wallet_id, chain, symbol, side): one row per holding, whatever built
-- it. That is right for "what do I own" and useless for "who did this" — and once several
-- strategies can stack on one symbol, the second question is the one people ask. A recurring buy
-- accumulating NVDAc and a momentum entry on the same token are one row and two decisions.
--
-- A sleeve is one source's share of a holding. Sources are deliberately more than strategies:
-- a limit order, a panic flatten and a manual swap all move units, and attributing those to
-- whichever strategy happened to be running would be an invention.
CREATE TABLE IF NOT EXISTS position_sleeves (
  id           TEXT PRIMARY KEY,
  wallet_id    TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL,
  -- What kind of thing opened it. `strategy` carries a strategies.id in source_id.
  source       TEXT NOT NULL CHECK (source IN ('strategy','agent','basket','limit-order','manual','flatten')),
  -- The specific one, where there is one. Null for sources that have no id of their own.
  source_id    TEXT,
  -- What to call it on screen, captured at fill time.
  --
  -- Stored rather than joined, because a strategy can be renamed or deleted and the sleeve it
  -- opened still happened. A join would make an old fill's attribution change when someone edits a
  -- label, or vanish when they tidy up.
  source_label TEXT NOT NULL DEFAULT '',
  units        NUMERIC(24,9) NOT NULL DEFAULT 0,
  cost_usd     NUMERIC(16,2) NOT NULL DEFAULT 0,
  chain        TEXT NOT NULL DEFAULT current_setting('xorr.chain_key'),
  opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One sleeve per source per symbol. A strategy that buys ten times has one sleeve that grew ten
-- times, not ten sleeves — the same reasoning that makes `positions` one row per holding.
--
-- `coalesce(source_id, '')` because NULL is not equal to NULL in a unique index, so two manual
-- fills with no id of their own would create two rows rather than adding to one.
CREATE UNIQUE INDEX IF NOT EXISTS position_sleeves_key
  ON position_sleeves (wallet_id, chain, symbol, source, coalesce(source_id, ''));
CREATE INDEX IF NOT EXISTS position_sleeves_wallet_idx ON position_sleeves (wallet_id, symbol);
