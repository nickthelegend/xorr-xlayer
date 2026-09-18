-- Which state a strategy was paused out of, so resuming it puts it back there.
--
-- `POST /strategies/:id/resume` moved every paused row to `live`. A strategy in `watch` — the state
-- whose entire purpose is to record what it WOULD do and move nothing — therefore came back from a
-- pause able to spend the user's money. Nobody asked for that, nothing announced it, and the row
-- reads identically in the list either way.
--
-- Nullable, and null means `live` (see `executor/resume.ts`): that is what a resume did when these
-- rows were written, and quietly demoting someone's live strategy to watch would be its own surprise.
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS paused_from TEXT;

-- Rows paused by firing an agent (`agents/routes.ts`) were all live — that route only pauses what is
-- running — so the honest backfill is exactly the default, and there is deliberately nothing to write.
