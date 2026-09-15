-- 096_canonical_versions_regen_source_distill.sql
--
-- Story st_73169c14: /promote was retired and folded into /distill — the single
-- capture mechanism for voice corrections. The distill SKILL writes through
-- canonicalGenesis/canonicalWrite with source 'distill', but the CHECK
-- constraint on canonical_versions.regen_source never learned the value, so
-- every distill write failed with "CHECK constraint failed: regen_source IN".
-- Found by the st_73169c14 QA mechanics round-trip (validate-or-repair).
--
-- Same rebuild pattern as 082: new table with the extended enum, copy rows,
-- swap, recreate indexes. 'promote' stays for historical rows.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS canonical_versions_v4 (
  id              INTEGER PRIMARY KEY,
  doc_path        TEXT NOT NULL,
  content_sha256  TEXT NOT NULL,
  prev_sha256     TEXT,
  content_size    INTEGER NOT NULL,
  regen_source    TEXT NOT NULL,
  class           TEXT NOT NULL,
  score_json      TEXT,
  quality_json    TEXT,
  story_id        TEXT,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(content_sha256) = 64),
  CHECK (content_sha256 = lower(content_sha256)),
  CHECK (content_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (prev_sha256 IS NULL OR length(prev_sha256) = 64),
  CHECK (prev_sha256 IS NULL OR prev_sha256 = lower(prev_sha256)),
  CHECK (prev_sha256 IS NULL OR prev_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (content_size >= 0),
  CHECK (class IN ('human-authored', 'programmatically-generated')),
  CHECK (regen_source IN (
    -- Legacy per-doc compound scripts (deleted by st_ae536261 but historical rows kept)
    'compound-agents', 'compound-architecture', 'compound-claude',
    'compound-companies', 'compound-entity', 'compound-health',
    'compound-kanban', 'compound-people', 'compound-places',
    'compound-sitemap', 'compound-skills', 'compound-structure',
    'compound-topics', 'compound-user', 'compound-voice',
    'generate-architecture', 'generate-sitemap', 'generate-structure',
    'manual', 'promote', 'rollback', 'skill-revert',
    'initial-revert', 'initial-classification', 'test',
    -- st_ae536261: new architecture
    'compound-doc.js',
    'claude.js',
    'memory-append.js',
    'seed-canonical-genesis',
    'vc11-runner',
    'vc5-runner',
    'heartbeat-no-signal',
    'retro-compound',
    'generalize-compound',
    'trigger-dispatcher',
    -- st_73169c14: /promote folded into /distill (single voice-correction capture)
    'distill'
  ))
);

INSERT INTO canonical_versions_v4
  SELECT id, doc_path, content_sha256, prev_sha256, content_size,
         regen_source, class, score_json, quality_json, story_id, created_at
    FROM canonical_versions;

DROP TABLE canonical_versions;
ALTER TABLE canonical_versions_v4 RENAME TO canonical_versions;

CREATE UNIQUE INDEX IF NOT EXISTS canonical_genesis
  ON canonical_versions(doc_path) WHERE prev_sha256 IS NULL;
CREATE INDEX IF NOT EXISTS canonical_versions_doc_path_created
  ON canonical_versions(doc_path, created_at);
CREATE INDEX IF NOT EXISTS canonical_versions_doc_path
  ON canonical_versions(doc_path, id);

PRAGMA foreign_keys = ON;
