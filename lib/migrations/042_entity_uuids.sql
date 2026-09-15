-- Add permanent UUIDs to entity tables for deep linking and deduplication.
-- people/companies: id is already UUID format — mirror it into uuid column.
-- places: id is INTEGER — generate fresh UUIDs.
--
-- SQLite does not support ADD COLUMN ... UNIQUE directly.
-- We add columns without constraint, populate, then index.
ALTER TABLE people ADD COLUMN uuid TEXT;
UPDATE people SET uuid = id WHERE uuid IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS people_uuid_unique ON people(uuid);

ALTER TABLE companies ADD COLUMN uuid TEXT;
UPDATE companies SET uuid = id WHERE uuid IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS companies_uuid_unique ON companies(uuid);

ALTER TABLE places ADD COLUMN uuid TEXT;
UPDATE places SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS places_uuid_unique ON places(uuid);
