-- WHY: event_time stores the canonical timestamp of the source event so
-- retrieve.js can apply recency-bucket scoring without a JOIN to the source
-- table. NOT NULL DEFAULT '' is intentional: the backfill script uses
-- WHERE event_time = '' so it re-runs cleanly on any unfilled rows.
-- CLAUDE.md note: NOT NULL DEFAULT '' backfill must use WHERE col='' not IS NULL.
ALTER TABLE chunks ADD COLUMN event_time TEXT NOT NULL DEFAULT '';
