-- What a filled run did, and what it was expected to deliver (PLAN.md 2.8, 2.9).
--
-- A sale's proceeds were recorded as the estimate its run started from, and fill quality compared a
-- sale's units with themselves — the delegation moves exactly the units it is told to, so every sale
-- scored zero basis points by construction. A sale is measured by the USDC it paid against the USDC
-- the arrival price implied, and the columns that make that possible did not exist.

ALTER TABLE strategy_runs ADD COLUMN IF NOT EXISTS side text;          -- 'buy' | 'sell' | 'supply'
ALTER TABLE strategy_runs ADD COLUMN IF NOT EXISTS quoted_usd numeric(14,2); -- a sale's arrival value; null when its proceeds were not measured
ALTER TABLE strategy_runs ADD COLUMN IF NOT EXISTS asset_class text;   -- 'crypto' | 'equity'

-- Existing fills, classified once from what was recorded when they happened: a supply by its venue,
-- a sale by the trail entry written in the same transaction as its fill, everything else a buy. None
-- of them gets a `quoted_usd` — no sale before this migration kept one — so old sales count as
-- unmeasured rather than as perfect.
UPDATE strategy_runs SET side = 'supply' WHERE side IS NULL AND status = 'filled' AND venue = 'aave';
UPDATE strategy_runs r SET side = 'sell'
  FROM audit_log a
 WHERE r.side IS NULL AND r.status = 'filled' AND a.payload->>'runId' = r.id AND a.action LIKE 'Sold %';
UPDATE strategy_runs SET side = 'buy' WHERE side IS NULL AND status = 'filled';
UPDATE strategy_runs r
   SET asset_class = CASE WHEN s.symbol IN ('NVDAc','AAPLc','TSLAc','METAc','MSFTc','AMZNc','GOOGLc','MSTRc')
                          THEN 'equity' ELSE 'crypto' END
  FROM strategies s
 WHERE s.id = r.strategy_id AND r.asset_class IS NULL AND r.status = 'filled';
