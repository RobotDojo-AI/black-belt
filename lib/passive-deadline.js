/**
 * lib/passive-deadline.js — the give-up bound for background jobs.
 *
 * THE PROBLEM. Every benign exit in `runPassiveJob` routes to
 * `requeuePassiveJob`, which never touches `attempts`. So `max_attempts` is
 * structurally unreachable on that path and quarantine is impossible: a job that
 * is blocked, paused, or interrupted retries forever while reporting `queued`.
 * Live proof at the time this was written: `maint_reclassify_chunks` sat at
 * 3,730 reclaims across 3,195 stall turns, attempts 1 of 5, no success since
 * 2026-07-02 — and every health surface called it healthy. `stall_streak` is a
 * throttle (excluded above 3 turns, re-admitted hourly, forever), not a deadline.
 *
 * WHY NOT COUNT ATTEMPTS AT CLAIM TIME. That is the textbook fix (SQS counts
 * receives via `maxReceiveCount`; pg-boss increments inside its fetch statement)
 * and this codebase already tried it. `st_b50005df` Phase 2 removed it on
 * purpose: a job reclaimed after a benign lease expiry — slow slice, idle abort,
 * crash — marched toward `max_attempts` with nothing actually failing. Re-adding
 * it would repeat a settled mistake. `attempts` stays what it is: a count of
 * real handler errors, written only by `failPassiveJob`.
 *
 * WHAT THIS DOES INSTEAD. A second, independent bound on a different axis:
 * wall-clock age since last success. Temporal draws the same distinction —
 * Start-To-Close bounds one execution, Schedule-To-Close bounds the whole
 * lifetime. Repeated interruption is caught by attempts; never-progressing is
 * caught only by age. A design with one has a hole, and 45 days of
 * queued-and-untouched is that hole.
 *
 * THE FIRST-RUN GRACE IS LOAD-BEARING. 44 live jobs were already past a 7-day
 * threshold when this shipped — 40 of them unrelated to the story that surfaced
 * this, including contacts and drive sync across five accounts, Apple Photos,
 * Granola, Notion, and entity enrichment. Quarantining all of them on the first
 * sweep would stop the machine's real work and flood the notification channel
 * the bound depends on being trusted. So the first sweep records an epoch and
 * quarantines nothing; a job is judged against the LATER of its last success and
 * that epoch. Everything gets a full, fresh window before anything gives up.
 *
 * FAILING LOUD IS THE POINT. The standing rule is that a background job may
 * never die silently. A job that gives up here records a reason naming the bound
 * that fired and files an owner-visible task. If the notification cannot be
 * filed, the quarantine reason says so rather than pretending it was sent.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH_KEY = 'passive_deadline_epoch';

/** Job types this bound will never quarantine. */
export const DEADLINE_EXEMPT = Object.freeze([
  // Per-turn session-log records: they complete or they don't, and a stuck one
  // is bounded by retention rather than by give-up.
  'session_log_turn',
  'session_log_bookmark',
  'session_log_batch',
]);

// The epoch lives in `entity_pipeline_state`, the key-value table the ingest
// pipeline already uses for its resume fingerprints. Reusing it avoids inventing
// a second store for one row; the table is created on demand exactly as the
// pipeline creates it.
function ensureStateTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_pipeline_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

function readEpoch(db) {
  try {
    ensureStateTable(db);
    const row = db.prepare('SELECT value FROM entity_pipeline_state WHERE key = ?').get(EPOCH_KEY);
    return row?.value || null;
  } catch {
    return null;
  }
}

