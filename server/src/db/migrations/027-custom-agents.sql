-- Agents a person makes themselves (2026-09-16).
--
-- The roster was the four personas, one row each per wallet. An agent someone makes is a row of its own: its own name and
-- mandate (`role`), and the persona whose voice and way of trading it follows (`style`). `persona_id` stays unique per
-- wallet, so a made agent takes `custom:<its id>` there and can never be merged with another; `style` names one of the
-- four, and is null on the four themselves.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS role text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS style text;

-- A name is how the roster, a conversation and the trail tell one agent from another, so two on one wallet may not share
-- one, whatever their case. The four personas already have distinct names per wallet.
CREATE UNIQUE INDEX IF NOT EXISTS agents_wallet_name_idx ON agents (wallet_id, lower(name));
