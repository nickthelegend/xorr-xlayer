-- An ended strategy has no next run (docs/qa/ENDPOINTS.md E171).
--
-- Ending a strategy clears `next_run_at` in the statement that ends it (`moveStrategy`, routes/strategies.ts), and
-- strategies ended before it did kept the date they would otherwise have run next. The scheduler never picks one up —
-- it reads only `live` and `watch` — but `GET /strategies` published the date, so seventeen ended strategies on the fork
-- still said when they would run. The route no longer publishes it for an ended row; this clears the rows themselves.
--
-- Every chain's rows, deliberately: an ended strategy has no next run on any chain.
UPDATE strategies SET next_run_at = NULL WHERE state = 'ended' AND next_run_at IS NOT NULL;
