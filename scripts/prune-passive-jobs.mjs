#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/prune-passive-jobs.mjs — the runnable half of the passive-queue
// retention bound. Domain logic lives in lib/passive-retention.js; this file is
// argument parsing, a WAL checkpoint, and reporting.
//
// Compute tier: Tier 0 (local SQL only). No LLM on any path.
//
// WHY THIS EXISTS. `passive_jobs` had no retention path of any kind, so the
// session-log job history grew unbounded (147,420 rows / ~1.05 GB of payload,
// +2,711/day). That growth fed the maintenance worker's CPU burn. Migration 147
// fixed the query cost; this bounds the table that fed it.
//
// Two tiers, both in lib/passive-retention.js:
//   COMPACT (default 14d) — NULL the payload, keep the row and its unique_key,
//     so the queue's dedup guard is never lost. Reclaims the bytes.
//   PRUNE   (default 90d) — delete the row entirely, bounding row count.
//
// Only `done` rows, only session-log job types. Routine rows are revived via
// requeueDone and are never swept.
//
// Usage:
//   node scripts/prune-passive-jobs.mjs               # dry run, prints the plan
//   node scripts/prune-passive-jobs.mjs --apply       # compact + prune
//   node scripts/prune-passive-jobs.mjs --apply --compact-only
//   node scripts/prune-passive-jobs.mjs --apply --max-seconds 30
// ─────────────────────────────────────────────────────────────────────────────

export const INTELLIGENCE_TIER = 'extraction';

// Deterministic SQL-only sweep; it must run in the maintenance window like its
// peers rather than waiting for HID idle.
export const IDLE_GATED = false;

import { homedir } from 'node:os';
import { resolve } from 'node:path';

const HOME = process.env.HOME || homedir();
const ROOT = process.env.ROBOTDOJO_HOME || resolve(HOME, 'robotdojo');

const db = (await import(resolve(ROOT, 'lib/db.js'))).default;
const {
  compactSessionLogPayloads,
  pruneSessionLogJobRows,
  describePassiveRetention,
} = await import(resolve(ROOT, 'lib/passive-retention.js'));
const { runDeadlineSweep, describeDeadlineSweep } = await import(resolve(ROOT, 'lib/passive-deadline.js'));

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : Number(argv[i + 1]);
};

const apply = has('--apply');
const compactOnly = has('--compact-only');
const pruneOnly = has('--prune-only');
const maxSeconds = valueOf('--max-seconds', undefined);

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';

const before = describePassiveRetention(db);
console.log('[passive-retention] session-log queue history');
console.log(`  rows total         : ${before.totalRows.toLocaleString()}`);
console.log(`  payload total      : ${mb(before.totalPayloadBytes)}`);
console.log(`  compactable (>${before.compactDays}d) : ${before.compactableRows.toLocaleString()} rows, ${mb(before.compactableBytes)}`);
console.log(`  prunable    (>${before.pruneDays}d) : ${before.prunableRows.toLocaleString()} rows`);

if (!apply) {
  console.log('\n[passive-retention] dry run — nothing changed. Re-run with --apply.');
  process.exit(0);
}

db.pragma('busy_timeout = 30000');

const opts = maxSeconds === undefined ? {} : { maxSeconds };

if (!pruneOnly) {
  const r = compactSessionLogPayloads(db, opts);
  console.log(
    `\n[passive-retention] compacted ${r.compacted.toLocaleString()} payloads, ` +
    `freed ${mb(r.bytesFreed)} in ${r.elapsedMs}ms${r.partial ? ' (partial — budget elapsed, resumes next run)' : ''}`,
  );
}

if (!compactOnly) {
  const r = pruneSessionLogJobRows(db, opts);
  console.log(
    `[passive-retention] pruned ${r.deleted.toLocaleString()} rows in ${r.elapsedMs}ms` +
    `${r.partial ? ' (partial — budget elapsed, resumes next run)' : ''}`,
  );
}

// Move the freed pages out of the WAL so the space is actually released to the
// main file rather than sitting in a growing -wal.
try {
  const cp = db.pragma('wal_checkpoint(TRUNCATE)', { simple: false });
  console.log('[passive-retention] wal_checkpoint(TRUNCATE):', JSON.stringify(cp));
} catch (err) {
  console.warn('[passive-retention] checkpoint skipped:', err.message);
}

// Give-up bound (df_19c11899 follow-up). Runs in the same daily slot as
// retention: both are "the queue bounds itself" work. First call only records
// the epoch -- nothing is quarantined until every live job has had a full
// window measured from that point.
try {
  const { createNotificationTask } = await import(resolve(ROOT, 'lib/asana.js'));
  const d = await runDeadlineSweep(db, { apply: true, notify: createNotificationTask });
  if (d.epochJustEstablished) {
    console.log(`\n[passive-deadline] ${d.note}`);
  } else if (d.quarantined > 0) {
    console.log(`\n[passive-deadline] ${d.quarantined} job(s) gave up on the deadline bound, ${d.notified} owner-notified`);
    for (const j of d.jobs) console.log(`  - ${j.unique_key || j.job_type} (no success since ${j.last_success_at || 'ever'})`);
  } else {
    const plan = describeDeadlineSweep(db);
    console.log(`\n[passive-deadline] no job past the ${plan.maxStaleDays}d bound (${plan.liveJobs} live)`);
  }
} catch (err) {
  console.warn('[passive-deadline] sweep skipped:', err.message);
}

const after = describePassiveRetention(db);
console.log('\n[passive-retention] after');
console.log(`  rows total    : ${after.totalRows.toLocaleString()} (was ${before.totalRows.toLocaleString()})`);
console.log(`  payload total : ${mb(after.totalPayloadBytes)} (was ${mb(before.totalPayloadBytes)})`);

process.exit(0);
