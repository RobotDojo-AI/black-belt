#!/usr/bin/env node
/**
 * Gated arm operation for reclaiming orphaned noncurrent object versions from a
 * GCS bucket (st_6ad153fb). The operator's files bucket accumulated ~666 GiB
 * of noncurrent versions because Object Versioning was on with no paired
 * lifecycle rule — Google's own docs warn this "can silently accumulate huge
 * amounts of noncurrent data."
 *
 * Executes exactly three mutations, in this order, because the order is
 * safety-critical:
 *
 *   1. Disable Object Versioning   — stops new noncurrent versions from forming.
 *   2. Disable soft delete         — WITHOUT this, deleting a noncurrent version
 *                                    just re-parks it in soft-delete for another
 *                                    7 days (plus an early-deletion fee). Doing
 *                                    this before step 3 makes the lifecycle
 *                                    sweep's deletes permanent-immediate.
 *   3. Apply the isLive:false lifecycle rule (config/gcs-lifecycle-noncurrent.json)
 *                                  — expires the existing pile on GCS's own
 *                                    background sweep (~24h to take effect, then
 *                                    ~1-3 days to fully drain) and stands as
 *                                    permanent recurrence insurance. Every rule
 *                                    condition is `isLive:false`, so the
 *                                    mechanism can never match a live object.
 *
 * Gate: nothing mutates unless --confirm exactly string-matches the resolved
 * bucket's short name. A wrong or missing --confirm exits non-zero first —
 * this is the owner-confirmation gate for AC5, modeled on
 * scripts/gcs-destroy-bucket.js's confirm-match pattern.
 *
 * Usage:
 *   node scripts/gcs-reclaim-noncurrent.js --bucket gs://<name> --dry-run
 *       Prints the ordered plan and the resolved target. No mutation, no
 *       --confirm required.
 *
 *   node scripts/gcs-reclaim-noncurrent.js --bucket gs://<name> --confirm <name>
 *       Executes steps 1-3 above in order. Writes a pre-arm baseline snapshot
 *       (versioning/soft-delete state + live/noncurrent/soft-deleted bytes from
 *       Cloud Monitoring) to this story's baseline.json so the deferred drain
 *       can be diffed later by scripts/gcs-reclaim-verify.js.
 *
 *   node scripts/gcs-reclaim-noncurrent.js --bucket gs://<name> --confirm <name> --dry-run
 *       Prints the plan without mutating, same as bare --dry-run, but exercises
 *       the confirm-match check first (useful for verifying the gate).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INTELLIGENCE_TIER = 'extraction';

const STORY_ID = 'st_6ad153fb';
const STORY_DIR = resolve(
  process.cwd(),
  `user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/${STORY_ID}`,
);
const LIFECYCLE_FILE = resolve(process.cwd(), 'config/gcs-lifecycle-noncurrent.json');
const GIB = 1024 ** 3;

const STEPS = [
  {
    label: 'Disable Object Versioning (stop new noncurrent accumulation)',
    args: (bucket) => ['storage', 'buckets', 'update', `gs://${bucket}`, '--no-versioning'],
  },
  {
    label: 'Disable soft delete (retention -> 0; makes subsequent noncurrent deletes permanent)',
    args: (bucket) => ['storage', 'buckets', 'update', `gs://${bucket}`, '--clear-soft-delete'],
  },
  {
    label: `Apply isLive:false bounded lifecycle rule from ${LIFECYCLE_FILE}`,
    args: (bucket) => [
      'storage', 'buckets', 'update', `gs://${bucket}`, `--lifecycle-file=${LIFECYCLE_FILE}`,
    ],
  },
];

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return { bucket: get('--bucket'), confirm: get('--confirm'), dryRun: argv.includes('--dry-run') };
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

async function readBucketFields(bucket, fields) {
  const token = accessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}?fields=${encodeURIComponent(fields)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`bucket read failed: ${res.status} ${await res.text()}`);
  return res.json();
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

function printPlan(bucket) {
  console.log(`[gcs-reclaim-noncurrent] target: gs://${bucket}`);
  console.log('[gcs-reclaim-noncurrent] ordered plan:');
  STEPS.forEach((step, i) => console.log(`  ${i + 1}. ${step.label}`));
}

async function main() {
  const { bucket: bucketArg, confirm, dryRun } = parseArgs(process.argv.slice(2));

  if (!bucketArg) {
    console.error('BLOCKED: --bucket gs://<name> is required');
    process.exit(1);
  }
  const bucket = shortName(bucketArg);

  if (dryRun && confirm === undefined) {
    printPlan(bucket);
    console.log('[gcs-reclaim-noncurrent] --dry-run: no mutation performed');
    return;
  }

  if (!confirm) {
    console.error('BLOCKED: --confirm <bucket-name> is required — no mutation performed');
    process.exit(1);
  }
  if (confirm.trim() !== bucket) {
    console.error(
      `BLOCKED: --confirm "${confirm}" does not match target bucket "${bucket}" — no mutation performed`,
    );
    process.exit(1);
  }

  printPlan(bucket);

  if (dryRun) {
    console.log('[gcs-reclaim-noncurrent] --dry-run: confirm matched, but no mutation performed');
    return;
  }

  // Baseline snapshot BEFORE any mutation, for the deferred diff.
  const project = currentProject();
  const before = await readBucketFields(bucket, 'versioning,softDeletePolicy');
  let bytesByType = {};
  try {
    bytesByType = await latestBytesByType(bucket, project);
  } catch (error) {
    console.warn(`[gcs-reclaim-noncurrent] baseline Monitoring read failed (non-fatal): ${error.message}`);
  }

  for (const [i, step] of STEPS.entries()) {
    console.log(`[gcs-reclaim-noncurrent] step ${i + 1}/${STEPS.length}: ${step.label}`);
    const result = spawnSync('gcloud', step.args(bucket), { stdio: 'inherit', encoding: 'utf8' });
    if (result.status !== 0) {
      console.error(
        `[gcs-reclaim-noncurrent] step ${i + 1} FAILED (exit ${result.status}) — stopping; later steps NOT run`,
      );
      process.exit(1);
    }
  }

  mkdirSync(STORY_DIR, { recursive: true });
  const baselinePath = resolve(STORY_DIR, 'baseline.json');
  const baseline = {
    story_id: STORY_ID,
    bucket,
    armed_at: new Date().toISOString(),
    pre_arm: {
      versioning_enabled: !!(before.versioning && before.versioning.enabled),
      soft_delete_retention_seconds: Number(before.softDeletePolicy?.retentionDurationSeconds || 0),
    },
    pre_arm_bytes_by_type: bytesByType,
    pre_arm_bytes_by_type_gib: Object.fromEntries(
      Object.entries(bytesByType).map(([type, bytes]) => [type, bytes / GIB]),
    ),
  };
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`[gcs-reclaim-noncurrent] baseline snapshot written to ${baselinePath}`);
  console.log('[gcs-reclaim-noncurrent] armed — GCS lifecycle sweep will drain the pile over ~1-3 days');
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[gcs-reclaim-noncurrent] ERROR: ${error?.message || error}`);
    process.exit(1);
  });
}