function writeEpoch(db, iso) {
  try {
    ensureStateTable(db);
    db.prepare(`
      INSERT INTO entity_pipeline_state (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(EPOCH_KEY, iso);
    return true;
  } catch {
    return false;
  }
}

/**
 * Report what the bound WOULD do, without doing it. The dry-run path and the
 * health surface both use this, so the bound is observable before it bites.
 */
export function describeDeadlineSweep(db, {
  maxStaleDays = Number(process.env.ROBOTDOJO_PASSIVE_MAX_STALE_DAYS || 7),
} = {}) {
  const epoch = readEpoch(db);
  const placeholders = DEADLINE_EXEMPT.map(() => '?').join(', ');
  const cutoff = new Date(Date.now() - maxStaleDays * DAY_MS).toISOString();

  const candidates = db.prepare(`
    SELECT id, unique_key, job_type, status, attempts, max_attempts,
           reclaims, stall_streak, last_success_at, created_at
      FROM passive_jobs
     WHERE status NOT IN ('done', 'quarantined')
       AND job_type NOT IN (${placeholders})
     ORDER BY COALESCE(last_success_at, created_at) ASC
  `).all(...DEADLINE_EXEMPT);

  const overdue = candidates.filter((j) => {
    // The anchor is the LATER of the job's own last success and the epoch, so a
    // job that was already stale when the bound shipped still gets a full window.
    const own = j.last_success_at || j.created_at;
    const anchor = epoch && epoch > own ? epoch : own;
    return anchor < cutoff;
  });

  return {
    epoch,
    epochEstablished: Boolean(epoch),
    maxStaleDays,
    cutoff,
    liveJobs: candidates.length,
    overdue: overdue.length,
    jobs: overdue,
  };
}

/**
 * Run the bound. On the first ever call this only records the epoch and
 * quarantines nothing.
 *
 * @param {object} db
 * @param {{maxStaleDays?:number, apply?:boolean, notify?:(name:string,notes:string)=>Promise<any>}} opts
 * @returns {Promise<{epochJustEstablished:boolean, quarantined:number, notified:number, jobs:object[]}>}
 */
export async function runDeadlineSweep(db, {
  maxStaleDays = Number(process.env.ROBOTDOJO_PASSIVE_MAX_STALE_DAYS || 7),
  apply = false,
  notify = null,
} = {}) {
  const nowIso = new Date().toISOString();

  if (!readEpoch(db)) {
    if (apply) writeEpoch(db, nowIso);
    return {
      epochJustEstablished: true,
      quarantined: 0,
      notified: 0,
      jobs: [],
      note: 'first run — epoch recorded, nothing quarantined. Every live job now has a full window.',
    };
  }

  const plan = describeDeadlineSweep(db, { maxStaleDays });
  if (!apply || plan.overdue === 0) {
    return { epochJustEstablished: false, quarantined: 0, notified: 0, jobs: plan.jobs };
  }

  const quarantine = db.prepare(`
    UPDATE passive_jobs
       SET status = 'quarantined',
           quarantine_reason = ?,
           updated_at = ?
     WHERE id = ? AND status NOT IN ('done', 'quarantined')
  `);

  let quarantined = 0;
  let notified = 0;

  for (const job of plan.jobs) {
    const since = job.last_success_at || `never (created ${job.created_at})`;
    let reason = `deadline: no success since ${since}; bound ${maxStaleDays}d. `
      + `reclaims=${job.reclaims ?? 0} stall_streak=${job.stall_streak ?? 0} `
      + `attempts=${job.attempts ?? 0}/${job.max_attempts ?? '?'}`;

    // Notify BEFORE writing, so the reason can record honestly whether the
    // owner was actually told. A silent give-up is the thing this exists to
    // prevent; claiming a notification that failed would be worse than none.
    if (notify) {
      try {
        await notify(
          `Background job gave up: ${job.unique_key || job.job_type}`,
          `${job.job_type} has not succeeded since ${since}.\n\n${reason}\n\n`
          + 'It has been quarantined rather than left retrying silently. '
          + 'Re-queue it once the underlying blocker is cleared.',
        );
        reason += ' | owner-notified';
        notified += 1;
      } catch (err) {
        reason += ` | notify-failed (${String(err?.message || err).slice(0, 80)})`;
      }
    } else {
      reason += ' | notify-unavailable';
    }

    const r = quarantine.run(reason, nowIso, job.id);
    if (r.changes === 1) quarantined += 1;
  }

  return { epochJustEstablished: false, quarantined, notified, jobs: plan.jobs };
}
