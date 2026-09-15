-- 010_person_professional.sql
-- Professional context (title, company, industry, LinkedIn) per person.
-- Populated by lib/person-professional.js using email signatures and
-- domain-based heuristics. NEVER scraped from LinkedIn (ToS).
--
-- One row per person. Extraction is idempotent — upsert by person_id.
CREATE TABLE IF NOT EXISTS person_professional (
  person_id      TEXT PRIMARY KEY,
  title          TEXT,                -- e.g. "CTO", "Head of Product"
  company        TEXT,                -- free-text company name from sig
  company_domain TEXT,                -- primary email domain
  industry       TEXT,                -- inferred category (tech/finance/...)
  tech_signal    REAL DEFAULT 0,      -- 0..1 likelihood of being technical
  linkedin_url   TEXT,                -- from person_identifiers.type='linkedin'
  source         TEXT DEFAULT 'sig',  -- 'sig' | 'domain' | 'manual'
  confidence     REAL DEFAULT 0,      -- 0..1
  sample_email_id TEXT,               -- email used for extraction (debug)
  extracted_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pp_company ON person_professional(company);
CREATE INDEX IF NOT EXISTS idx_pp_domain  ON person_professional(company_domain);
CREATE INDEX IF NOT EXISTS idx_pp_tech    ON person_professional(tech_signal);

-- Referral candidate scores, cached for fast retrieval.
CREATE TABLE IF NOT EXISTS referral_scores (
  person_id            TEXT PRIMARY KEY,
  total_score          REAL NOT NULL DEFAULT 0,
  relationship_score   REAL NOT NULL DEFAULT 0,
  technical_score      REAL NOT NULL DEFAULT 0,
  tool_spend_score     REAL NOT NULL DEFAULT 0,
  privacy_score        REAL NOT NULL DEFAULT 0,
  sharing_score        REAL NOT NULL DEFAULT 0,
  top_signal           TEXT,
  breakdown            TEXT DEFAULT '{}',  -- JSON debug breakdown
  computed_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rs_total ON referral_scores(total_score DESC);
