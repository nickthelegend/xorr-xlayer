-- Where a wallet's funds may be withdrawn to, and from when (PLAN.md 4.9).
--
-- The allowlist lived on the phone: AsyncStorage held each address with the moment it was added, and the phone's own
-- clock decided whether 24 hours had passed. The cooling-off exists to stop a stolen, unlocked phone from adding an
-- address and draining the wallet in one session — and that phone's clock is the one part of the picture its thief
-- controls. Here both halves of the decision belong to the database: `usable_at` is written as `now()` plus the
-- cooling-off when the row is inserted, and every check compares it with `now()` again. No client clock is consulted.
--
-- A removal is a timestamp rather than a deleted row, so the book keeps which address was usable when — the question
-- worth being able to answer after a transfer — and re-adding an address is a new row with a new cooling-off, never
-- the old row brought back. The unique index covers live rows only, which is what lets that happen.
--
-- `chain` defaults to the session's, as in 015-chain-scope.sql, and every read filters on it: an address allowlisted
-- against a fork is not an address allowlisted on Base, although the two share a chain id.
CREATE TABLE IF NOT EXISTS withdrawal_addresses (
  id          text PRIMARY KEY,
  wallet_id   text NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  chain       text NOT NULL DEFAULT current_setting('xorr.chain_key'),
  -- EIP-55, as `getAddress` spells it. Compared lowercased, so a second spelling is still the same address.
  address     text NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  added_at    timestamptz NOT NULL DEFAULT now(),
  usable_at   timestamptz NOT NULL,
  removed_at  timestamptz,
  CHECK (usable_at >= added_at),
  CHECK (removed_at IS NULL OR removed_at >= added_at)
);

-- One live entry per address, per wallet, per chain. Removed rows stay, and do not count.
CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_addresses_live_key
  ON withdrawal_addresses (wallet_id, chain, lower(address)) WHERE removed_at IS NULL;

-- The list: this wallet's addresses on this chain, oldest first.
CREATE INDEX IF NOT EXISTS withdrawal_addresses_wallet_chain_added_idx
  ON withdrawal_addresses (wallet_id, chain, added_at);
