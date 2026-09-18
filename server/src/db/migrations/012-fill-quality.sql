-- What the router PROMISED, beside what the chain delivered.
--
-- `strategy_runs` recorded `units` — and `units` is overwritten with the MEASURED delta before the
-- row is written, so the quote it was compared against is lost the moment it is checked. The
-- executor already reads the balance either side of the fill precisely so the number a user sees
-- is the chain's rather than the router's; what it could not then say is how far apart those two
-- were, or whether one venue is consistently closer than another.
--
-- That gap matters for the claim this project makes about routing. "Aqua filled this" is a label.
-- "Aqua filled this 4 basis points better than the aggregator quoted, across five fills" is a
-- measurement, and it is the one a judge asks for.
--
-- `venue` is stored rather than parsed. It is currently recovered in `/metrics` with a CASE over
-- the audit action text (`action ILIKE '%Aqua%'`), which works until a sentence is reworded — the
-- settlement path already knows the answer exactly, so it writes it down.
ALTER TABLE strategy_runs ADD COLUMN IF NOT EXISTS quoted_units NUMERIC(24,9);
ALTER TABLE strategy_runs ADD COLUMN IF NOT EXISTS venue TEXT;

-- Deliberately not backfilled. Rows written before this column existed have no quote to recover,
-- and inventing one — from the price, say — would put a fabricated number in the table that the
-- fill-quality figure is computed from. They stay NULL and are excluded from the measurement.
