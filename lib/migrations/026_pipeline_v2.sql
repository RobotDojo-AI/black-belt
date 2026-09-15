-- Migration 026: Pipeline v2 — entity_candidates, resolve_audit, archived_entities
-- Plus N1/N2 taxonomy columns on people, companies, places.
-- Written 2026-04-22 by Katagami for entity pipeline rebuild.

-- Intermediate staging: Extract writes here, Resolve reads here
CREATE TABLE IF NOT EXISTS entity_candidates (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,           -- 'contacts'|'calendar'|'imessage'|'email'
  source_rank INTEGER NOT NULL,   -- 1=contacts,2=calendar,3=imessage,4=email
  candidate_type TEXT NOT NULL DEFAULT 'person', -- 'person'|'venue'
  raw_name TEXT,
  raw_email TEXT,
  raw_phone TEXT,
  raw_location TEXT,              -- for venue candidates
  excluded INTEGER DEFAULT 0,
  exclude_reason TEXT,
  resolved_id TEXT,               -- set after Phase 2 resolve
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ec_source ON entity_candidates(source, excluded);
CREATE INDEX IF NOT EXISTS idx_ec_type ON entity_candidates(candidate_type, excluded);

-- Audit log: one row per resolution decision
CREATE TABLE IF NOT EXISTS resolve_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT,
  entity_type TEXT NOT NULL DEFAULT 'person',
  decision TEXT NOT NULL,         -- 'link'|'create'|'discard'
  guard TEXT,                     -- '1-email'|'2-phone'|null
  confidence REAL,
  evidence TEXT,                  -- email or phone value that fired
  source TEXT,
  person_id TEXT,                 -- resolved person_id (if link or create)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ra_decision ON resolve_audit(decision);
CREATE INDEX IF NOT EXISTS idx_ra_person ON resolve_audit(person_id);

-- Archive: non-entities and low-signal entities removed from active graph
CREATE TABLE IF NOT EXISTS archived_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL DEFAULT 'person',
  raw_name TEXT,
  raw_email TEXT,
  source TEXT,
  archive_reason TEXT NOT NULL,
  archived_at TEXT DEFAULT (datetime('now'))
);

-- N1/N2 taxonomy on people (Personal|Professional, Family|Core|Network|Acquaintance|Extended|Partner)
ALTER TABLE people ADD COLUMN n1 TEXT;
ALTER TABLE people ADD COLUMN n2 TEXT;
ALTER TABLE people ADD COLUMN context_file_path TEXT;

-- N1/N2 on companies (always Company, Employer|Client|Partner|Network|Extended)
ALTER TABLE companies ADD COLUMN n1 TEXT DEFAULT 'Company';
ALTER TABLE companies ADD COLUMN n2 TEXT;

-- N1/N2 on places (always Venue, City|Venue)
ALTER TABLE places ADD COLUMN n1 TEXT DEFAULT 'Venue';
ALTER TABLE places ADD COLUMN n2 TEXT;

CREATE INDEX IF NOT EXISTS idx_people_n1 ON people(n1);
CREATE INDEX IF NOT EXISTS idx_people_n2 ON people(n2);
CREATE INDEX IF NOT EXISTS idx_companies_n2 ON companies(n2);
CREATE INDEX IF NOT EXISTS idx_places_n2 ON places(n2);
