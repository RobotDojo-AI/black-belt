-- Migration 037: Remove owner-specific T2 rows + add accounts.label
--
-- Background: migrations 024/025/031 previously seeded owner-specific T2 topic
-- rows directly into user_topics. Those rows are now driven entirely by
-- ~/.robotdojo/taxonomy.user.json via syncTaxonomyToDb() on every boot.
--
-- This migration:
--   1. Deletes all T2 rows that were seeded by migrations 024/025/031.
--      syncTaxonomyToDb() re-inserts the owner's topics from taxonomy.user.json
--      on the next boot, so the dev DB converges to the correct state.
--      Fresh installs (open-source) start with zero T2 rows — correct by design.
--   2. Adds accounts.label (TEXT, nullable) for personal/business/newsletter
--      classification, replacing the hardcoded UUID sets in document-vault.js.

-- 1. Remove owner-specific T2 rows seeded by prior migrations.
--    Only T2 rows are deleted (parent_slug IS NOT NULL) — T1 group headers stay.
DELETE FROM user_topics WHERE parent_slug IS NOT NULL;

-- 2. Add label column to accounts for document vault classification.
--    NULL = use domain heuristic fallback (gmail/icloud → personal, else business).
ALTER TABLE accounts ADD COLUMN label TEXT;
