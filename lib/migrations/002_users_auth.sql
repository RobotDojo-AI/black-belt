-- Magic-link authentication (Phase A2).
-- Password-less email auth for robotdojo.ai subscribers.
--
-- Tables
--   users         canonical user record (email, slug, subscription, tunnel auth)
--   magic_links   short-lived single-use login tokens (15-minute TTL)
--   sessions      signed session IDs for authenticated cookies (30-day TTL)
--
-- Privacy
--   IPs are never stored raw. `sessions.ip_hash` is SHA-256.
--   `users.encryption_key_hash` is a reference only — the actual key
--   never leaves the user's machine.

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  email                TEXT    UNIQUE NOT NULL,
  user_slug            TEXT    UNIQUE NOT NULL,
  subscription_status  TEXT    NOT NULL DEFAULT 'none',   -- none | black | samurai | cancelled
  encryption_key_hash  TEXT,
  tunnel_token         TEXT,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slug  ON users(user_slug);

CREATE TABLE IF NOT EXISTS magic_links (
  token        TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  redirect_to  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  used_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_magic_links_email   ON magic_links(email);
CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links(expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  user_agent  TEXT,
  ip_hash     TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Per-IP rate limit counters for the magic-link request endpoint.
-- Key is "{ip_hash}:{yyyy-mm-dd-hh}" (hourly bucket).
CREATE TABLE IF NOT EXISTS magic_link_rate (
  key         TEXT PRIMARY KEY,
  ip_hash     TEXT NOT NULL,
  bucket      TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_magic_link_rate_bucket ON magic_link_rate(bucket);
