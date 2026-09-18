-- WHICH wallet the app is actually using, recorded rather than guessed.
--
-- A Privy user can have more than one wallet row: web Privy lists any injected browser extension
-- alongside the embedded wallet, so an account that once connected through an extension has both
-- addresses on file. `currentWallet` resolved that with "newest row wins", which is a guess, and
-- on the E2E account it guessed wrong — the app signs in as the embedded wallet created on the
-- 5th while the newest row is a connected one from the 8th.
--
-- The consequence was not cosmetic. Every server-side read of a limit, a policy, a balance or an
-- audit trail ran against a wallet the user was not using: /limits reported a $0 cap and
-- `no_delegation` for an account holding a live $1,600 on-chain grant, and strategy creation was
-- refused on those grounds.
--
-- `/wallet/connect` is the app telling us which address it is on. Stamping it here turns "which
-- wallet" from a heuristic into something the client asserts every session.
--
-- Deliberately NOT `last_seen_at`: that one means "when did the user last read their catch-up",
-- and /catchup subtracts it to decide what is new. Writing it on every app load would make that
-- window empty every time.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS active_at timestamptz;

-- Backfill so ordering is stable before anyone reconnects. `created_at` reproduces exactly the old
-- behaviour, so this migration changes nothing until the app next says which wallet it is using.
UPDATE wallets SET active_at = created_at WHERE active_at IS NULL;
