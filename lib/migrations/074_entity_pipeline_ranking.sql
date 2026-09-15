-- st_93fddaf0 — finalize-entity-pipeline-ranking — Phase 1 schema migration.
--
-- Two new columns on `people` to support categorical pre-sort (service vendor)
-- and Saramäki α/β dormancy detection (relation_phase). One composite index
-- to keep /api/network/people N2-switch queries under the 500ms p95 AC 11
-- budget.
--
-- WHY columns not separate tables: both are single-valued per person and read
-- on every people query. A column is O(1) per row; a join would dominate
-- query time on the 5K-visible-person workload.
--
-- Down migration (manual rollback, not auto-applied):
--   ALTER TABLE people DROP COLUMN service_vendor;
--   ALTER TABLE people DROP COLUMN relation_phase;
--   DROP INDEX IF EXISTS idx_people_service_vendor;
--   DROP INDEX IF EXISTS idx_people_relation_phase;
--   DROP INDEX IF EXISTS idx_people_n1_n2_score;
--
-- Idempotency: SQLite ADD COLUMN errors silently no-op via the migrations
-- runner's try/catch on already-present columns. CREATE INDEX IF NOT EXISTS
-- is unconditionally idempotent.
--
-- Migration number 074: 072 (users_onboarding_stage) and 073 (sessions_cascade)
-- were already taken — checked at planning time, design called 072 but live
-- file ordering required 074.

-- service_vendor: 1 = categorically pre-sorted to Acquaintance regardless of
-- score. Set deterministically by scripts/ingest/03b-service-vendor.js based
-- on display_name keywords + contact-source-only heuristics. 0 = not a service
-- vendor (default).
ALTER TABLE people ADD COLUMN service_vendor INTEGER NOT NULL DEFAULT 0;

-- relation_phase: Saramäki α/β phase classifier. NULL = unassessed; 'active' =
-- recent interactions; 'dormant' = high historical + near-zero recent (cliff);
-- 'service' = service-vendor flagged person; 'lapsed' = reserved for future use.
-- Written by scripts/ingest/05-score.js after N2 assignment.
ALTER TABLE people ADD COLUMN relation_phase TEXT DEFAULT NULL;

-- Partial index: service_vendor=1 is the minority case (~tens of rows). A
-- partial index on the truthy value is small and fast.
CREATE INDEX IF NOT EXISTS idx_people_service_vendor
  ON people(service_vendor) WHERE service_vendor = 1;

-- Partial index: relation_phase IS NOT NULL is also minority. Speeds up the
-- VC6 query and any future "show dormant relationships" surface.
CREATE INDEX IF NOT EXISTS idx_people_relation_phase
  ON people(relation_phase) WHERE relation_phase IS NOT NULL;

-- Composite index: AC 11 budget. /api/network/people N2-switch queries hit
-- WHERE archived=0 AND n1=? AND n2=? ORDER BY score DESC. The composite index
-- makes the filter + order O(log n) on the partitioned set.
CREATE INDEX IF NOT EXISTS idx_people_n1_n2_score
  ON people(n1, n2, score DESC) WHERE archived = 0;

