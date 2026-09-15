-- st_entity_quality_humans_only (2026-06-26)
--
-- Chat entity search is a fuzzy recognition path, not the identity resolver.
-- It should search actual human-looking people only. The resolver still stores
-- every email/phone identifier, but fuzzy chat recognition must not inject
-- service vendors or raw email-address rows as "people".
--
-- CONTRACT: this WHERE clause must stay byte-identical (modulo whitespace) to
-- MEANINGFUL_PERSON_PREDICATE in lib/network-queries.js because the query pins
-- idx_people_searchable_name with INDEXED BY.
DROP INDEX IF EXISTS idx_people_searchable_name;

CREATE INDEX IF NOT EXISTS idx_people_searchable_name
  ON people(display_name COLLATE NOCASE)
  WHERE archived = 0
    AND COALESCE(service_vendor, 0) = 0
    AND display_name NOT LIKE '%@%'
    AND (
         (personal_tier IS NOT NULL AND personal_tier != 'noise')
      OR (business_tier IS NOT NULL AND business_tier != 'noise')
    );
