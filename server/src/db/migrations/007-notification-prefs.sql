-- Which interruptions a user actually wants.
--
-- `send()` has carried a `kind` since it was written and nothing has ever read it, so every push
-- is all-or-nothing: mute the app and you lose the blocked-trade notification along with the
-- routine fills. That is the wrong trade to force — a fill is a nice-to-know and "your cap
-- stopped a trade" is the moment the safety layer did its job.
--
-- Absent means ON. A missing row must never mean silence: a user who has never opened settings
-- expects the bot to tell them things, and defaulting to muted would make the feature look broken
-- for everyone who has not configured it.
CREATE TABLE IF NOT EXISTS notification_prefs (
  wallet_id text NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  kind      text NOT NULL,
  enabled   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (wallet_id, kind)
);
