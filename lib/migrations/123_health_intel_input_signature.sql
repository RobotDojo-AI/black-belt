-- Stores the semantic health input fingerprint used to generate each cached
-- health-intel tab. Existing rows keep the empty default and use timestamp
-- freshness until the next regeneration.

ALTER TABLE health_intel ADD COLUMN input_signature TEXT NOT NULL DEFAULT '';
