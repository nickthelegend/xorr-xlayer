-- A supply to Aave was recorded as a 1inch fill.
--
-- `chooseSettlement` named every leg that was not Aqua or SwapVM `1inch`, including a direct leg
-- that calls the Aave pool and touches no router at all. The first Earn deposit on the rebuilt
-- fork (2026-09-11) was the first such row with a quote beside it, and `/metrics` then reported
-- "1inch: 1 fill, 0 bps" — a perfect aggregator fill that never happened.
--
-- The settlement path now writes `aave`. This corrects the rows already written, and only those:
-- `yield-rotation` is the one kind whose planner emits a direct leg, and every leg it emits is a
-- supply. Nothing is invented — the venue is a fact about the call that was made, recoverable
-- exactly from which planner made it. `audit_log` is not touched, and did not need to be: its
-- sentence for these rows already said "Supplied … to Aave".
UPDATE strategy_runs r
   SET venue = 'aave'
  FROM strategies s
 WHERE r.strategy_id = s.id
   AND s.kind = 'yield-rotation'
   AND r.venue = '1inch';
