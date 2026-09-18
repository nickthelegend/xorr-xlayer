-- When the user last looked.
--
-- The product's premise is that the bot works while you are not watching. Nothing recorded when
-- "not watching" started or ended, so the app had no way to answer the one question that premise
-- creates: what happened since I last looked? The activity list answers "what happened ever",
-- which is a different and much less useful thing on the twentieth day.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
