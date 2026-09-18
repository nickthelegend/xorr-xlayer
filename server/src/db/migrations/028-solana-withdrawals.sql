-- Migration 028: Support Solana base58 addresses in withdrawal allowlist (PLAN.md §7.2, §8.5).
--
-- Relaxes the check constraint on `withdrawal_addresses.address` so it accepts both
-- EVM addresses (0x... 40 hex digits) and Solana base58 public keys (32-44 base58 chars).

ALTER TABLE withdrawal_addresses DROP CONSTRAINT IF EXISTS withdrawal_addresses_address_check;

ALTER TABLE withdrawal_addresses
  ADD CONSTRAINT withdrawal_addresses_address_check
  CHECK (address ~ '^0x[0-9a-fA-F]{40}$' OR address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
