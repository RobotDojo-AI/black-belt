-- 004_people_classification.sql
-- Robot Dojo Network ontology alignment (schemas/people.yaml + venues.yaml).
--
-- Adds the business|personal|mixed classification to people and the
-- venue/city distinction to places so the Network sidebar can hide
-- location metadata (cities, countries) from the venue list.
--
-- Note on ALTER TABLE: SQLite cannot conditionally add columns. The
-- migration ledger guarantees this file runs exactly once. We intentionally
-- duplicate the existing `places.venue_type` column-add with an IF-NOT-EXISTS
-- pattern via DROP-and-recreate-guard — but because the earlier migration
-- (`place-venue-type` in lib/db.js) already added that column, we only add
-- what is new here: `hidden_in_sidebar`.

-- People classification (ontology: people.yaml primary_class + subcategory)
ALTER TABLE people ADD COLUMN class TEXT;               -- 'business' | 'personal' | 'mixed' | NULL
ALTER TABLE people ADD COLUMN subcategory TEXT;         -- from people.yaml business/personal subcategory enums
ALTER TABLE people ADD COLUMN class_confidence REAL;    -- 0.0 - 1.0
ALTER TABLE people ADD COLUMN class_sources TEXT;       -- JSON array of signal sources used
ALTER TABLE people ADD COLUMN classified_at TEXT;       -- ISO timestamp of last classification

CREATE INDEX IF NOT EXISTS idx_people_class ON people(class);
CREATE INDEX IF NOT EXISTS idx_people_subcategory ON people(subcategory);

-- Places: venue_type already exists via `place-venue-type` migration.
-- Add a sidebar visibility flag so cities/countries/airports are hidden.
ALTER TABLE places ADD COLUMN hidden_in_sidebar INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_places_hidden ON places(hidden_in_sidebar);

-- Backfill: any existing place typed as a city must never surface in the
-- venue sidebar (ontology invariant: no_cities_as_venues).
UPDATE places SET hidden_in_sidebar = 1
  WHERE place_type = 'city'
     OR venue_type IN ('airport', 'city', 'country', 'region', 'residential');
