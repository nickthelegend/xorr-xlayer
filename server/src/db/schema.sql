-- xorr executor schema. PLAN.md 12.6 / 12.11.
--
-- Two invariants this schema enforces in the database rather than in code, because code that
-- retries is exactly the code that double-spends:
--   1. strategy_runs.period_key is UNIQUE  -> one run per period, ever. (12.8)
--   2. audit_log.prev_hash chains          -> the trail cannot be edited without detection. (12.11)

CREATE TABLE IF NOT EXISTS wallets (
  id            TEXT PRIMARY KEY,
  -- The verified Privy DID. Every query in the system is scoped by this; without it any caller
  -- could act on any wallet, which is exactly the hole this build closes.
  user_id       TEXT NOT NULL,
  address       TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('embedded','connected')),
  cluster       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallets_user_idx ON wallets(user_id);

-- The delegation IS screen 4's four controls. Trade-only, capped, time-boxed, revocable.
CREATE TABLE IF NOT EXISTS delegations (
  id                  TEXT PRIMARY KEY,
  wallet_id           TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  owner_pubkey        TEXT NOT NULL,
  delegate_pubkey     TEXT NOT NULL,
  daily_cap_usd       NUMERIC(14,2) NOT NULL CHECK (daily_cap_usd > 0),
  expires_at          TIMESTAMPTZ NOT NULL,
  venue_allowlist     TEXT[] NOT NULL DEFAULT '{}',
  withdrawal_allowlist TEXT[] NOT NULL DEFAULT '{}',
  revoked             BOOLEAN NOT NULL DEFAULT false,
  -- The on-chain signature that created or revoked it, so the grant is auditable.
  grant_signature     TEXT,
  revoke_signature    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delegations_wallet_idx ON delegations(wallet_id, revoked);

CREATE TABLE IF NOT EXISTS strategies (
  id                    TEXT PRIMARY KEY,
  wallet_id             TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('draft','watch','live','paused','ended')),
  label                 TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  params                JSONB NOT NULL DEFAULT '{}',
  cadence               TEXT,
  next_run_at           TIMESTAMPTZ,
  daily_allocation_usd  NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- Which state a pause was taken out of, so a resume puts it back there rather than always into
  -- `live`. Migration 031, and `executor/resume.ts` says why null means live.
  paused_from           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategies_due_idx ON strategies(state, next_run_at);

-- 12.8: the unique period_key is what makes a retry safe. A second attempt in the same period
-- is rejected by the database, not by a hopeful `if` in the executor.
CREATE TABLE IF NOT EXISTS strategy_runs (
  id            TEXT PRIMARY KEY,
  strategy_id   TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  period_key    TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL CHECK (status IN ('pending','filled','failed','blocked','skipped')),
  usd           NUMERIC(14,2),
  units         NUMERIC(24,9),
  price         NUMERIC(20,8),
  signature     TEXT,
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS proposals (
  id            TEXT PRIMARY KEY,
  wallet_id     TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  agent         TEXT NOT NULL,
  payload       JSONB NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  decision      TEXT CHECK (decision IN ('approve','skip','expired')),
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 12.11: append-only, one row per action AND per non-action, hash-chained.
CREATE TABLE IF NOT EXISTS audit_log (
  seq           BIGSERIAL PRIMARY KEY,
  wallet_id     TEXT NOT NULL,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent         TEXT NOT NULL,
  action        TEXT NOT NULL,
  detail        TEXT NOT NULL,
  amount        TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL CHECK (kind IN ('trade','risk','block','yield')),
  signature     TEXT,
  payload       JSONB NOT NULL DEFAULT '{}',
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_wallet_idx ON audit_log(wallet_id, seq DESC);

-- Rows are never updated or deleted. Enforced, not merely intended.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- Daily spend, for the rule engine's cap check. One row per wallet per UTC day.
CREATE TABLE IF NOT EXISTS daily_spend (
  wallet_id     TEXT NOT NULL,
  day           DATE NOT NULL,
  spent_usd     NUMERIC(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet_id, day)
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  wallet_id     TEXT NOT NULL,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  author        TEXT NOT NULL,
  type          TEXT NOT NULL,
  agent         TEXT,
  body          JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_wallet_idx ON messages(wallet_id, at);

-- Push device registry — PLAN.md 12.19.
CREATE TABLE IF NOT EXISTS devices (
  token       TEXT PRIMARY KEY,
  wallet_id   TEXT NOT NULL,
  platform    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_wallet_idx ON devices(wallet_id);

-- Positions — built from real fills, not seeded. PLAN.md 12.7.
-- A spot position is an average-cost lot: every fill adds units and moves the average.
CREATE TABLE IF NOT EXISTS positions (
  id            TEXT PRIMARY KEY,
  wallet_id     TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL DEFAULT 'long' CHECK (side IN ('long','short')),
  leverage      NUMERIC(6,2) NOT NULL DEFAULT 1,
  units         NUMERIC(24,9) NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(16,2) NOT NULL DEFAULT 0,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet_id, symbol, side)
);
CREATE INDEX IF NOT EXISTS positions_wallet_idx ON positions(wallet_id);

/*
 * Agents.
 *
 * Hiring an agent used to be a boolean in browser state — it survived a refresh and nothing else.
 * Reinstall the app and your roster was gone, which is an odd property for the thing that is
 * trading your money.
 *
 * An agent is a row: which persona it is, whether it is hired, how it talks, and the limits it
 * runs inside. Strategies point at one, so "fire the laggard" has something to act on.
 */
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  wallet_id     TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  persona_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  hired         BOOLEAN NOT NULL DEFAULT true,
  tone          TEXT NOT NULL DEFAULT 'dry' CHECK (tone IN ('dry','sharp','flat')),
  -- Per-agent limits, always inside the on-chain cap. The contract is still the authority; this
  -- is the user dividing what the contract already allows between the agents they hired.
  risk_limits   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  fired_at      TIMESTAMPTZ,
  -- One row per persona per wallet: hiring twice is the same agent, not two of them.
  UNIQUE (wallet_id, persona_id)
);

CREATE INDEX IF NOT EXISTS agents_wallet_idx ON agents (wallet_id) WHERE hired;

-- Which agent owns a strategy. Nullable: strategies created before agents existed have none, and
-- a strategy whose agent is fired keeps running under the user's own permission rather than
-- vanishing with the agent.
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;

/*
 * Alerts.
 *
 * `app/alerts/new.tsx` built an alert and dropped it, and toggling one POSTed to a route that did
 * not exist and had its 404 swallowed. So the screen looked like it worked and remembered nothing.
 */
CREATE TABLE IF NOT EXISTS alerts (
  id          TEXT PRIMARY KEY,
  wallet_id   TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('price','agent','risk')),
  symbol      TEXT,
  name        TEXT NOT NULL,
  detail      TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  -- The threshold this fires on: { above: 95 } / { below: 60 } / { drawdownPct: 10 }.
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alerts_wallet_idx ON alerts (wallet_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Deployed-agent identities.
--
-- Every other route on this server is behind a verified Privy USER, which is right for
-- everything a person does and wrong for the one thing a person is not doing: the trading
-- loop runs unattended and has no session to present. "Whoever can reach the port" is not an
-- identity; a row here is.
--
-- The token is stored as a **sha256 digest only**, so a database dump is not a set of live
-- credentials. Scopes are narrow on purpose — two deployed workers hold one side of the book
-- each, so a leaked entry key cannot close your stops and a leaked exit key cannot open a
-- position. See `server/src/auth/agentKeys.ts`.
CREATE TABLE IF NOT EXISTS agent_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  -- 'read' | 'trade:open' | 'trade:close' | 'admin'
  scopes       TEXT[] NOT NULL DEFAULT '{}',
  revoked      BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_keys_live_idx ON agent_keys(token_hash) WHERE revoked = false;

-- The order a user puts their own watchlist in (migration 20260917T094120-watchlist-order). The LIST is the executor's
-- (`/market/watchable`); this is the preference applied to it, which is why a symbol that stops
-- being watchable keeps its place here rather than being forgotten.
CREATE TABLE IF NOT EXISTS watchlist_order (
  wallet_id  TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  symbol     TEXT NOT NULL,
  position   INTEGER NOT NULL,
  PRIMARY KEY (wallet_id, symbol)
);
CREATE INDEX IF NOT EXISTS watchlist_order_idx ON watchlist_order(wallet_id, position);
