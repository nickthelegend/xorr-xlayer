-- Which venue settled the fills recorded before a run kept its venue (PLAN.md 2.9).
--
-- `fillsByVenue` now counts `strategy_runs.venue`, and fills from before migration 012 have none: the fork
-- read 36 of its fills as "unrecorded". The trail entry written in the same transaction as each of those
-- fills names where it settled, in the wording the old count parsed on every request. It is read here
-- once, for those rows, and never again at query time.
UPDATE strategy_runs r
   SET venue = CASE
         WHEN a.action LIKE '%Aqua book%' THEN 'aqua'
         WHEN a.action LIKE '%SwapVM program%' THEN 'swapvm'
         WHEN a.action LIKE 'Supplied%' THEN 'aave'
         ELSE '1inch'
       END
  FROM audit_log a
 WHERE r.venue IS NULL
   AND r.status = 'filled'
   AND a.payload->>'runId' = r.id
   AND (a.action LIKE 'Bought %' OR a.action LIKE 'Sold %' OR a.action LIKE 'Supplied %');
