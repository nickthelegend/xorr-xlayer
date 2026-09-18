-- Units sold with no recorded cost basis.
--
-- It happens for real — a wallet funded outside the app, a position predating the positions table,
-- or a book emptied by the accounting this replaced. The tempting shortcut is to treat the whole
-- sale as profit, which on a trading screen is the most misleading number available. Instead the
-- proceeds are recorded, the realised figure is left alone, and this column is what lets the app
-- say the total is incomplete rather than quietly wrong.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS unbased_units numeric(24,9) NOT NULL DEFAULT 0;

-- Repair rows the old accounting drove negative. Units and cost can never be below zero: the first
-- would be a short and the second is meaningless, and both poison every calculation downstream.
UPDATE positions SET units = 0 WHERE units < 0;
UPDATE positions SET cost_usd = 0 WHERE cost_usd < 0;
UPDATE positions SET units_sold = 0 WHERE units_sold < 0;
