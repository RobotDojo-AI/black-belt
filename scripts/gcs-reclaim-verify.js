#!/usr/bin/env node
/**
 * Deferred re-check + restore for the GCS noncurrent-version reclaim (st_6ad153fb).
 *
 * The lifecycle rule armed by scripts/gcs-reclaim-noncurrent.js does not reclaim
 * bytes at apply-time — GCS evaluates lifecycle config on its own background
 * sweep (config takes up to ~24h to take effect; draining ~666 GiB across
 * hundreds of thousands of small objects then takes ~1-3 days). This script is
 * the idempotent, re-runnable tool for checking whether that drain has finished,
 * and for restoring the 7-day soft-delete safety net once it has — never before,
 * because restoring soft delete while the pile is still draining would re-park
 * every subsequently-deleted noncurrent version for a fresh 7 days plus an
 * early-deletion fee.
 *
 * Usage:
 *   node scripts/gcs-reclaim-verify.js --bucket gs://<name> --report
 *       Queries Cloud Monitoring `storage/v2/total_bytes` by type
 *       (live-object / noncurrent-object / soft-deleted-object), prints current
 *       GiB per type and the computed monthly cost. Always exits 0 — this proves
 *       the measurement path works, it does not assert a target has been hit.
 *
 *   node scripts/gcs-reclaim-verify.js --bucket gs://<name> --confirm-drain
 *       Exits 0 only when noncurrent-object bytes have settled near zero AND
 *       total stored bytes have settled near live+tail. Exits 1 otherwise (the
 *       expected result until GCS's sweep finishes). Safe to re-run daily.
 *
 *   node scripts/gcs-reclaim-verify.js --bucket gs://<name> --restore-soft-delete
 *       Re-checks the drain condition itself (same logic as --confirm-drain) and
 *       refuses — exits 1, no mutation — unless it currently passes. Only then
 *       does it re-enable 7-day soft delete, by invoking the existing repo-wide
 *       scripts/gcs-enable-soft-delete.js (idempotent; covers both surviving
 *       backup buckets) rather than reimplementing the same gcloud call.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INTELLIGENCE_TIER = 'extraction';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SOFT_DELETE_SCRIPT = resolve(SCRIPT_DIR, 'gcs-enable-soft-delete.js');

const GIB = 1024 ** 3;
// GCS pricing page, US multi-region Standard storage — matches the rate used in
// this story's plan (agents research, not a cross-app tunable; this script is a
// one-off infra measurement tool, not product config).
const US_MULTI_REGION_STANDARD_USD_PER_GIB_MONTH = 0.026;

// "Settled to ~0" / "~live+tail" thresholds from this story's AC2 Manual QA text.
const NONCURRENT_NEAR_ZERO_BYTES = 1 * GIB;
const SETTLED_TOTAL_CEILING_BYTES = 100 * GIB;

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return {
    bucket: get('--bucket'),
    report: argv.includes('--report'),
    confirmDrain: argv.includes('--confirm-drain'),
    restoreSoftDelete: argv.includes('--restore-soft-delete'),
  };
}

function shortName(bucketArg) {
  return (bucketArg || '').replace(/^gs:\/\//, '').replace(/\/+$/, '').trim();
}

function accessToken() {
  const result = spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`failed to obtain gcloud access token: ${result.stderr?.trim() || result.status}`);
  }
  return result.stdout.trim();
}

function currentProject() {
  const result = spawnSync('gcloud', ['config', 'get-value', 'project'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('failed to resolve current gcloud project');
  return result.stdout.trim();
}

/** Latest Cloud Monitoring storage/v2/total_bytes reading, keyed by `type` label. */
async function latestBytesByType(bucket, project) {
  const token = accessToken();
  const now = new Date();
  const start = new Date(now.getTime() - 26 * 60 * 60 * 1000); // covers ~24h ingest delay + daily sample
  const filter = `metric.type="storage.googleapis.com/storage/v2/total_bytes" AND resource.labels.bucket_name="${bucket}"`;
  const params = new URLSearchParams({
    filter,
    'interval.startTime': start.toISOString(),
    'interval.endTime': now.toISOString(),
    view: 'FULL',
  });
  const url = `https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`monitoring query failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const byType = {};
  for (const series of data.timeSeries || []) {
    const type = series.metric?.labels?.type;
    const latest = series.points?.[0]?.value?.doubleValue;
    if (type && typeof latest === 'number') byType[type] = latest;
  }
  return byType;
}

function toGiB(bytes) {
  return bytes / GIB;
}

function monthlyCostUsd(totalBytes) {
  return toGiB(totalBytes) * US_MULTI_REGION_STANDARD_USD_PER_GIB_MONTH;
}

