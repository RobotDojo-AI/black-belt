/**
 * lib/passive-retention.js — bounded retention for the passive job queue.
 *
 * WHY THIS EXISTS. `passive_jobs` had no retention path of any kind. The
 * session-log job types accumulate one `done` row per chat turn and nothing
 * ever removed them: 147,420 rows at ~7.1 KB average payload, ~1.05 GB of
 * payload+metadata, growing 2,711 rows/day with no ceiling. That growth was the
 * fuel behind the maintenance worker's CPU burn (migration 147 fixed the query;
 * this file stops the table that fed it from growing without bound).
 *
 * WHY TWO TIERS RATHER THAN ONE DELETE. `unique_key` is the queue's dedup
 * guard — `session_log_turn:session:<agent>:<threadId>:<contentHash>`. Deleting
 * a row drops that guard, so a replayed turn would re-process. But the *cost*
 * of these rows is almost entirely `payload`, not the row itself. So:
 *
 *   Tier 1 (COMPACT, default 14d): reset the payload to '{}', keep the row.
 *     Reclaims the bytes, keeps the dedup key intact forever. Zero replay risk.
 *   Tier 2 (DELETE, default 90d): remove the row entirely.
 *     Bounds row count. By 90 days a replay of that exact turn is not a real
 *     scenario, and the content hash means a genuine re-send is a different key.
 *
 * Nothing here touches a row that is not `done`, and nothing touches a job type
 * outside the session-log set — routine rows ARE revived via `requeueDone: true`
 * (lib/passive-maintenance-handlers.js) and must never be swept.
 *
 * Chunked with a checkpoint between batches and a wall-clock budget, so an
 * interrupted slice resumes rather than restarts, and a long sweep never holds
 * a single multi-gigabyte transaction open on the encrypted DB.
 */

// Job types safe to sweep. These are per-turn append-only records whose handler
// has already written the real content to the session log; the queue row is
// bookkeeping. Deliberately NOT derived from SESSION_LOG_JOB_TYPES by import —
// this list is the retention contract and must change deliberately.
export const RETENTION_JOB_TYPES = Object.freeze([
  'session_log_turn',
  'session_log_bookmark',
  'session_log_batch',
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function placeholders(n) {
  return new Array(n).fill('?').join(', ');
}

/**
 * Compact tier — reset the payload to '{}' on old `done` session-log rows.
 * Keeps the row and its unique_key, so dedup protection is never lost.
 *
 * NOT NULL: `payload` is `TEXT NOT NULL DEFAULT '{}'` (verified against the live
 * schema), so the empty object is the column's own default and the only legal
 * "no content" value. Nulling it raises SQLITE_CONSTRAINT_NOTNULL.
 *
 * @returns {{scanned:number, compacted:number, bytesFreed:number, partial:boolean, elapsedMs:number}}
 */
export function compactSessionLogPayloads(db, {
  retainDays = Number(process.env.ROBOTDOJO_PASSIVE_COMPACT_DAYS || 14),
  batchSize = Number(process.env.ROBOTDOJO_PASSIVE_RETENTION_BATCH || 2000),
  maxSeconds = Number(process.env.ROBOTDOJO_PASSIVE_RETENTION_MAX_SECONDS || 60),
} = {}) {
  const cutoff = isoDaysAgo(retainDays);
  const types = placeholders(RETENTION_JOB_TYPES.length);
  const started = Date.now();
  const deadline = started + maxSeconds * 1000;

  const select = db.prepare(
    `SELECT id, LENGTH(payload) AS len FROM passive_jobs
      WHERE job_type IN (${types})
        AND status = 'done'
        AND LENGTH(payload) > 2
        AND created_at < ?
      ORDER BY id
      LIMIT ?`,
  );
  const update = db.prepare("UPDATE passive_jobs SET payload = '{}' WHERE id = ?");

  let compacted = 0;
  let bytesFreed = 0;
  let scanned = 0;
  let partial = false;

  for (;;) {
    const rows = select.all(...RETENTION_JOB_TYPES, cutoff, batchSize);
    if (rows.length === 0) break;
    scanned += rows.length;

    const tx = db.transaction((batch) => {
      for (const r of batch) {
        update.run(r.id);
        bytesFreed += r.len || 0;
        compacted += 1;
      }
    });
    tx(rows);

    if (rows.length < batchSize) break;
    if (Date.now() > deadline) { partial = true; break; }
  }

  return { scanned, compacted, bytesFreed, partial, elapsedMs: Date.now() - started };
}

/**
 * Delete tier — remove very old `done` session-log rows entirely.
 * Bounds row count once the dedup window is long past.
 *
 * @returns {{deleted:number, partial:boolean, elapsedMs:number}}
 */
export function pruneSessionLogJobRows(db, {
  retainDays = Number(process.env.ROBOTDOJO_PASSIVE_PRUNE_DAYS || 90),
  batchSize = Number(process.env.ROBOTDOJO_PASSIVE_RETENTION_BATCH || 2000),
  maxSeconds = Number(process.env.ROBOTDOJO_PASSIVE_RETENTION_MAX_SECONDS || 60),
} = {}) {
  const cutoff = isoDaysAgo(retainDays);
  const types = placeholders(RETENTION_JOB_TYPES.length);
  const started = Date.now();
  const deadline = started + maxSeconds * 1000;

  const select = db.prepare(
    `SELECT id FROM passive_jobs
      WHERE job_type IN (${types})
        AND status = 'done'
        AND created_at < ?
      ORDER BY id
      LIMIT ?`,
  );
  const del = db.prepare('DELETE FROM passive_jobs WHERE id = ?');

  let deleted = 0;
  let partial = false;

  for (;;) {
    const rows = select.all(...RETENTION_JOB_TYPES, cutoff, batchSize);
    if (rows.length === 0) break;

    const tx = db.transaction((batch) => {
      for (const r of batch) { del.run(r.id); deleted += 1; }
    });
    tx(rows);

    if (rows.length < batchSize) break;
    if (Date.now() > deadline) { partial = true; break; }
  }

  return { deleted, partial, elapsedMs: Date.now() - started };
}

/**
 * What retention WOULD do, without doing it. Used by the dry-run path and by
 * the health surface so the bound is observable before it bites.
 */
export function describePassiveRetention(db, {
  compactDays = Number(process.env.ROBOTDOJO_PASSIVE_COMPACT_DAYS || 14),
  pruneDays = Number(process.env.ROBOTDOJO_PASSIVE_PRUNE_DAYS || 90),
} = {}) {
  const types = placeholders(RETENTION_JOB_TYPES.length);
  const total = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS bytes
       FROM passive_jobs WHERE job_type IN (${types})`,
  ).get(...RETENTION_JOB_TYPES);
  const compactable = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS bytes
       FROM passive_jobs
      WHERE job_type IN (${types}) AND status = 'done'
        AND LENGTH(payload) > 2 AND created_at < ?`,
  ).get(...RETENTION_JOB_TYPES, isoDaysAgo(compactDays));
  const prunable = db.prepare(
    `SELECT COUNT(*) AS n FROM passive_jobs
      WHERE job_type IN (${types}) AND status = 'done' AND created_at < ?`,
  ).get(...RETENTION_JOB_TYPES, isoDaysAgo(pruneDays));

  return {
    totalRows: total.n,
    totalPayloadBytes: total.bytes,
    compactableRows: compactable.n,
    compactableBytes: compactable.bytes,
    prunableRows: prunable.n,
    compactDays,
    pruneDays,
  };
}
