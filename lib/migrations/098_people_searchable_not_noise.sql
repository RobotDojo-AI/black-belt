-- st_fd14cdd4 (2026-06-13) — redefine the chat entity-search candidate set as
-- "everyone EXCEPT noise", replacing the 097 signal-union definition.
--
-- WHY THE REDEFINITION (owner directive): the bounded chat search set should be
-- explicit — include every real relationship, exclude only noise. The classifier
-- writes a relationship tier into BOTH `personal_tier` and `business_tier` (each
-- one of {core, network, acquaintance, noise}); the bare `tier` column has no
-- noise bucket and is the wrong signal. A person is MEANINGFUL when either
-- dimension is set and not 'noise'. This INCLUDES acquaintance (a real, if light,
-- relationship) — the prior 097 union excluded plain acquaintances. On the live
-- DB the new set is 15,822 rows (vs 384,854 active), the same magnitude as 097's
-- 15,821, so the index seek stays exactly as fast — this is a cleaner definition,
-- not a perf change.
--
-- WHY A NEW MIGRATION, NOT AN EDIT TO 097: 097 already ran on the live DB and is
-- recorded in the migrations table, so editing it in place would never re-run.
-- This file DROPs the 097-built index and rebuilds it over the new predicate.
-- DROP IF EXISTS + CREATE IF NOT EXISTS make it idempotent and safe on a fresh
-- install (where 097 ran moments earlier in the same boot) and on the live DB
-- (where 097's index already exists). The rebuild materializes ONLY the ~16k
-- meaningful rows, so the un-indexable `% word%` word-start branch degrades to a
-- scan of 16k index entries instead of the ~385k active table, and the `word%`
-- prefix branch is a true range SEARCH.
--
-- CONTRACT (load-bearing): this WHERE clause MUST stay byte-identical (modulo
-- whitespace) to MEANINGFUL_PERSON_PREDICATE in lib/network-queries.js. The chat
-- query pins this plan with `INDEXED BY idx_people_searchable_name`; SQLite only
-- honors that when the query WHERE textually implies the index WHERE. Any drift
-- silently turns the index seek back into a full-table scan.
--
-- BUILD COST: the partial set is ~16k rows, so the rebuild is sub-second even on
-- the live 13 GB DB — a single write-lock paid once at first boot after deploy.
DROP INDEX IF EXISTS idx_people_searchable_name;

CREATE INDEX IF NOT EXISTS idx_people_searchable_name
  ON people(display_name COLLATE NOCASE)
  WHERE archived = 0 AND (
       (personal_tier IS NOT NULL AND personal_tier != 'noise')
    OR (business_tier IS NOT NULL AND business_tier != 'noise')
  );