function printReport(bucket, byType) {
  const live = byType['live-object'] || 0;
  const noncurrent = byType['noncurrent-object'] || 0;
  const softDeleted = byType['soft-deleted-object'] || 0;
  const total = live + noncurrent + softDeleted;
  console.log(`[gcs-reclaim-verify] gs://${bucket} — Cloud Monitoring storage/v2/total_bytes`);
  console.log(`  live-object:        ${toGiB(live).toFixed(2)} GiB`);
  console.log(`  noncurrent-object:  ${toGiB(noncurrent).toFixed(2)} GiB`);
  console.log(`  soft-deleted-object:${' '.repeat(1)}${toGiB(softDeleted).toFixed(2)} GiB`);
  console.log(`  total:              ${toGiB(total).toFixed(2)} GiB`);
  console.log(`  computed cost:      $${monthlyCostUsd(total).toFixed(2)}/mo (US multi-region Standard @ $${US_MULTI_REGION_STANDARD_USD_PER_GIB_MONTH}/GiB-mo)`);
}

/**
 * @returns {{drained: boolean, noncurrent: number, total: number}}
 */
function evaluateDrain(byType) {
  const noncurrent = byType['noncurrent-object'] || 0;
  const total = Object.values(byType).reduce((sum, v) => sum + v, 0);
  const noncurrentDrained = noncurrent < NONCURRENT_NEAR_ZERO_BYTES;
  const totalSettled = total < SETTLED_TOTAL_CEILING_BYTES;
  return { drained: noncurrentDrained && totalSettled, noncurrent, total, noncurrentDrained, totalSettled };
}

function runSoftDeleteRestore() {
  console.log(`[gcs-reclaim-verify] invoking ${SOFT_DELETE_SCRIPT} to re-enable 7-day soft delete`);
  const result = spawnSync(process.execPath, [SOFT_DELETE_SCRIPT], { stdio: 'inherit', encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`[gcs-reclaim-verify] soft-delete restore FAILED (exit ${result.status})`);
    process.exit(1);
  }
  console.log('[gcs-reclaim-verify] soft-delete restore complete');
}

async function main() {
  const { bucket: bucketArg, report, confirmDrain, restoreSoftDelete } = parseArgs(process.argv.slice(2));

  if (!bucketArg) {
    console.error('BLOCKED: --bucket gs://<name> is required');
    process.exit(1);
  }
  const bucket = shortName(bucketArg);

  if (!report && !confirmDrain && !restoreSoftDelete) {
    console.error('Usage: gcs-reclaim-verify.js --bucket gs://<name> [--report | --confirm-drain | --restore-soft-delete]');
    process.exit(1);
  }

  const project = currentProject();

  if (restoreSoftDelete) {
    const byType = await latestBytesByType(bucket, project);
    const drain = evaluateDrain(byType);
    console.log(
      `[gcs-reclaim-verify] drain check — noncurrent ${toGiB(drain.noncurrent).toFixed(2)} GiB `
      + `(need < ${toGiB(NONCURRENT_NEAR_ZERO_BYTES)} GiB), total ${toGiB(drain.total).toFixed(2)} GiB `
      + `(need < ${toGiB(SETTLED_TOTAL_CEILING_BYTES)} GiB)`,
    );
    if (!drain.drained) {
      console.error(
        'BLOCKED: drain not yet confirmed — refusing to restore soft delete '
        + '(restoring now would re-park in-flight deletes for another 7 days). No mutation performed.',
      );
      process.exit(1);
    }
    console.log('[gcs-reclaim-verify] drain confirmed — proceeding to restore soft delete');
    runSoftDeleteRestore();
    return;
  }

  if (confirmDrain) {
    const byType = await latestBytesByType(bucket, project);
    const drain = evaluateDrain(byType);
    console.log(
      `[gcs-reclaim-verify] noncurrent ${toGiB(drain.noncurrent).toFixed(2)} GiB `
      + `(need < ${toGiB(NONCURRENT_NEAR_ZERO_BYTES)} GiB) — ${drain.noncurrentDrained ? 'OK' : 'not yet'}`,
    );
    console.log(
      `[gcs-reclaim-verify] total ${toGiB(drain.total).toFixed(2)} GiB `
      + `(need < ${toGiB(SETTLED_TOTAL_CEILING_BYTES)} GiB) — ${drain.totalSettled ? 'OK' : 'not yet'}`,
    );
    if (!drain.drained) {
      console.error('NOT YET DRAINED — re-run later (GCS sweep is asynchronous, ~1-3 days)');
      process.exit(1);
    }
    console.log('PASS — drain confirmed');
    return;
  }

  if (report) {
    const byType = await latestBytesByType(bucket, project);
    printReport(bucket, byType);
    return;
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[gcs-reclaim-verify] ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}
