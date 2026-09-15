-- Account preferences + lifecycle tables.
--
-- Backs the /account surface: release channel toggle, telemetry opt-ins,
-- Samurai waitlist, per-app beta opt-ins, feature requests, and a shared
-- audit log for deletion / admin actions.
--
-- Also extends subscriptions with a `perpetual` flag so admins can mint
-- unbilled Black/Samurai keys without creating a Stripe/USDC invoice row.
--
-- Privacy:
--   - We store the current user's account_id as the owning key on every
--     table; no other user can read these rows. All reads are scoped
--     through the session-authed routes in routes/account-prefs.js.

-- --- Preferences -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS account_preferences (
  account_id                      INTEGER PRIMARY KEY,
  auto_update                     INTEGER NOT NULL DEFAULT 1,
  release_channel                 TEXT    NOT NULL DEFAULT 'stable', -- 'stable' | 'beta'
  telemetry_usage                 INTEGER NOT NULL DEFAULT 0,
  telemetry_error_reporting       INTEGER NOT NULL DEFAULT 0,
  telemetry_include_screenshots   INTEGER NOT NULL DEFAULT 0,
  telemetry_include_chat_sessions INTEGER NOT NULL DEFAULT 0,
  updated_at                      TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES users(id)
);

-- --- Samurai waitlist ------------------------------------------------------

CREATE TABLE IF NOT EXISTS samurai_waitlist (
  account_id  INTEGER PRIMARY KEY,
  joined_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES users(id)
);

-- --- Beta opt-ins (per user, per app) --------------------------------------

CREATE TABLE IF NOT EXISTS beta_opt_ins (
  account_id  INTEGER NOT NULL,
  app         TEXT    NOT NULL,                 -- 'pulse' | 'finance' | 'samurai'
  opted_in    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, app),
  FOREIGN KEY (account_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_beta_opt_ins_account ON beta_opt_ins(account_id);

-- --- Feature requests ------------------------------------------------------

CREATE TABLE IF NOT EXISTS feature_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL,
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  submitted_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_feature_requests_account ON feature_requests(account_id, submitted_at DESC);

-- --- Audit log (deletion + admin issuance) ---------------------------------

CREATE TABLE IF NOT EXISTS account_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER,                           -- nullable: admin actions may target
                                                 -- an email that has no user row yet
  action      TEXT    NOT NULL,                  -- 'delete_data' | 'delete_model' |
                                                 -- 'delete_subscription' | 'delete_full' |
                                                 -- 'issue_perpetual_key' | ...
  metadata    TEXT    NOT NULL DEFAULT '{}',     -- JSON; shape is action-specific
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_account_audit_account ON account_audit_log(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_audit_action  ON account_audit_log(action, created_at DESC);

-- --- Subscriptions: perpetual flag -----------------------------------------
-- Admin-issued unbilled keys. status='active', perpetual=1, no stripe/usdc ids.

ALTER TABLE subscriptions ADD COLUMN perpetual INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_subscriptions_perpetual ON subscriptions(perpetual);
