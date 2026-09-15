#!/usr/bin/env node
/**
 * scripts/backfill-referral-yc-filter.js — st_b879a361
 *
 * One-shot backfill: re-qualify every existing referral_scores row using
 * lib/referral/yc-filter.js#qualifyPerson and write the new st_b879a361
 * columns into place.
 *
 * INTELLIGENCE_TIER: not LLM; deterministic Tier-0 regex + Set lookup. No
 * declaration required.
 *
 * USAGE
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/backfill-referral-yc-filter.js [--dry-run]
 *
 * BEHAVIOR
 *   Iterates referral_scores in batches of 500 ORDER BY person_id OFFSET, calls
 *   qualifyPerson(db, person_id) per row, UPDATEs the new columns. Hard exits
 *   after the SELECT returns 0 rows. --dry-run skips the UPDATE.
 *
 * BATCH FORWARD PROGRESS
 *   Uses OFFSET-based iteration (NOT state-mutation-as-advancement). Every
 *   batch's SELECT advances the offset regardless of whether the UPDATE
 *   actually mutated anything. This is safe because the SELECT is over the
 *   existing rows; new rows added concurrently land at the end and will be
 *   picked up by scoreReferralCandidate's hot path going forward.
 *
 * SAFETY
 *   Reads from main DB by default. Writes are skipped under --dry-run.
 *   Reports per-batch progress to stdout.
 */

const isDryRun = process.argv.includes('--dry-run');

// Dynamic import after env confirmed.
const { default: db } = await import('../lib/db.js');
const { qualifyPerson } = await import('../lib/referral/yc-filter.js');

const BATCH = 500;

const updateStmt = db.prepare(`
  UPDATE referral_scores
     SET qualifies_for_referral = ?,
         has_path_c_signal      = ?,
         path_c_weight          = ?,
         company_priority_tier  = ?,
         role_bucket_priority   = ?,
         detected_role          = ?,
         detected_role_source   = ?,
         company_type           = ?,
         qualified_domain_source= ?,
         qualified_path         = ?,
         most_recent_prof_email_domain = ?
   WHERE person_id = ?
`);

const selectBatchStmt = db.prepare(`
  SELECT person_id FROM referral_scores
  ORDER BY person_id ASC
  LIMIT ? OFFSET ?
`);

let processed = 0;
let qualifiedCount = 0;
let offset = 0;
let batchNum = 0;

while (true) {
  const batch = selectBatchStmt.all(BATCH, offset);
  if (batch.length === 0) break;
  batchNum++;

  // SQLite better-sqlite3: WAL checkpoint before large transaction to avoid
  // BUSY_SNAPSHOT from stale reader marks.
  if (!isDryRun && batchNum === 1) {
    try { db.pragma('wal_checkpoint(RESTART)'); }
    catch { /* in-memory DB has no WAL — ignore */ }
  }

  const apply = db.transaction((rows) => {
    for (const row of rows) {
      let q;
      try {
        q = qualifyPerson(db, row.person_id);
      } catch (err) {
        // Log and skip — never let one bad person abort the whole backfill.
        console.warn(`[backfill] qualifyPerson failed for ${row.person_id}: ${err.message}`);
        continue;
      }
      processed++;
      if (q.qualifies) qualifiedCount++;
      if (isDryRun) continue;
      updateStmt.run(
        q.qualifies ? 1 : 0,
        q.has_path_c ? 1 : 0,
        q.path_c_weight ?? 0,
        q.company_priority_tier ?? null,
        q.role_priority ?? null,
        q.detected_role ?? null,
        q.detected_role_source ?? null,
        q.company_type ?? null,
        q.qualified_domain_source ?? null,
        q.qualified_path ?? null,
        q.prof_email_domain ?? null,
        row.person_id,
      );
    }
  });
  apply(batch);

  process.stdout.write(
    `batch ${batchNum}: offset=${offset} rows=${batch.length} processed=${processed} qualified=${qualifiedCount}` +
    (isDryRun ? ' [dry-run]' : '') + '\n'
  );
  offset += BATCH;
}

const mode = isDryRun ? 'dry-run' : 'live';
process.stdout.write(
  `done [${mode}]: processed=${processed} qualified=${qualifiedCount}\n`
);
