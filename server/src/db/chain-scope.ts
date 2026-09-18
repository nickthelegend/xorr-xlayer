/**
 * The chain this process serves, as SQL (PLAN.md 2.6).
 *
 * The pool sets `xorr.chain_key` on every connection (db/index.ts). Reads of `positions`, `strategies`
 * and `strategy_runs` compare their `chain` column with it, so one database can hold more than one
 * chain's book without a read crossing between them. Its own module so a test that replaces the
 * database module still gets the real clause.
 */
export const THIS_CHAIN = `current_setting('xorr.chain_key')`;
