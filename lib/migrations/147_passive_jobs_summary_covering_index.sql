-- 147_passive_jobs_summary_covering_index.sql
--
-- df/st_d0e47f5f — the maintenance worker's summary publish was the dominant CPU
-- term on this machine: ~37s of work per loop pass, a sustained ~38% of a core,
-- measured against a live 147k-row passive_jobs table.
--
-- WHY. `getPassiveJobSummary` (lib/passive-jobs.js) runs a detail aggregate:
--
--   SELECT job_type, SUM(retry_count), MAX(last_success_at), MAX(last_failure_at),
--          MIN(CASE WHEN status IN ('queued','paused') THEN run_after END)
--     FROM passive_jobs WHERE queue = ? GROUP BY job_type
--
-- idx_passive_jobs_summary was (queue, job_type, status) — it covers the WHERE
-- and the GROUP BY but NOT the four aggregated columns. SQLite therefore did a
-- rowid lookup into the table for every row. In the table row `payload` is
-- column 7 and `retry_count` is column 12, so reaching the later columns means
-- walking PAST payload through its overflow-page chain — and this database is
-- SQLCipher, so every one of those pages costs an AES decrypt plus an
-- HMAC-SHA512 verify. payload+metadata across the table is ~1.05 GB, roughly
-- 257,000 overflow pages decrypted per call. Warm time equalled cold time
-- because 1.05 GB cannot stay in page cache.
--
-- Measured on the live DB before this migration: 21,439-23,940 ms per call.
-- The sibling count aggregate, which USES a covering index, ran in 34-36 ms.
--
-- WHY NOT scope the call to fewer job types (the st_fd14cdd4 precedent): 99.85%
-- of passive_jobs rows are job_type='session_log_turn', so scoping to the types
-- that matter excludes ~0.15% of the table and changes nothing. Verified: the
-- already-scoped sibling call measured the same ~16-23s. Widening the index is
-- the fix that works, and unlike scoping it also protects future callers.
--
-- The four added columns are exactly the aggregate's payload. With them present
-- the index is covering, SQLite never touches the table row, and no overflow
-- page is decrypted.
--
-- Cost: one extra index over ~147k rows. Writers to passive_jobs pay a slightly
-- wider index update; the read path saves ~21s per call, twice per loop pass.
--
-- NOTE: lib/db.js also recreates this index inside the passive_jobs rebuild
-- block. That definition is updated in lockstep — if it is ever reverted to the
-- narrow column list, a future table rebuild silently restores the slow plan.

DROP INDEX IF EXISTS idx_passive_jobs_summary;

CREATE INDEX IF NOT EXISTS idx_passive_jobs_summary
  ON passive_jobs(queue, job_type, status, retry_count, run_after, last_success_at, last_failure_at);
