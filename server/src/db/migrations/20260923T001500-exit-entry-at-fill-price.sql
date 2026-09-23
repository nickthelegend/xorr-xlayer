-- An exit armed from a fill is measured from what that fill paid.
--
-- `armExits` has always meant this ("measured from the FILL price"), but the fill's `price` was the market's mark at
-- the moment the order was sized, not what the units cost. On X Layer mainnet the two agree to the pool fee. On the
-- fork they part by however far the market has moved since the fork block: a METAx buy on 2026-09-22 cost $673.02 a
-- unit and armed its exit at $745.63, the market's price — 10.8% above the position's own cost, and past its own 5%
-- stop the moment the exit was judged on what the sale would be paid.
--
-- `executor/run.ts` now records the fill's own price, so new exits are right. This re-bases the live ones the old
-- code armed. Deliberately narrow:
--   - only live `exit-rules` strategies whose opening fill can be named: a filled buy of the same symbol, in the same
--     wallet and chain, that finished at most two minutes before the exit was created — the exits `armExits` writes
--     immediately after a fill. An exit someone set by hand, later, is not touched;
--   - only where the stored entry is more than 0.5% from what that fill paid, so an entry that was already right (a
--     mainnet fill, or a fork fill made while the fork still matched the market) is left byte-for-byte as it was;
--   - the stop and target stay the percentages the person chose; only the price they are measured from moves.
WITH opening AS (
  SELECT DISTINCT ON (e.id)
         e.id AS exit_id,
         r.usd / r.units AS paid
    FROM strategies e
    JOIN strategies s
      ON s.wallet_id = e.wallet_id
     AND s.symbol = e.symbol
     AND s.chain = e.chain
     AND s.id <> e.id
    JOIN strategy_runs r
      ON r.strategy_id = s.id
   WHERE e.kind = 'exit-rules'
     AND e.state = 'live'
     AND (e.params->>'entryPrice') IS NOT NULL
     AND (e.params->>'entryPrice')::numeric > 0
     AND r.status = 'filled'
     AND r.side = 'buy'
     AND r.units > 0
     AND r.usd > 0
     AND r.finished_at <= e.created_at
     AND r.finished_at >= e.created_at - interval '2 minutes'
   ORDER BY e.id, r.finished_at DESC
)
UPDATE strategies e
   SET params = jsonb_set(e.params, '{entryPrice}', to_jsonb(round(o.paid, 8)))
  FROM opening o
 WHERE e.id = o.exit_id
   AND abs((e.params->>'entryPrice')::numeric / o.paid - 1) > 0.005;
