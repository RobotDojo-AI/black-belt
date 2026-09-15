-- st_fd14cdd4 — bound chat entity search/recognition to MEANINGFUL people.
--
-- THE PROBLEM (measured live): the chat inline-recognition + entity-span lookup
-- (lib/chat-context.js → searchMeaningfulEntities) resolves a typed name with a
-- `display_name LIKE '% word%'` branch. The leading wildcard is UN-INDEXABLE,
-- so SQLite falls back through idx_people_archived to a SCAN of every
-- non-archived person. On the live DB that is ~341,670 rows, of which 340,015
-- (99.5%) are tier='acquaintance' — email-backfill noise that is never the
-- entity a user means. Measured cost: ~0.45–1.3 s per span warm, spiking to ~5 s
-- under writer load. This is a RECURRENCE: st_f1a40461 fixed recognition
-- CORRECTNESS, but the unbounded scan resurfaced as the table grew. A bounded
-- candidate set is the PERMANENT fix — it never degrades again as acquaintance
-- noise accumulates, because acquaintance noise is excluded from the search set.
--
-- THE MEANINGFUL-ENTITY PREDICATE (owner directive: "keep the database complete
-- but eliminate the noise from the practical product consideration — cap what
-- gets actually searched"):
--
--   archived = 0 AND (
--        tier IN ('core','network')        -- curated relationship tiers (1,655)
--     OR context_file_path IS NOT NULL     -- has a generated context file (15,821)
--     OR interaction_count >= 2            -- real two-way comms history (9,811)
--     OR score >= 10                       -- high relationship score (31)
--   )
--
-- On the live DB this set is 15,821 rows — within the ~16–20k meaningful target
-- and a 21x reduction from 341,670. The four OR-terms are deliberately a UNION
-- of independent "this is a real person, not an email address" signals so the
-- set stays robust: a regen that clears context_file_path still leaves the
-- tier / interaction / score signals carrying the meaningful set. The FULL DB is
-- untouched — this caps SEARCH/MATCH scope, not storage. Every person row still
-- exists, syncs, and is reachable by direct id/uuid lookup; only the fuzzy
-- name-match candidate pool is bounded.
--
-- THE INDEX: a PARTIAL index over exactly that predicate, keyed on
-- display_name COLLATE NOCASE. Because the index materializes ONLY the ~16k
-- meaningful rows, the un-indexable `% word%` word-start branch degrades to a
-- scan of 16k index entries (cheap) instead of 341k table rows, and the
-- `word%` prefix branch becomes a true range SEARCH. The chat query pins this
-- plan with `INDEXED BY idx_people_searchable_name` (its WHERE clause textually
-- matches this predicate, which SQLite requires to honor the partial index).
-- Measured AFTER: ~0.4 ms per span lookup (was ~416 ms) — a ~1000x reduction,
-- sub-100ms even cold.
--
-- BUILD COST: IF NOT EXISTS makes this idempotent. On a fresh install the people
-- table is small and this builds instantly. On a large pre-existing DB the
-- one-time build is ~15 s (measured on the live 13 GB DB) — a single write-lock
-- paid once at first boot after deploy, then never again.
CREATE INDEX IF NOT EXISTS idx_people_searchable_name
  ON people(display_name COLLATE NOCASE)
  WHERE archived = 0 AND (
       tier IN ('core','network')
    OR context_file_path IS NOT NULL
    OR interaction_count >= 2
    OR score >= 10
  );
