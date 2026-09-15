-- Base entities — minimal table shells needed before any column-add
-- migrations run. These tables exist in legacy dojo/miyagi.db but must be
-- created from scratch on a new-user install so later migrations don't fail.
--
-- Only the columns required by later migrations are declared here. All
-- further columns are layered in by the JS migrate() calls in lib/db.js and
-- numbered SQL migrations. Everything is IF NOT EXISTS so re-running on a
-- populated DB is a no-op.

-- People — full base schema including the legacy columns referenced by
-- prepared statements in lib/referral.js, lib/network-scoring.js, etc. The
-- JS column-add migrations in lib/db.js are no-ops when the column already
-- exists, so shipping the mature schema up-front is safe.
CREATE TABLE IF NOT EXISTS people (
  id                     TEXT PRIMARY KEY,
  display_name           TEXT NOT NULL,
  short_name             TEXT DEFAULT '',
  company_id             TEXT,
  linkedin_url           TEXT DEFAULT '',
  linkedin_title         TEXT DEFAULT '',
  tier                   TEXT DEFAULT 'acquaintance',
  notes                  TEXT DEFAULT '',
  first_seen             TEXT,
  last_seen              TEXT,
  interaction_count      INTEGER DEFAULT 0,
  verified               INTEGER DEFAULT 0,
  score                  REAL    DEFAULT 0,
  business_score         REAL    DEFAULT 0,
  personal_score         REAL    DEFAULT 0,
  score_details          TEXT    DEFAULT '',
  tier_override          TEXT    DEFAULT NULL,
  personal_tier          TEXT    DEFAULT 'noise',
  business_tier          TEXT    DEFAULT 'noise',
  relation_tag           TEXT    DEFAULT NULL,
  content_depth          REAL    DEFAULT NULL,
  content_depth_samples  INTEGER DEFAULT 0,
  imessage_msg_count     INTEGER DEFAULT 0,
  imessage_group_count   INTEGER DEFAULT 0,
  relationship_origin    TEXT    DEFAULT NULL,
  archived               INTEGER DEFAULT 0,
  display_name_clean     TEXT    DEFAULT NULL,
  consistency_score      REAL    DEFAULT NULL,
  created_at             TEXT    DEFAULT (datetime('now')),
  updated_at             TEXT    DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_people_name      ON people(display_name);
CREATE INDEX IF NOT EXISTS idx_people_company   ON people(company_id);
CREATE INDEX IF NOT EXISTS idx_people_tier      ON people(tier);
CREATE INDEX IF NOT EXISTS idx_people_score     ON people(score);
CREATE INDEX IF NOT EXISTS idx_people_last_seen ON people(last_seen);
CREATE INDEX IF NOT EXISTS idx_people_archived  ON people(archived);

CREATE TABLE IF NOT EXISTS companies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  tier        TEXT DEFAULT 'peripheral',
  industry    TEXT DEFAULT '',
  description TEXT DEFAULT '',
  people_count INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- Person interactions — lib/referral.js + lib/network-scoring.js read from
-- this table. `date` column is the interaction timestamp (legacy column name).
CREATE TABLE IF NOT EXISTS person_interactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   TEXT NOT NULL,
  channel     TEXT NOT NULL,
  direction   TEXT DEFAULT 'unknown',
  date        TEXT NOT NULL,
  source_id   TEXT,
  metadata    TEXT DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pi_person  ON person_interactions(person_id);
CREATE INDEX IF NOT EXISTS idx_pi_channel ON person_interactions(channel);
-- st_f1a40461: composite indexes for the per-person scoring queries (earliest-by-date,
-- channel-filtered) that otherwise force a per-person sort over the interaction set.
CREATE INDEX IF NOT EXISTS idx_pi_person_date      ON person_interactions(person_id, date);
CREATE INDEX IF NOT EXISTS idx_pi_person_chan_date ON person_interactions(person_id, channel, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_source_id ON person_interactions(source_id) WHERE source_id IS NOT NULL;

-- Person identifiers — email, phone, linkedin per person.
CREATE TABLE IF NOT EXISTS person_identifiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  value       TEXT NOT NULL,
  is_primary  INTEGER DEFAULT 0,
  source      TEXT DEFAULT 'unknown',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pid_person ON person_identifiers(person_id);
CREATE INDEX IF NOT EXISTS idx_pid_type_value ON person_identifiers(type, value);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pid_unique_non_name
  ON person_identifiers(type, value)
  WHERE type != 'name';
CREATE UNIQUE INDEX IF NOT EXISTS idx_pid_unique_name_per_person
  ON person_identifiers(person_id, type, value)
  WHERE type = 'name';

-- Person edges — social graph (co-occurrence, mention).
CREATE TABLE IF NOT EXISTS person_edges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_a   TEXT NOT NULL,
  person_b   TEXT NOT NULL,
  edge_type  TEXT NOT NULL DEFAULT 'co_occurrence',
  weight     REAL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(person_a, person_b, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_pe_a ON person_edges(person_a);
CREATE INDEX IF NOT EXISTS idx_pe_b ON person_edges(person_b);

-- Person topics — affinity of a person to a taxonomy topic.
CREATE TABLE IF NOT EXISTS person_topics (
  person_id  TEXT NOT NULL,
  topic      TEXT NOT NULL,
  weight     REAL DEFAULT 1.0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (person_id, topic)
);
CREATE INDEX IF NOT EXISTS idx_pt_topic ON person_topics(topic);

-- Person groups — family/work group membership (used by network-family.js).
CREATE TABLE IF NOT EXISTS person_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  TEXT NOT NULL,
  group_name TEXT NOT NULL,
  group_type TEXT NOT NULL DEFAULT 'other',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(person_id, group_name, group_type)
);
CREATE INDEX IF NOT EXISTS idx_pg_person ON person_groups(person_id);
CREATE INDEX IF NOT EXISTS idx_pg_group  ON person_groups(group_name);

-- Person aliases — alternate names/nicknames for a person.
CREATE TABLE IF NOT EXISTS person_aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  TEXT NOT NULL,
  alias      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(person_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_pa_alias ON person_aliases(alias);

-- Company domains — email domain → company mapping.
CREATE TABLE IF NOT EXISTS company_domains (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  domain     TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cd_company ON company_domains(company_id);

-- Health (Pulse app) — schema lives in 009_health_schema.sql (health_markers,
-- health_groups, health_data_points, curated_medications). Do not declare
-- shells here; earlier drafts shipped columns that diverged from the app code
-- and caused fresh-install 500s on the first GET /api/health/markers.

-- document_vault is owned by lib/document-vault.js (module-scope CREATE with
-- its full schema). Do not create a conflicting shell here.
--
-- extracted_addresses is owned by lib/address-extract.js migration
-- 'extracted-addresses-v1'. Do not create it here.

-- Accounts (integrations/accounts app).
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  email          TEXT,
  display_name   TEXT,
  status         TEXT DEFAULT 'active',
  metadata       TEXT DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Places includes `venue_type` up front because 004_people_classification.sql
-- UPDATEs that column. Later column adds in lib/db.js JS migrations layer
-- on top of this base.
CREATE TABLE IF NOT EXISTS places (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  place_type      TEXT NOT NULL DEFAULT 'venue',
  venue_type      TEXT DEFAULT 'other',
  parent_place_id INTEGER REFERENCES places(id),
  latitude        REAL,
  longitude       REAL,
  address         TEXT,
  frequency       INTEGER DEFAULT 0,
  first_seen      TEXT,
  last_seen       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_places_name       ON places(name);
CREATE INDEX IF NOT EXISTS idx_places_type       ON places(place_type);
CREATE INDEX IF NOT EXISTS idx_places_venue_type ON places(venue_type);

CREATE TABLE IF NOT EXISTS health_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  content    TEXT NOT NULL,
  tags       TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);

-- RAG chunks — required at module import because lib/rag-search.js prepares
-- statements against this table eagerly. No data on fresh install.
CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  topic        TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  chunk_index  INTEGER NOT NULL DEFAULT 0,
  content      TEXT NOT NULL,
  metadata     TEXT NOT NULL DEFAULT '{}',
  token_count  INTEGER NOT NULL DEFAULT 0,
  embedded     INTEGER NOT NULL DEFAULT 0,
  skip_embed   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(topic, source_type, source_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_topic  ON chunks(topic);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_type, source_id);

-- FTS5 virtual table over chunks.content.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id'
);

-- Conversations + messages — referenced by routes/api.js at request time
-- (not eagerly at import), but still part of the base schema.
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'New chat',
  model      TEXT NOT NULL DEFAULT 'claude-haiku',
  tags       TEXT NOT NULL DEFAULT '[]',
  coaching   INTEGER DEFAULT 0,
  archived   INTEGER DEFAULT 0,
  pinned     INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  TEXT NOT NULL,
  role             TEXT NOT NULL,
  content          TEXT NOT NULL,
  seq              INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);

-- Token usage — referenced by /api/usage/* endpoints.
CREATE TABLE IF NOT EXISTS token_usage (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  model        TEXT NOT NULL,
  purpose      TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_token_usage_day   ON token_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(model);
