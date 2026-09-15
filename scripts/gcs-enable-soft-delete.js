#!/usr/bin/env node
/**
 * Makes GCS soft delete an explicit, recorded configuration on the two surviving
 * backup buckets — so an accidental bulk delete is recoverable within a retention
 * window instead of permanent.
 *
 * Idempotent by design: reads the current soft-delete retention, and only calls
 * update when it is below the 7-day floor. Both buckets already report 604800s
 * (GCP made soft delete default-on for all buckets in March 2024, and both
 * postdate that), so the expected outcome is "already enabled, no change" — this
 * script exists to turn an implicit platform default into an intentional,
 * re-assertable setting, not to fix a gap.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { requireBuckets } from '../lib/backup-buckets.js';

export const INTELLIGENCE_TIER = 'extraction';

const MIN_RETENTION_SECONDS = 7 * 24 * 60 * 60; // 604800 (7 days)

function currentRetentionSeconds(bucket) {
  const result = spawnSync('gcloud', [
    'storage', 'buckets', 'describe', `gs://${bucket}`,
    '--format=value(softDeletePolicy.retentionDurationSeconds)',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `describe failed for gs://${bucket}`);
  }
  const raw = (result.stdout || '').trim();
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function setRetention7d(bucket) {
  const result = spawnSync('gcloud', [
    'storage', 'buckets', 'update', `gs://${bucket}`,
    '--soft-delete-duration=7d',
  ], { stdio: 'inherit', encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`update failed for gs://${bucket} (exit ${result.status})`);
  }
}

function main() {
  // The names are operator-specific and arrive from the gitignored override.
  // Refuse rather than fall back: this script CALLS gcloud with the name, so a
  // placeholder would aim a bucket update at somebody else's bucket.
  const gate = requireBuckets(['files', 'db']);
  if (!gate.ok) {
    console.error(`[soft-delete] ${gate.message}`);
    process.exit(2);
  }
  let failed = false;
  for (const bucket of [gate.buckets.files, gate.buckets.db]) {
    try {
      const current = currentRetentionSeconds(bucket);
      if (current >= MIN_RETENTION_SECONDS) {
        console.log(`[soft-delete] gs://${bucket}: already ${current}s (>= ${MIN_RETENTION_SECONDS}s) — no change`);
        continue;
      }
      console.log(`[soft-delete] gs://${bucket}: found ${current}s (< ${MIN_RETENTION_SECONDS}s) — setting 7d retention`);
      setRetention7d(bucket);
      const after = currentRetentionSeconds(bucket);
      console.log(`[soft-delete] gs://${bucket}: now ${after}s`);
    } catch (error) {
      console.error(`[soft-delete] gs://${bucket}: ERROR — ${error?.message || error}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
