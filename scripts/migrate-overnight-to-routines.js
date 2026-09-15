#!/usr/bin/env node
/**
 * scripts/migrate-overnight-to-routines.js — st_fd14cdd4 AC8 one-time cleanup.
 *
 * The overnight batch concept is deleted; this script migrates the LIVE
 * passive_jobs queue to the always-on routine reality. Run ONCE from
 * ~/robotdojo after the story merges (deploy runbook step). Idempotent —
 * a re-run finds nothing to do and prints zeros.
 *
 * What it does, in order:
 *   1. DELETES queued nightly_* rows. They are seeds for handlers that no
 *      longer exist (the routine probe seeds the maint_ and pipeline_ types
 *      within one tick); left alone they would quarantine on "no handler"
 *      and rot in the ledger. Done/failed rows stay — history is history.
 *   2. DELETES quarantined rows of the retired nightly_* types. The embed
 *      seeds were dead-on-arrival (their EMBED phase was removed by
 *      st_b50005df — the chunk-embed daemon owns embedding); the rescore rows
 *      quarantined on the timeout this story fixed (maint_rescore has slice
 *      support + a 900s budget). No retired-type quarantine carries operator
 *      value — no handler can ever run one again.
 *   3. RE-QUEUES quarantined email_history_backfill rows through the real
 *      enqueue path (requeueQuarantined) so the long-pending backfills drain
 *      or surface in health rather than rot — the type stays first-class on
 *      the maintenance worker.
 *   4. Copies the legacy nightly history jsonl to the maintenance path once,
 *      so AUDIT's day-over-day delta anomalies survive the rename.
 *
 * === Compute Tier Protocol ===
 * Tier 0 only: SQL + one file copy. No LLM.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import db from '../lib/db.js';
import { enqueuePassiveJob } from '../lib/passive-jobs.js';

const DRY_RUN = process.argv.includes('--dry-run');
const summary = {
  dry_run: DRY_RUN,
  queued_nightly_deleted: 0,
  quarantined_retired_deleted: 0,
  invalid_email_backfills_deleted: 0,
  email_backfills_requeued: 0,
  history_copied: false,
};

// 1. Queued nightly_* seeds — no handler exists for these types anymore.
const queued = db.prepare(`
  SELECT id, job_type FROM passive_jobs
   WHERE job_type LIKE 'nightly_%' AND status = 'queued'
`).all();
if (!DRY_RUN && queued.length) {
  const del = db.prepare('DELETE FROM passive_jobs WHERE id = ?');
  db.transaction((rows) => { for (const r of rows) del.run(r.id); })(queued);
}
summary.queued_nightly_deleted = queued.length;

// 2. Quarantined rows of retired types — the whole nightly_* namespace is
// retired, so every quarantined row of it is a tombstone no handler can run.
const quarantined = db.prepare(`
  SELECT id, job_type FROM passive_jobs
   WHERE job_type LIKE 'nightly_%' AND status = 'quarantined'
`).all();
if (!DRY_RUN && quarantined.length) {
  const del = db.prepare('DELETE FROM passive_jobs WHERE id = ?');
  db.transaction((rows) => { for (const r of rows) del.run(r.id); })(quarantined);
}
summary.quarantined_retired_deleted = quarantined.length;

// 3. Legacy invalid email_history_backfill rows — early versions of this
// migration could leave auto-keyed system rows with no account identity. They
// cannot be repaired because the payload carries no email; the account-keyed
// supervisor probe is the source of truth for real backfill work.
const invalidEmailBackfills = db.prepare(`
  SELECT id
    FROM passive_jobs
   WHERE job_type = 'email_history_backfill'
     AND status IN ('queued', 'failed', 'quarantined')
     AND (target_id IS NULL OR target_id = '')
     AND (payload IS NULL OR payload = '' OR payload = '{}')
     AND unique_key LIKE 'auto:%'
`).all();
if (!DRY_RUN && invalidEmailBackfills.length) {
  const del = db.prepare('DELETE FROM passive_jobs WHERE id = ?');
  db.transaction((rows) => { for (const r of rows) del.run(r.id); })(invalidEmailBackfills);
}
summary.invalid_email_backfills_deleted = invalidEmailBackfills.length;

// 4. Quarantined email_history_backfill rows — revive through the app path
// (enqueuePassiveJob + requeueQuarantined) so attempts/lease/quarantine_reason
// reset exactly the way the queue machinery expects.
const backfills = db.prepare(`
  SELECT unique_key, target_id, payload, priority, timeout_ms
    FROM passive_jobs
   WHERE job_type = 'email_history_backfill' AND status = 'quarantined'
`).all();
for (const row of backfills) {
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
  if (!DRY_RUN) {
    enqueuePassiveJob({
      database: db,
      jobType: 'email_history_backfill',
      uniqueKey: row.unique_key,
      targetType: 'account',
      targetId: row.target_id,
      priority: row.priority ?? 25,
      timeoutMs: row.timeout_ms || 5 * 60_000,
      payload,
      metadata: { source: 'migrate-overnight-to-routines' },
      requeueQuarantined: true,
    });
  }
  summary.email_backfills_requeued += 1;
}

// 5. History continuity: AUDIT reads the maintenance history path now; copy
// the legacy nightly file once so tomorrow's delta compares against yesterday
// instead of starting blind.
// ROBOTDOJO_STATE_DIR override keeps the test run off the live ~/.robotdojo.
const STATE_DIR = process.env.ROBOTDOJO_STATE_DIR || resolve(homedir(), '.robotdojo');
const legacyHistory = resolve(STATE_DIR, 'logs', 'nightly', 'robotdojo-nightly-history.jsonl');
const maintHistory = resolve(STATE_DIR, 'logs', 'maintenance', 'maintenance-history.jsonl');
if (existsSync(legacyHistory) && !existsSync(maintHistory)) {
  if (!DRY_RUN) {
    mkdirSync(dirname(maintHistory), { recursive: true });
    copyFileSync(legacyHistory, maintHistory);
  }
  summary.history_copied = true;
}

console.log(JSON.stringify(summary, null, 2));
