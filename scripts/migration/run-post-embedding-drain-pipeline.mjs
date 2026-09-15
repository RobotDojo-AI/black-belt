#!/usr/bin/env node
/**
 * Post-drain data-plane runner.
 *
 * This is the executable handoff after the temporary embedding drain reaches
 * zero. It waits for the guarded drain handoff, then runs the meaning-moving
 * steps in order with status written to ~/.robotdojo/runtime.
 */

export const INTELLIGENCE_TIER = 'orchestration';

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = process.env.ROBOTDOJO_HOME || resolve(homedir(), 'robotdojo');
const CONFIG_DIR = process.env.ROBOTDOJO_CONFIG || resolve(homedir(), '.robotdojo');
const RUNTIME_DIR = resolve(CONFIG_DIR, 'runtime');
const LOG_DIR = resolve(CONFIG_DIR, 'logs');
const HANDOFF_FILE = process.env.ROBOTDOJO_DRAIN_HANDOFF_FILE
  || resolve(RUNTIME_DIR, 'embedding-drain-handoff.json');
const STATUS_FILE = process.env.ROBOTDOJO_POST_DRAIN_STATUS_FILE
  || resolve(RUNTIME_DIR, 'post-embedding-drain-pipeline.json');
const LOCK_PATH = process.env.ROBOTDOJO_POST_DRAIN_LOCK_FILE
  || resolve(RUNTIME_DIR, 'post-embedding-drain-pipeline.lock');
const LOG_PATH = process.env.ROBOTDOJO_POST_DRAIN_LOG_FILE
  || resolve(LOG_DIR, 'post-embedding-drain-pipeline.log');
const POST_DRAIN_PREFLIGHT_RESULT_FILE = process.env.ROBOTDOJO_POST_DRAIN_PREFLIGHT_RESULT_FILE
  || resolve(RUNTIME_DIR, 'post-drain-preflight.json');
const MEMORY_REFOCUS_RESULT_FILE = process.env.ROBOTDOJO_POST_DRAIN_MEMORY_REFOCUS_RESULT_FILE
  || resolve(RUNTIME_DIR, 'post-drain-memory-refocus-result.json');
const RECLASSIFY_RESULT_FILE = process.env.ROBOTDOJO_POST_DRAIN_RECLASSIFY_RESULT_FILE
  || resolve(RUNTIME_DIR, 'post-drain-reclassify-result.json');
const ROUTING_AUDIT_RESULT_FILE = process.env.ROBOTDOJO_POST_DRAIN_ROUTING_AUDIT_RESULT_FILE
  || resolve(RUNTIME_DIR, 'post-drain-routing-residue-audit.json');
const SPLIT_VEC_REPAIR_RESULT_FILE = process.env.ROBOTDOJO_POST_DRAIN_SPLIT_VEC_REPAIR_RESULT_FILE
  || resolve(RUNTIME_DIR, 'post-drain-split-vector-repair-result.json');
const VEC_ORPHAN_RESULT_FILE = process.env.ROBOTDOJO_POST_DRAIN_VEC_ORPHAN_RESULT_FILE
  || resolve(RUNTIME_DIR, 'post-drain-vec-orphan-check.json');
const SOURCE_TOPIC_METADATA_REPAIR_RESULT_FILE = process.env.ROBOTDOJO_POST_DRAIN_SOURCE_TOPIC_METADATA_REPAIR_RESULT_FILE
  || resolve(RUNTIME_DIR, 'post-drain-source-topic-metadata-repair.json');
const BACKUP_RESULT_FILE = process.env.ROBOTDOJO_POST_DRAIN_BACKUP_RESULT_FILE
  || resolve(RUNTIME_DIR, 'post-drain-gcs-backup-result.json');
// A verified GCS backup produced within this window (default 6h) is still
// trustworthy for the post-drain handoff: the data plane has not moved (the
// embed writer hold is held), so re-running the multi-hour db-snapshot upload
// would only burn wall time. When a fresh, passing backup already exists we
// reuse it and record a synthetic noop step instead of re-running.
const BACKUP_REUSE_MAX_AGE_MS = positiveNumber(
  process.env.ROBOTDOJO_POST_DRAIN_BACKUP_REUSE_MAX_AGE_MS,
  6 * 60 * 60_000,
);
const BACKUP_LOCK_FILE = process.env.ROBOTDOJO_BACKUP_LOCK_FILE
  || '/tmp/robotdojo-backup.pid';
const GLOBAL_HNSW_RESULT_FILE = process.env.ROBOTDOJO_POST_DRAIN_GLOBAL_HNSW_RESULT_FILE
  || resolve(RUNTIME_DIR, 'post-drain-global-hnsw-result.json');
const MEMORY_ROUTING_REPAIR_RESULT_FILE = process.env.ROBOTDOJO_POST_DRAIN_MEMORY_ROUTING_REPAIR_RESULT_FILE
  || resolve(RUNTIME_DIR, 'post-drain-memory-routing-repair-result.json');
const MEMORY_RECALC_RESULT_FILE = process.env.ROBOTDOJO_POST_DRAIN_MEMORY_RECALC_RESULT_FILE
  || resolve(RUNTIME_DIR, 'post-drain-memory-recalc-result.json');
const FINAL_PRODUCT_PROOF_FILE = process.env.ROBOTDOJO_STATUS_STOPLIGHT_LATEST
  || resolve(LOG_DIR, 'launch-stoplight-latest.json');
const FINAL_PRODUCT_PROOF_SNAPSHOT_DIR = resolve(LOG_DIR, 'launch-stoplight-snapshots');
const FINAL_PRODUCT_PROOF_ROWS = Object.freeze([
  'local_readiness',
  'login_session',
  'private_chat',
  'chat_open_daemon_quiet',
  'chat_stall_recovery',
  'browser_product_proof',
  'foreground_activity_signal',
  'data_pipeline_invariants',
  'retrieval_sentinel',
]);
const FINAL_PRODUCT_PROOF_EXPECTED_ROW_IDS = Object.freeze([
  'local_readiness',
  'login_session',
  'private_chat',
  'chat_open_daemon_quiet',
  'chat_stall_recovery',
  'browser_product_proof',
  'foreground_activity_signal',
  'data_pipeline_invariants',
  'retrieval_sentinel',
]);
const REQUIRED_DATA_PLANE_BOUNDARIES = Object.freeze([
  'db',
  'passive_jobs',
  'import_classification',
  'raw_source',
  'search',
  'embedding',
  'first_use_context',
  'semantic_retrieval',
  'entity_enrichment',
  'chat_context',
]);
const FINAL_PRODUCT_PROOF_REQUESTED_ROWS = Object.freeze([
  'private_chat',
  'chat_open_daemon_quiet',
  'chat_stall_recovery',
  'browser_product_proof',
  'data_pipeline_invariants',
  'retrieval_sentinel',
]);
const FINAL_PRODUCT_PROOF_COMMAND_ARGS = Object.freeze([
  'scripts/qa/launch-stoplight.js',
  '--row',
  'private_chat',
  '--row',
  'chat_open_daemon_quiet',
  '--row',
  'chat_stall_recovery',
  '--row',
  'browser_product_proof',
  '--row',
  'data_pipeline_invariants',
  '--row',
  'retrieval_sentinel',
]);
const BROWSER_ENTITY_CARD_PROOF = Object.freeze({
  row: 'browser_product_proof',
  spec: 'scripts/qa/tests/chat-browser-real-turn.spec.js',
  test_name: 'real browser entity-network turn answers from the local entity card',
  seed_marker: 'browser product proof seed in the local entity network',
  network_question: 'Use my data: is ${name} in my entity network? Answer briefly.',
  direct_find_question: 'Find ${name} in my entity network.',
  negative_premise_question: "Why isn't ${name} in my entity network?",
  expected_answer: 'Yes. ${name} is in your network.',
});
const MAIN_DB_BASENAME = basename(process.env.ROBOTDOJO_DB || 'robotdojo.db');
const VECTOR_DB_BASENAME = basename(process.env.ROBOTDOJO_EMBEDDINGS_DB || 'embeddings.db');

const args = parseArgs(process.argv.slice(2));
const dryRun = args.dryRun === true;
const once = args.once === true;
const watch = args.watch === true || !once;
const ignoreHandoff = args.ignoreHandoff === true;
const pollMs = positiveNumber(args.pollMs, process.env.ROBOTDOJO_POST_DRAIN_POLL_MS, 5 * 60_000);
const reclassifySliceSeconds = positiveNumber(
  args.reclassifySliceSeconds,
  process.env.ROBOTDOJO_POST_DRAIN_RECLASSIFY_SLICE_SECONDS,
  300,
);
const reclassifyPauseMs = positiveNumber(
  args.reclassifyPauseMs,
  process.env.ROBOTDOJO_POST_DRAIN_RECLASSIFY_PAUSE_MS,
  30_000,
);
const maxReclassifySlices = positiveNumber(
  args.maxReclassifySlices,
  process.env.ROBOTDOJO_POST_DRAIN_MAX_RECLASSIFY_SLICES,
  0,
);
const topicSliceSeconds = positiveNumber(
  args.topicSliceSeconds,
  process.env.ROBOTDOJO_POST_DRAIN_TOPIC_SLICE_SECONDS,
  900,
);
const topicPauseMs = positiveNumber(
  args.topicPauseMs,
  process.env.ROBOTDOJO_POST_DRAIN_TOPIC_PAUSE_MS,
  30_000,
);
const maxTopicSlices = positiveNumber(
  args.maxTopicSlices,
  process.env.ROBOTDOJO_POST_DRAIN_MAX_TOPIC_SLICES,
  20,
);
const maxNeedsRoutingChunks = nonnegativeNumber(
  args.maxNeedsRoutingChunks,
  process.env.ROBOTDOJO_POST_DRAIN_MAX_NEEDS_ROUTING_CHUNKS,
  500,
);
const maxPersonalUnexplainedImports = nonnegativeNumber(
  args.maxPersonalUnexplainedImports,
  process.env.ROBOTDOJO_POST_DRAIN_MAX_PERSONAL_UNEXPLAINED_IMPORTS,
  0,
);
const maxPersonalSourceMetadataRows = nonnegativeNumber(
  args.maxPersonalSourceMetadataRows,
  process.env.ROBOTDOJO_POST_DRAIN_MAX_PERSONAL_SOURCE_METADATA_ROWS,
  0,
);
const maxNeedsRoutingMemory = nonnegativeNumber(
  args.maxNeedsRoutingMemory,
  process.env.ROBOTDOJO_POST_DRAIN_MAX_NEEDS_ROUTING_MEMORY,
  500,
);
const postDrainEmbedHoldTtlMs = positiveNumber(
  args.postDrainEmbedHoldTtlMs,
  process.env.ROBOTDOJO_POST_DRAIN_EMBED_HOLD_TTL_MS,
  15 * 60_000,
);
const postDrainEmbedHoldRefreshMs = positiveNumber(
  args.postDrainEmbedHoldRefreshMs,
  process.env.ROBOTDOJO_POST_DRAIN_EMBED_HOLD_REFRESH_MS,
  60_000,
);
const chunkSourceQuietWaitMs = nonnegativeNumber(
  args.chunkSourceQuietWaitMs,
  process.env.ROBOTDOJO_POST_DRAIN_CHUNK_SOURCE_QUIET_WAIT_MS,
  120_000,
);
const chunkSourceQuietPollMs = positiveNumber(
  args.chunkSourceQuietPollMs,
  process.env.ROBOTDOJO_POST_DRAIN_CHUNK_SOURCE_QUIET_POLL_MS,
  1000,
);
const memoryRefocusSliceSeconds = positiveNumber(
  args.memoryRefocusSliceSeconds,
  process.env.ROBOTDOJO_POST_DRAIN_MEMORY_REFOCUS_SLICE_SECONDS,
  300,
);
const memoryRefocusPauseMs = positiveNumber(
  args.memoryRefocusPauseMs,
  process.env.ROBOTDOJO_POST_DRAIN_MEMORY_REFOCUS_PAUSE_MS,
  30_000,
);
const maxMemoryRefocusSlices = positiveNumber(
  args.maxMemoryRefocusSlices,
  process.env.ROBOTDOJO_POST_DRAIN_MAX_MEMORY_REFOCUS_SLICES,
  20,
);
const lockWaitMs = nonnegativeNumber(
  args.lockWaitMs,
  process.env.ROBOTDOJO_POST_DRAIN_LOCK_WAIT_MS,
  60_000,
);
const lockPollMs = positiveNumber(
  args.lockPollMs,
  process.env.ROBOTDOJO_POST_DRAIN_LOCK_POLL_MS,
  1000,
);
const backupSlotWaitMs = nonnegativeNumber(
  args.backupSlotWaitMs,
  process.env.ROBOTDOJO_POST_DRAIN_BACKUP_SLOT_WAIT_MS,
  6 * 60 * 60_000,
);
const backupSlotPollMs = positiveNumber(
  args.backupSlotPollMs,
  process.env.ROBOTDOJO_POST_DRAIN_BACKUP_SLOT_POLL_MS,
  60_000,
);
const stepHeartbeatMs = positiveNumber(
  args.stepHeartbeatMs,
  process.env.ROBOTDOJO_POST_DRAIN_STEP_HEARTBEAT_MS,
  60_000,
);
const globalHnswTimeoutMs = positiveNumber(
  args.globalHnswTimeoutMs,
  process.env.ROBOTDOJO_POST_DRAIN_GLOBAL_HNSW_TIMEOUT_MS,
  12 * 60 * 60_000,
);
const maxReadyHandoffAgeMs = positiveNumber(
  args.maxReadyHandoffAgeMs,
  process.env.ROBOTDOJO_POST_DRAIN_MAX_READY_HANDOFF_AGE_MS,
  6 * 60 * 60_000,
);

mkdirSync(RUNTIME_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

let lockFd = null;
let postDrainEmbedHold = null;
let postDrainEmbedHoldRefreshTimer = null;
let postDrainEmbedHoldLostReason = null;

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const RUNNER_CODE_SHA256 = sha256File(SCRIPT_PATH);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function positiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 0;
}

function nonnegativeNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ageMs(isoOrMs) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(String(isoOrMs || ''));
  return Number.isFinite(ms) ? Math.max(0, Date.now() - ms) : null;
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readRequiredStepJsonResult(path, label, step = null) {
  const fromFile = readJson(path);
  if (fromFile && typeof fromFile === 'object') {
    if (step) {
      const mtimeMs = statSync(path).mtimeMs;
      const startedMs = Date.parse(String(step.started_at || ''));
      const completedMs = Date.parse(String(step.completed_at || ''));
      if (Number.isFinite(startedMs) && mtimeMs < startedMs - 1000) {
        throw new Error(`${label} durable result file is stale: ${path}`);
      }
      if (Number.isFinite(completedMs) && mtimeMs > completedMs + 5000) {
        throw new Error(`${label} durable result file was not produced by the completed step: ${path}`);
      }
    }
    return fromFile;
  }
  throw new Error(`${label} did not write required durable result file: ${path}`);
}

function hasBasename(files, expected) {
  return Array.isArray(files) && files.some((file) => basename(String(file)) === expected);
}

function pathWithinDir(path, dir) {
  if (!path || !dir) return false;
  const resolvedPath = resolve(String(path));
  const resolvedDir = resolve(String(dir));
  return resolvedPath.startsWith(`${resolvedDir}/`);
}

function snapshotForBasename(snapshots, expected) {
  if (!Array.isArray(snapshots)) return null;
  return snapshots.find((entry) => basename(String(entry?.source || '')) === expected) || null;
}

function validateBackupEvidence(evidence) {
  const failures = [];
  if (evidence?.ok !== true) failures.push(evidence?.reason ? `backup not ok: ${evidence.reason}` : 'backup not ok');
  if (evidence?.strict !== true) failures.push('backup was not strict');
  if (evidence?.db_only !== true) failures.push('backup was not db-only');
  if (evidence?.db_snapshot_enabled !== true && evidence?.snapshot_dbs !== true) {
    failures.push('backup did not use SQLite snapshots');
  }
  if (evidence?.db_snapshot_method !== 'clone') failures.push('backup did not use clone snapshots');
  if (evidence?.strict_ok !== true) failures.push('backup strict_ok was not true');
  if (evidence?.db_synced !== true) failures.push('backup db_synced was not true');
  if (Array.isArray(evidence?.db_missing_required) && evidence.db_missing_required.length > 0) {
    failures.push(`backup missing required db files: ${evidence.db_missing_required.join(', ')}`);
  }
  for (const required of [MAIN_DB_BASENAME, VECTOR_DB_BASENAME]) {
    const snapshot = snapshotForBasename(evidence?.db_snapshots_created, required);
    if (!snapshot) {
      failures.push(`backup did not snapshot ${required}`);
    } else {
      if (snapshot.method !== 'clone') failures.push(`backup snapshot for ${required} was not a clone`);
      if (snapshot.verification?.ok !== true || snapshot.verification?.mode !== 'open_schema') {
        failures.push(`backup snapshot for ${required} did not have open-schema verification`);
      }
    }
    if (!hasBasename(evidence?.db_files_uploaded, required)) {
      failures.push(`backup did not upload ${required}`);
    }
    if (!hasBasename(evidence?.db_files_verified, required)) {
      failures.push(`backup did not verify ${required}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`GCS backup did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

// If a passing GCS backup result already exists on disk and is fresh (produced
// within BACKUP_REUSE_MAX_AGE_MS), return that evidence so the caller can reuse
// it instead of re-running the multi-hour db-snapshot upload. Returns null when
// no reusable evidence exists (missing file, stale, or fails validation) — in
// which case the caller runs a real backup. Freshness is measured from the
// durable result file's mtime, which the backup dispatcher writes on success.
function freshReusableBackupEvidence(path = BACKUP_RESULT_FILE, maxAgeMs = BACKUP_REUSE_MAX_AGE_MS) {
  const evidence = readJson(path);
  if (!evidence || typeof evidence !== 'object') return null;
  let ageMs = Infinity;
  try {
    ageMs = Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) return null;
  try {
    validateBackupEvidence(evidence);
  } catch {
    return null;
  }
  return { evidence, ageMs };
}

function validatePostDrainPreflightEvidence(evidence) {
  const failures = [];
  const projection = evidence?.global_ann_source_projection || {};
  const topicProjection = evidence?.topic_context_projection || {};
  const backupProjection = evidence?.backup_dispatcher_projection || {};
  const backupDryRun = backupProjection?.projection || {};
  const reclassifyProjection = evidence?.reclassify_projection || {};
  const reclassifyDryRun = reclassifyProjection?.projection || {};
  const memoryProjection = evidence?.memory_refocus_projection || {};
  const memoryDryRun = memoryProjection?.projection || {};
  const embedded = Number(projection.embedded_total);
  const readable = Number(projection.readable_vectors);
  const topicTotal = Number(topicProjection.total_topics);
  const topicCapacity = Number(topicProjection.capacity);
  const topicPending = Number(topicProjection.pending_now);
  const backupLockedCompatible = backupProjection.locked === true && backupProjection.lock_compatible === true;
  const reclassifyStatus = String(reclassifyDryRun.status || '');
  const memoryAfter = Number(memoryDryRun.after_current_needs_routing_links);
  const memoryThreshold = Number(memoryProjection.threshold);
  if (evidence?.ok !== true) failures.push('post-drain preflight not ok');
  if (evidence?.read_only !== true) failures.push('post-drain preflight was not read-only');
  if (!Array.isArray(evidence?.failures) || evidence.failures.length > 0) {
    failures.push('post-drain preflight reported failures or did not report failure list');
  }
  if (projection.ok !== true) failures.push('post-drain preflight ANN source projection not ok');
  if (!Number.isFinite(embedded) || embedded <= 0) {
    failures.push('post-drain preflight ANN source projection found no embedded chunks');
  }
  if (Number(projection.missing_vectors || 0) !== 0) {
    failures.push('post-drain preflight ANN source projection has missing vectors');
  }
  if (Number(projection.malformed_rows || 0) !== 0) {
    failures.push('post-drain preflight ANN source projection has malformed vectors');
  }
  if (Number.isFinite(embedded) && Number.isFinite(readable) && readable !== embedded) {
    failures.push('post-drain preflight ANN source readable count does not match embedded count');
  }
  if (topicProjection.ok !== true) failures.push('post-drain preflight topic context projection not ok');
  if (topicProjection.read_only !== true) failures.push('post-drain preflight topic context projection was not read-only');
  if (!Number.isFinite(topicTotal) || !Number.isFinite(topicCapacity) || topicCapacity < topicTotal) {
    failures.push('post-drain preflight topic context capacity cannot cover all topics');
  }
  if (!Number.isFinite(topicPending)) failures.push('post-drain preflight topic context projection did not report pending topics');
  if (backupProjection.ok !== true) failures.push('post-drain preflight backup dispatcher projection not ok');
  if (backupProjection.read_only !== true) failures.push('post-drain preflight backup dispatcher projection was not read-only');
  if (backupLockedCompatible) {
    if (backupProjection.lock_process_alive !== true) failures.push('post-drain preflight backup lock compatibility did not prove a live owner');
  } else {
    if (backupDryRun.action !== 'backup_to_gcp' || backupDryRun.dry_run !== true) {
      failures.push('post-drain preflight backup dispatcher projection was not a dry-run backup');
    }
    if (
      backupDryRun.db_only !== true
        || backupDryRun.snapshot_dbs !== true
        || backupDryRun.strict !== true
        || backupDryRun.strict_ok !== true
        || backupDryRun.db_snapshot_enabled !== true
        || backupDryRun.db_snapshot_method !== 'clone'
    ) {
      failures.push('post-drain preflight backup dispatcher projection did not enforce strict clone DB snapshots');
    }
    if (!Array.isArray(backupDryRun.db_missing_required) || backupDryRun.db_missing_required.length > 0) {
      failures.push('post-drain preflight backup dispatcher projection has missing required DBs');
    }
  }
  if (reclassifyProjection.ok !== true) failures.push('post-drain preflight reclassify projection not ok');
  if (reclassifyProjection.read_only !== true) failures.push('post-drain preflight reclassify projection was not read-only');
  if (reclassifyDryRun.ok !== true || reclassifyDryRun.dry_run !== true || reclassifyDryRun.skip_regen !== true) {
    failures.push('post-drain preflight reclassify projection did not run as dry-run no-regen');
  }
  if (!['partial_slice', 'complete'].includes(reclassifyStatus)) {
    failures.push('post-drain preflight reclassify projection reported invalid status');
  }
  if (!Array.isArray(reclassifyDryRun.passes) || reclassifyDryRun.passes.length === 0) {
    failures.push('post-drain preflight reclassify projection did not report pass evidence');
  }
  if (memoryProjection.ok !== true) failures.push('post-drain preflight memory refocus projection not ok');
  if (memoryProjection.read_only !== true) failures.push('post-drain preflight memory refocus projection was not read-only');
  if (memoryDryRun.ok !== true || memoryDryRun.applied !== false) {
    failures.push('post-drain preflight memory refocus projection did not run read-only');
  }
  if (memoryDryRun.partial !== false) failures.push('post-drain preflight memory refocus projection did not complete');
  if (!Number.isFinite(memoryAfter) || !Number.isFinite(memoryThreshold) || memoryAfter > memoryThreshold) {
    failures.push('post-drain preflight memory refocus projection does not clear unresolved links below threshold');
  }
  if (failures.length > 0) {
    throw new Error(`post-drain preflight did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

function validatePostDrainEmbedHoldEvidence(status) {
  const failures = [];
  const hold = status?.post_drain_embed_hold || {};
  const release = status?.post_drain_embed_hold_release || {};
  if (hold?.ok !== true) failures.push('post-drain embed writer hold was not acquired');
  if (hold?.hold_reason !== 'post_drain_pipeline_sole_writer') {
    failures.push('post-drain embed writer hold reason is not post_drain_pipeline_sole_writer');
  }
  if (release?.ok !== true || release?.skipped === true) {
    failures.push('post-drain embed writer hold was not released by its owner');
  }
  if (failures.length > 0) {
    throw new Error(`post-drain embed writer hold did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

function validateGlobalHnswEvidence(evidence) {
  const failures = [];
  if (evidence?.ok !== true) failures.push(evidence?.reason ? `global HNSW not ok: ${evidence.reason}` : 'global HNSW not ok');
  if (evidence?.artifact_complete !== true) failures.push('global HNSW artifacts are incomplete');
  if (Number(evidence?.meta?.dim) !== 1024) failures.push('global HNSW dim is not 1024');
  const fullSize = Number(evidence?.meta?.full_size) || 0;
  const builtFrom = Number(evidence?.meta?.built_from_count) || 0;
  const sourceEmbedded = Number(evidence?.meta?.source_embedded_count || builtFrom) || 0;
  if (fullSize <= 0 || builtFrom <= 0) failures.push('global HNSW build counts are empty');
  if (fullSize !== builtFrom) failures.push('global HNSW full_size does not match built_from_count');
  if (sourceEmbedded !== builtFrom) failures.push('global HNSW source_embedded_count does not match built_from_count');
  if (failures.length > 0) {
    throw new Error(`global HNSW rebuild did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

function validateReclassifyEvidence(evidence, { allowPartial = false } = {}) {
  const failures = [];
  if (evidence?.ok !== true) failures.push('reclassify not ok');
  if (evidence?.skip_regen !== true) failures.push('reclassify did not defer context regen');
  if (allowPartial) {
    if (evidence?.partial !== true || evidence?.status !== 'partial_slice') {
      failures.push('reclassify slice did not report an explicit partial result');
    }
  } else {
    if (evidence?.partial !== false || evidence?.status !== 'complete') {
      failures.push('reclassify final slice did not report complete');
    }
  }
  if (!Array.isArray(evidence?.passes)) failures.push('reclassify did not report pass summaries');
  if (failures.length > 0) {
    throw new Error(`reclassify did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

function validateMemoryRoutingRepairEvidence(evidence) {
  const failures = [];
  if (evidence?.ok !== true || evidence?.mode !== 'apply') failures.push('memory routing repair evidence is not applied');
  const after = evidence?.after || {};
  if (Number(after.drop_folder_personal_learning || 0) !== 0) failures.push('memory routing repair did not clear drop-folder personal/learning rows');
  if (Number(after.memory_unknown_topic_alias_links || 0) !== 0) failures.push('memory routing repair did not clear unknown-topic memory aliases');
  if (Number(after.memory_import_tags_as_topics || 0) !== 0) failures.push('memory routing repair did not convert import tags');
  if (failures.length > 0) {
    throw new Error(`memory routing repair did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

function validateSourceTopicMetadataRepairEvidence(evidence) {
  const failures = [];
  if (evidence?.ok !== true || evidence?.mode !== 'apply') failures.push('source topic metadata repair evidence is not applied');
  if (Number(evidence?.after?.drive_files?.personal || 0) !== 0) {
    failures.push('source topic metadata repair did not clear drive_files Personal rows');
  }
  if (Number(evidence?.after?.transcripts?.personal || 0) !== 0) {
    failures.push('source topic metadata repair did not clear transcripts Personal rows');
  }
  const remainingConversationPersonal = Number(
    evidence?.after?.conversations?.personal_non_user ?? evidence?.after?.conversations?.personal ?? 0,
  );
  if (remainingConversationPersonal !== 0) {
    failures.push('source topic metadata repair did not clear conversations Personal rows');
  }
  if (Number(evidence?.after?.conversations?.null_topic_non_user || 0) !== 0) {
    failures.push('source topic metadata repair did not clear conversations null-topic rows');
  }
  if (Number(evidence?.after?.resolvable_queue_metadata?.rows || 0) !== 0) {
    failures.push('source topic metadata repair left resolvable queue metadata rows');
  }
  if (failures.length > 0) {
    throw new Error(`source topic metadata repair did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

function validateMemoryRefocusEvidence(evidence, { allowPartial = false } = {}) {
  const failures = [];
  const before = Number(evidence?.before_current_needs_routing_links);
  const after = Number(evidence?.after_current_needs_routing_links);
  const movedEvents = Number(evidence?.moved_events);
  const suppressedEvents = Number(evidence?.suppressed_events);
  const skippedNoTopic = Number(evidence?.skipped_no_topic);
  if (evidence?.ok !== true) failures.push('memory refocus not ok');
  if (evidence?.applied !== true) failures.push('memory refocus did not run in apply mode');
  if (allowPartial) {
    if (evidence?.partial !== true) failures.push('memory refocus slice did not report an explicit partial result');
  } else if (evidence?.partial !== false) {
    failures.push('memory refocus final slice did not report complete');
  }
  if (!Number.isFinite(before)) {
    failures.push('memory refocus did not report before count');
  }
  if (!Number.isFinite(after)) {
    failures.push('memory refocus did not report after count');
  }
  if (Number.isFinite(before) && Number.isFinite(after) && after > before) {
    failures.push('memory refocus increased current needs-routing links');
  }
  if (!Number.isFinite(movedEvents)) failures.push('memory refocus did not report moved event count');
  if (!Number.isFinite(suppressedEvents)) failures.push('memory refocus did not report suppressed event count');
  if (!Number.isFinite(skippedNoTopic)) failures.push('memory refocus did not report skipped no-topic count');
  if (!Array.isArray(evidence?.moved_examples)) failures.push('memory refocus did not report moved examples');
  if (!Array.isArray(evidence?.suppressed_examples)) failures.push('memory refocus did not report suppressed examples');
  if (!Array.isArray(evidence?.skipped_examples)) failures.push('memory refocus did not report skipped examples');
  if (failures.length > 0) {
    throw new Error(`memory refocus did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

function validateMemoryRecalcEvidence(evidence) {
  const failures = [];
  if (evidence?.ok !== true) failures.push('memory recalc not ok');
  if (evidence?.scope !== 'all') failures.push('memory recalc was not global');
  if (!Array.isArray(evidence?.generated_tiers) || evidence.generated_tiers.length === 0) {
    failures.push('memory recalc did not report generated tiers');
  }
  if (!Number.isFinite(Number(evidence?.count))) failures.push('memory recalc did not report workbench count');
  if (failures.length > 0) {
    throw new Error(`memory recalc did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

function validateTopicContextEvidence(evidence, label = 'topic context regeneration') {
  const failures = [];
  const initialPending = Number(evidence?.initial_pending);
  const finalPending = Number(evidence?.final_pending);
  const slices = Number(evidence?.slices);
  const startedMs = Date.parse(String(evidence?.started_at || ''));
  const completedMs = Date.parse(String(evidence?.completed_at || ''));
  const sliceResults = Array.isArray(evidence?.slice_results) ? evidence.slice_results : null;
  const noopStep = evidence?.noop_step || null;
  if (evidence?.ok !== true) failures.push(`${label} not ok`);
  if (evidence?.dry_run === true || evidence?.pending_unmodified === true) failures.push(`${label} did not run in apply mode`);
  if (finalPending !== 0) failures.push(`${label} still has pending topics`);
  if (!Number.isFinite(initialPending)) failures.push(`${label} did not report initial pending count`);
  if (!Number.isFinite(slices)) failures.push(`${label} did not report slice count`);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    failures.push(`${label} has invalid timestamps`);
  }
  if (!sliceResults) failures.push(`${label} did not report slice results`);
  if (Number.isFinite(initialPending) && Number.isFinite(slices) && sliceResults) {
    if (initialPending <= 0) {
      if (slices !== 0) failures.push(`${label} reported slices despite no pending topics`);
      if (sliceResults.length !== 0) failures.push(`${label} reported slice results despite no pending topics`);
      if (noopStep?.ok !== true || noopStep?.noop !== true) failures.push(`${label} did not record noop evidence`);
    } else {
      if (slices <= 0) failures.push(`${label} did not run any slices despite pending topics`);
      if (sliceResults.length !== slices) failures.push(`${label} slice results do not match slice count`);
      sliceResults.forEach((row, index) => {
        const before = Number(row?.before_pending);
        const after = Number(row?.after_pending);
        const checkedMs = Date.parse(String(row?.checked_at || ''));
        if (Number(row?.slice) !== index + 1) failures.push(`${label} slice result order is invalid`);
        if (!Number.isFinite(before) || !Number.isFinite(after)) failures.push(`${label} slice result is missing pending counts`);
        if (Number.isFinite(before) && Number.isFinite(after) && after > before) {
          failures.push(`${label} pending count increased during regeneration`);
        }
        if (!Number.isFinite(checkedMs)) failures.push(`${label} slice result is missing checked_at`);
        if (index === 0 && Number.isFinite(before) && before !== initialPending) {
          failures.push(`${label} first slice does not start from initial pending count`);
        }
        if (index === sliceResults.length - 1 && Number.isFinite(after) && after !== finalPending) {
          failures.push(`${label} last slice does not end at final pending count`);
        }
      });
    }
  }
  if (failures.length > 0) {
    throw new Error(`${label} did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

function validateSplitVectorParityEvidence(evidence) {
  const failures = [];
  if (evidence?.ok !== true) failures.push('split-vector parity not ok');
  if (evidence?.reason !== 'split_vector_parity_ok') failures.push('split-vector parity did not check migrated topics');
  if (!Number.isFinite(Number(evidence?.migrated_topics)) || Number(evidence.migrated_topics) <= 0) {
    failures.push('split-vector parity did not report migrated topics');
  }
  if (Number(evidence?.missing_vectors || 0) !== 0) failures.push('split-vector parity has missing vectors');
  if (Number(evidence?.stale_vectors || 0) !== 0) failures.push('split-vector parity has stale vectors');
  if (Number(evidence?.malformed_tables || 0) !== 0) failures.push('split-vector parity has malformed vector tables');
  if (!Array.isArray(evidence?.by_topic) || evidence.by_topic.length === 0) {
    failures.push('split-vector parity did not report topic rows');
  }
  if (!evidence?.vector_table_audit || !Array.isArray(evidence.vector_table_audit.by_table)) {
    failures.push('split-vector parity did not audit vector table stale rows');
  }
  if (failures.length > 0) {
    throw new Error(`split-vector parity check did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

function validateSplitVectorRepairEvidence(evidence) {
  const failures = [];
  const copied = Number(evidence?.copied);
  const exactSource = Number(evidence?.exact_source);
  const ambientSource = Number(evidence?.ambient_source);
  const staleVectors = Number(evidence?.stale_vectors || 0);
  const stalePruned = Number(evidence?.stale_pruned || 0);
  const vectorRepair = evidence?.vector_table_repair || null;
  const vectorRepairStale = Number(vectorRepair?.stale_vectors);
  const vectorRepairPruned = Number(vectorRepair?.pruned);
  if (evidence?.ok !== true) failures.push('split-vector repair evidence is not ok');
  if (evidence?.dry_run !== false) failures.push('split-vector repair did not run in explicit apply mode');
  if (evidence?.reason !== 'split_vector_repair_ok') failures.push('split-vector repair did not report ok reason');
  if (!Number.isFinite(Number(evidence?.migrated_topics)) || Number(evidence.migrated_topics) <= 0) {
    failures.push('split-vector repair did not report migrated topics');
  }
  if (Number(evidence?.missing_source || 0) !== 0) failures.push('split-vector repair has missing source vectors');
  if (!Number.isFinite(copied) || !Number.isFinite(exactSource) || !Number.isFinite(ambientSource)) {
    failures.push('split-vector repair did not report source provenance counts');
  } else if (exactSource + ambientSource !== copied) {
    failures.push('split-vector repair source provenance counts do not match copied rows');
  }
  if (Number.isFinite(staleVectors) && Number.isFinite(stalePruned) && stalePruned !== staleVectors) {
    failures.push('split-vector repair pruned count does not equal stale vector count');
  }
  if (vectorRepair?.dry_run !== false) failures.push('split-vector vector-table repair did not run in explicit apply mode');
  if (Number.isFinite(vectorRepairStale) && vectorRepairStale !== staleVectors) {
    failures.push('split-vector repair stale vector count does not match vector-table audit');
  }
  if (Number.isFinite(vectorRepairPruned) && vectorRepairPruned !== stalePruned) {
    failures.push('split-vector repair pruned count does not match vector-table audit');
  }
  if (Number(evidence?.malformed_tables || 0) !== 0) failures.push('split-vector repair has malformed vector tables');
  if (!Array.isArray(evidence?.by_topic) || evidence.by_topic.length === 0) {
    failures.push('split-vector repair did not report topic rows');
  } else {
    for (const row of evidence.by_topic) {
      const copyable = Number(row?.copyable);
      const topicExact = Number(row?.exact_source);
      const topicAmbient = Number(row?.ambient_source);
      if (!Number.isFinite(copyable) || !Number.isFinite(topicExact) || !Number.isFinite(topicAmbient)) {
        failures.push(`split-vector repair topic row missing source provenance counts: ${row?.topic || 'unknown'}`);
        continue;
      }
      if (topicExact + topicAmbient !== copyable) {
        failures.push(`split-vector repair topic source counts do not match copyable rows: ${row?.topic || 'unknown'}`);
      }
    }
  }
  if (!vectorRepair || !Array.isArray(vectorRepair.by_table)) {
    failures.push('split-vector repair did not report vector table repair rows');
  } else {
    for (const row of vectorRepair.by_table) {
      const rowStale = Number(row?.stale_vectors || 0);
      const rowPruned = Number(row?.pruned || 0);
      if (Number.isFinite(rowStale) && Number.isFinite(rowPruned) && rowPruned !== rowStale) {
        failures.push(`split-vector repair vector-table pruned count does not equal stale count: ${row?.store || 'unknown'}:${row?.table || 'unknown'}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`split-vector repair did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

function validateRoutingResidueEvidence(evidence) {
  const failures = [];
  const thresholds = evidence?.thresholds || {};
  const maxPersonalPending = Number(thresholds.maxPersonalPending);
  const auditedMaxPersonalUnexplainedImports = Number(thresholds.maxPersonalUnexplainedImports);
  const auditedMaxPersonalSourceMetadataRows = Number(thresholds.maxPersonalSourceMetadataRows);
  const auditedMaxNeedsRoutingChunks = Number(thresholds.maxNeedsRoutingChunks);
  const auditedMaxNeedsRoutingMemory = Number(thresholds.maxNeedsRoutingMemory);
  if (evidence?.ok !== true) failures.push('routing residue audit not ok');
  if (evidence?.strict !== true) failures.push('routing residue audit did not run in strict mode');
  if (!Array.isArray(evidence?.failures)) {
    failures.push('routing residue audit did not report failure list');
  } else if (evidence.failures.length > 0) {
    failures.push(`routing residue audit reported failures: ${evidence.failures.join('; ')}`);
  }
  if (!Number.isFinite(maxPersonalPending) || maxPersonalPending !== 0) {
    failures.push('routing residue audit did not enforce zero Personal pending embeddings');
  }
  if (!Number.isFinite(auditedMaxPersonalUnexplainedImports) || auditedMaxPersonalUnexplainedImports > maxPersonalUnexplainedImports) {
    failures.push('routing residue Personal import threshold was missing or looser than configured');
  }
  if (!Number.isFinite(auditedMaxPersonalSourceMetadataRows) || auditedMaxPersonalSourceMetadataRows > maxPersonalSourceMetadataRows) {
    failures.push('routing residue Personal source metadata threshold was missing or looser than configured');
  }
  if (!Number.isFinite(auditedMaxNeedsRoutingChunks) || auditedMaxNeedsRoutingChunks > maxNeedsRoutingChunks) {
    failures.push('routing residue chunk threshold was missing or looser than configured');
  }
  if (!Number.isFinite(auditedMaxNeedsRoutingMemory) || auditedMaxNeedsRoutingMemory > maxNeedsRoutingMemory) {
    failures.push('routing residue memory threshold was missing or looser than configured');
  }
  if (Number(evidence?.personal?.pending_embeddings || 0) !== 0) failures.push('Personal still has pending embeddings');
  if (Number(evidence?.personal?.scope_review?.unexplained_import_chunks || 0) > maxPersonalUnexplainedImports) {
    failures.push('Personal still has unexplained import/container chunks');
  }
  if (Number(evidence?.personal?.source_metadata_review?.personal_rows || 0) > maxPersonalSourceMetadataRows) {
    failures.push('Personal still has source metadata rows');
  }
  if (Number(evidence?.needs_routing?.chunks || 0) > maxNeedsRoutingChunks) failures.push('needs-routing chunk residue is above launch threshold');
  if (Number(evidence?.needs_routing?.memory_links?.current_unresolved || 0) > maxNeedsRoutingMemory) {
    failures.push('needs-routing current memory residue is above launch threshold');
  }
  const resolutionReview = evidence?.needs_routing?.resolution_review || {};
  if (resolutionReview.required !== true) failures.push('needs-routing resolution review was not required');
  if (resolutionReview.ok !== true) failures.push('needs-routing resolution review did not pass');
  if (resolutionReview.complete !== true) failures.push('needs-routing resolution review did not scan every embedded chunk');
  if (Number(resolutionReview.missing_vectors || 0) !== 0) failures.push('needs-routing resolution review has missing vectors');
  if (Number(resolutionReview.resolvable_chunks || 0) !== 0) failures.push('needs-routing still has strongly classifiable chunks');
  if (!Array.isArray(evidence?.fallback_residue?.chunk_topics) || evidence.fallback_residue.chunk_topics.length > 0) {
    failures.push('forbidden fallback chunk topics remain or were not audited');
  }
  if (!Array.isArray(evidence?.fallback_residue?.memory_targets) || evidence.fallback_residue.memory_targets.length > 0) {
    failures.push('forbidden fallback memory targets remain or were not audited');
  }
  if (!Array.isArray(evidence?.fallback_residue?.source_topics) || evidence.fallback_residue.source_topics.length > 0) {
    failures.push('forbidden fallback source topics remain or were not audited');
  }
  if (failures.length > 0) {
    throw new Error(`routing residue audit did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

function finalProductProofFromReport(report, { repairCompletedAt, step = null }) {
  const failures = [];
  const checkedMs = Date.parse(String(report?.checked_at || ''));
  const repairCompletedMs = Date.parse(String(repairCompletedAt || ''));
  const proofStepStartedMs = Date.parse(String(step?.started_at || ''));
  const proofStepCompletedMs = Date.parse(String(step?.completed_at || ''));
  const proofStepArgs = Array.isArray(step?.args) ? step.args.map((arg) => String(arg)) : [];
  const requestedRows = Array.isArray(report?.options?.rows)
    ? report.options.rows.map((row) => String(row))
    : [];
  const proofStepCommandMatchesExpected = step?.command === process.execPath
    && proofStepArgs.length === FINAL_PRODUCT_PROOF_COMMAND_ARGS.length
    && FINAL_PRODUCT_PROOF_COMMAND_ARGS.every((arg, index) => proofStepArgs[index] === arg);
  const proofReportRowModeMatchesExpected = requestedRows.length === FINAL_PRODUCT_PROOF_REQUESTED_ROWS.length
    && FINAL_PRODUCT_PROOF_REQUESTED_ROWS.every((row, index) => requestedRows[index] === row);
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const byId = new Map(rows.map((row) => [row?.id, row]));
  const reportRowIds = rows.map((row) => String(row?.id || '')).filter(Boolean);
  const missingExpectedRowIds = FINAL_PRODUCT_PROOF_EXPECTED_ROW_IDS
    .filter((id) => !reportRowIds.includes(id));
  const reportFile = report?.report_path || FINAL_PRODUCT_PROOF_FILE;
  const snapshotFile = report?.snapshot_path || null;
  const reportFileMatchesExpected = resolve(String(reportFile || '')) === resolve(FINAL_PRODUCT_PROOF_FILE);
  const snapshotFileInsideExpectedDir = pathWithinDir(snapshotFile, FINAL_PRODUCT_PROOF_SNAPSHOT_DIR);
  const latestReport = reportFile ? readJson(reportFile) : null;
  const latestReportSha256 = reportFile && existsSync(reportFile) ? sha256File(reportFile) : null;
  const snapshotFileSha256 = snapshotFile && existsSync(snapshotFile) ? sha256File(snapshotFile) : null;
  const rowEvidence = {};
  if (report?.ok !== true) failures.push('launch stoplight final proof report is not ok');
  if (!Number.isFinite(checkedMs)) failures.push('launch stoplight final proof is missing checked_at');
  if (!Number.isFinite(repairCompletedMs)) failures.push('post-drain repair completion timestamp is missing');
  if (Number.isFinite(checkedMs) && Number.isFinite(repairCompletedMs) && checkedMs < repairCompletedMs) {
    failures.push('launch stoplight final proof predates post-drain repair completion');
  }
  if (!reportFileMatchesExpected) {
    failures.push('launch stoplight final proof report path is not the expected latest report file');
  }
  if (!snapshotFileInsideExpectedDir) {
    failures.push('launch stoplight final proof snapshot path is not inside the expected snapshot directory');
  }
  if (step?.id !== 'final_product_proof' || step?.ok !== true) {
    failures.push('launch stoplight final proof was not produced by the passing final_product_proof step');
  }
  if (!proofStepCommandMatchesExpected) {
    failures.push('launch stoplight final proof command did not match expected row-mode invocation');
  }
  if (!proofReportRowModeMatchesExpected) {
    failures.push('launch stoplight final proof did not request expected product proof rows');
  }
  if (missingExpectedRowIds.length > 0) {
    failures.push(`launch stoplight final proof did not run expected dependency rows: ${missingExpectedRowIds.join(', ')}`);
  }
  if (!Number.isFinite(proofStepStartedMs) || !Number.isFinite(proofStepCompletedMs) || proofStepCompletedMs < proofStepStartedMs) {
    failures.push('launch stoplight final proof step timestamps are invalid');
  } else if (Number.isFinite(checkedMs) && (checkedMs < proofStepStartedMs || checkedMs > proofStepCompletedMs)) {
    failures.push('launch stoplight final proof checked_at is outside the producing step window');
  }
  if (!latestReport) {
    failures.push('launch stoplight final proof latest report is missing');
  } else {
    if (latestReport.snapshot_path !== snapshotFile) {
      failures.push('launch stoplight final proof latest report does not point at the stored snapshot');
    }
    if (latestReport.checked_at !== report?.checked_at) {
      failures.push('launch stoplight final proof latest report checked_at does not match stored snapshot');
    }
    if (latestReport.ok !== report?.ok) {
      failures.push('launch stoplight final proof latest report ok flag does not match stored snapshot');
    }
  }
  if (!latestReportSha256 || !snapshotFileSha256 || latestReportSha256 !== snapshotFileSha256) {
    failures.push('launch stoplight final proof latest report file is not byte-identical to the stored snapshot');
  }
  for (const id of FINAL_PRODUCT_PROOF_ROWS) {
    const row = byId.get(id) || null;
    const deferredExactProof = rowDefersExactProof(row);
    const browserEntityCardProof = id === BROWSER_ENTITY_CARD_PROOF.row
      ? browserEntityCardProofFromRow(row)
      : null;
    const dataPlaneProof = row?.data_plane_proof && typeof row.data_plane_proof === 'object'
      ? row.data_plane_proof
      : row?.evidence?.data_plane_proof && typeof row.evidence.data_plane_proof === 'object'
        ? row.evidence.data_plane_proof
        : null;
    rowEvidence[id] = {
      status: row?.status || null,
      detail: row?.detail || null,
      duration_ms: row?.duration_ms ?? null,
      deferred_exact_proof: deferredExactProof,
      ...(browserEntityCardProof ? { browser_entity_card_proof: browserEntityCardProof } : {}),
      ...(dataPlaneProof ? { data_plane_proof: dataPlaneProof } : {}),
    };
    if (!row) failures.push(`launch stoplight final proof row did not run: ${id}`);
    else if (row.status !== 'green') failures.push(`launch stoplight final proof row is not green: ${id}=${row.status}`);
    else if (deferredExactProof) failures.push(`launch stoplight final proof row deferred exact proof: ${id}`);
    else if (id === BROWSER_ENTITY_CARD_PROOF.row && browserEntityCardProof?.ok !== true) {
      failures.push('launch stoplight browser product proof did not include seeded entity-card evidence');
    }
  }
  const dataPlaneProof = dataPlaneProofFromRows(rowEvidence);
  const {
    proof: dataPlaneProofPayload,
    ...dataPlaneProofVerdict
  } = dataPlaneProof;
  if (dataPlaneProofVerdict.ok !== true) {
    failures.push('launch stoplight final proof missing live data-plane boundary proof');
  }
  return {
    ok: failures.length === 0,
    report_ok: report?.ok === true,
    report_file: reportFile,
    expected_report_file: FINAL_PRODUCT_PROOF_FILE,
    report_file_matches_expected: reportFileMatchesExpected,
    snapshot_file: snapshotFile,
    expected_snapshot_dir: FINAL_PRODUCT_PROOF_SNAPSHOT_DIR,
    snapshot_file_inside_expected_dir: snapshotFileInsideExpectedDir,
    latest_report_file_exists: Boolean(latestReport),
    latest_report_checked_at: latestReport?.checked_at || null,
    latest_report_snapshot_path: latestReport?.snapshot_path || null,
    latest_report_matches_snapshot: Boolean(
      latestReport
        && latestReport.snapshot_path === snapshotFile
        && latestReport.checked_at === report?.checked_at
        && latestReport.ok === report?.ok,
    ),
    latest_report_sha256: latestReportSha256,
    snapshot_file_sha256: snapshotFileSha256,
    latest_report_hash_matches_snapshot: Boolean(
      latestReportSha256 && snapshotFileSha256 && latestReportSha256 === snapshotFileSha256,
    ),
    checked_at: report?.checked_at || null,
    repair_completed_at: repairCompletedAt || null,
    proof_step_id: step?.id || null,
    proof_step_ok: step?.ok === true,
    proof_step_started_at: step?.started_at || null,
    proof_step_completed_at: step?.completed_at || null,
    proof_step_duration_ms: step?.duration_ms ?? null,
    proof_step_command: step?.command || null,
    proof_step_args: proofStepArgs,
    proof_step_command_matches_expected: proofStepCommandMatchesExpected,
    proof_report_requested_rows: requestedRows,
    proof_report_row_mode_matches_expected: proofReportRowModeMatchesExpected,
    proof_report_row_ids: reportRowIds,
    expected_proof_report_row_ids: [...FINAL_PRODUCT_PROOF_EXPECTED_ROW_IDS],
    proof_report_contains_expected_rows: missingExpectedRowIds.length === 0,
    proof_report_missing_expected_rows: missingExpectedRowIds,
    proof_checked_at_within_step: Number.isFinite(checkedMs)
      && Number.isFinite(proofStepStartedMs)
      && Number.isFinite(proofStepCompletedMs)
      && proofStepStartedMs <= checkedMs
      && checkedMs <= proofStepCompletedMs,
    after_repair_completion: Number.isFinite(checkedMs)
      && Number.isFinite(repairCompletedMs)
      && checkedMs >= repairCompletedMs,
    required_rows: [...FINAL_PRODUCT_PROOF_ROWS],
    data_plane_proof: dataPlaneProofPayload,
    data_plane_proof_verdict: dataPlaneProofVerdict,
    rows: rowEvidence,
    failures,
  };
}

function dataPlaneProofFromRows(rows) {
  const candidates = [];
  for (const [id, row] of Object.entries(rows || {})) {
    if (row?.data_plane_proof && typeof row.data_plane_proof === 'object') {
      candidates.push({ source: `${id}.data_plane_proof`, proof: row.data_plane_proof });
    }
    if (row?.evidence?.data_plane_proof && typeof row.evidence.data_plane_proof === 'object') {
      candidates.push({ source: `${id}.evidence.data_plane_proof`, proof: row.evidence.data_plane_proof });
    }
  }
  const candidate = candidates.find(({ proof }) => proof?.ok === true) || candidates[0] || null;
  const proof = candidate?.proof || null;
  const required = Array.isArray(proof?.required_boundaries)
    ? proof.required_boundaries.map((item) => String(item))
    : [];
  const boundaries = proof?.boundaries && typeof proof.boundaries === 'object' ? proof.boundaries : {};
  const missingBoundaries = REQUIRED_DATA_PLANE_BOUNDARIES
    .filter((id) => !required.includes(id) || !boundaries[id]);
  const nonGreenBoundaries = REQUIRED_DATA_PLANE_BOUNDARIES
    .filter((id) => boundaries[id] && boundaries[id].ok !== true);
  const importChecks = boundaries.import_classification?.checks || {};
  const firstUseChecks = boundaries.first_use_context?.checks || {};
  const importClassificationOk = boundaries.import_classification?.ok === true
    && importChecks.unknown_started_uncategorized === true
    && importChecks.unknown_not_personal === true;
  const firstUseContextOk = boundaries.first_use_context?.ok === true
    && firstUseChecks.proof_chunk_pending_embedding === true
    && firstUseChecks.bounded_context_before_embedding === true;
  const ok = proof?.ok === true
    && missingBoundaries.length === 0
    && nonGreenBoundaries.length === 0
    && importClassificationOk
    && firstUseContextOk;
  return {
    present: Boolean(proof),
    ok,
    source: candidate?.source || null,
    required_boundaries: [...REQUIRED_DATA_PLANE_BOUNDARIES],
    missing_boundaries: missingBoundaries,
    non_green_boundaries: nonGreenBoundaries,
    import_classification_ok: importClassificationOk,
    first_use_context_ok: firstUseContextOk,
    proof,
  };
}

function browserEntityCardProofFromRow(row) {
  const evidence = row?.evidence || {};
  const contract = evidence?.entity_card_contract || {};
  const specs = Array.isArray(evidence?.specs) ? evidence.specs.map((item) => String(item)) : [];
  const markers = contract?.markers && typeof contract.markers === 'object' ? contract.markers : {};
  const proof = {
    required: true,
    spec: BROWSER_ENTITY_CARD_PROOF.spec,
    spec_listed: specs.includes(BROWSER_ENTITY_CARD_PROOF.spec),
    result_ok: evidence?.result?.ok === true,
    contract_ok: contract?.ok === true,
    markers: {
      test_name: markers.test_name === true,
      seed_marker: markers.seed_marker === true,
      network_question: markers.network_question === true,
      direct_find_question: markers.direct_find_question === true,
      negative_premise_question: markers.negative_premise_question === true,
      expected_answer: markers.expected_answer === true,
    },
  };
  proof.ok = proof.spec_listed
    && proof.result_ok
    && proof.contract_ok
    && Object.values(proof.markers).every(Boolean);
  return proof;
}

function rowDefersExactProof(row) {
  const evidence = row?.evidence || {};
  if (evidence?.active_drain_block?.blocked_by_active_embedding_drain === true) return true;
  if (evidence?.active_drain_block?.exact_ann_proof_deferred === true) return true;
  if (evidence?.data_plane_proof?.active_drain_block?.blocked_by_active_embedding_drain === true) return true;
  if (evidence?.blocked_by_active_embedding_drain === true) return true;
  return /active embedding drain|proof n\/a|exact proof n\/a|exact_ann_proof_deferred/i.test(
    `${row?.detail || ''} ${evidence?.active_drain_block?.next_action || ''}`,
  );
}

function parseJsonObjectFromStdout(text, label) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error(`${label} did not print JSON to stdout`);
  try {
    return JSON.parse(raw);
  } catch {}
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let best = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      try {
        const parsed = JSON.parse(raw.slice(start, i + 1));
        if (parsed && typeof parsed === 'object' && parsed.snapshot_path) best = parsed;
      } catch {}
      start = -1;
    }
  }
  if (best) return best;
  throw new Error(`${label} stdout did not contain a parseable JSON object with snapshot_path`);
}

function finalProductProofReportFromStep(step) {
  const stdoutPayload = parseJsonObjectFromStdout(step?.stdout_tail, 'final product proof');
  const snapshotPath = stdoutPayload?.snapshot_path || null;
  if (!snapshotPath) {
    throw new Error('final product proof stdout did not include a snapshot_path');
  }
  const snapshot = readRequiredStepJsonResult(snapshotPath, 'final_product_proof_snapshot');
  if (snapshot?.snapshot_path !== snapshotPath) {
    throw new Error('final product proof snapshot_path does not match stdout payload');
  }
  if (snapshot?.checked_at !== stdoutPayload?.checked_at) {
    throw new Error('final product proof snapshot checked_at does not match stdout payload');
  }
  return snapshot;
}

function validateFinalProductProofEvidence(evidence) {
  const failures = [];
  if (evidence?.ok !== true) failures.push('final product proof evidence is not ok');
  if (evidence?.report_ok !== true) failures.push('final product proof report is not ok');
  if (!evidence?.report_file) failures.push('final product proof latest report file is missing');
  if (evidence?.report_file_matches_expected !== true) {
    failures.push('final product proof report path was not the expected latest report file');
  }
  if (!evidence?.snapshot_file) failures.push('final product proof snapshot file is missing');
  if (evidence?.snapshot_file && !existsSync(evidence.snapshot_file)) failures.push('final product proof snapshot file does not exist');
  if (evidence?.snapshot_file_inside_expected_dir !== true) {
    failures.push('final product proof snapshot path was not inside the expected snapshot directory');
  }
  if (evidence?.latest_report_file_exists !== true) failures.push('final product proof latest report file did not exist when proof ran');
  if (evidence?.latest_report_matches_snapshot !== true) {
    failures.push('final product proof latest report did not match the stored snapshot when proof ran');
  }
  if (evidence?.latest_report_hash_matches_snapshot !== true) {
    failures.push('final product proof latest report file was not byte-identical to the stored snapshot when proof ran');
  }
  if (evidence?.proof_step_id !== 'final_product_proof' || evidence?.proof_step_ok !== true) {
    failures.push('final product proof was not tied to a passing final_product_proof step');
  }
  if (evidence?.proof_step_command_matches_expected !== true) {
    failures.push('final product proof command did not match expected row-mode invocation');
  }
  if (evidence?.proof_report_row_mode_matches_expected !== true) {
    failures.push('final product proof report was not row-mode retrieval_sentinel; final product proof did not request expected product proof rows');
  }
  if (evidence?.proof_report_contains_expected_rows !== true) {
    failures.push('final product proof did not run expected dependency rows');
  }
  if (evidence?.proof_checked_at_within_step !== true) {
    failures.push('final product proof checked_at was not within the producing step window');
  }
  if (evidence?.after_repair_completion !== true) failures.push('final product proof did not run after post-drain repair completion');
  if (evidence?.data_plane_proof_verdict?.ok !== true) {
    const verdict = evidence?.data_plane_proof_verdict || {};
    const detail = [
      ...(Array.isArray(verdict.missing_boundaries) ? verdict.missing_boundaries.map((id) => `missing:${id}`) : []),
      ...(Array.isArray(verdict.non_green_boundaries) ? verdict.non_green_boundaries.map((id) => `red:${id}`) : []),
      verdict.import_classification_ok === true ? null : 'import_classification_checks_failed',
      verdict.first_use_context_ok === true ? null : 'first_use_context_checks_failed',
    ].filter(Boolean).join(', ');
    failures.push(`final product proof missing live data-plane boundary proof${detail ? `: ${detail}` : ''}`);
  }
  for (const id of FINAL_PRODUCT_PROOF_ROWS) {
    if (evidence?.rows?.[id]?.status !== 'green') {
      failures.push(`final product proof row is not green: ${id}`);
    }
    if (evidence?.rows?.[id]?.deferred_exact_proof === true) {
      failures.push(`final product proof row deferred exact proof: ${id}`);
    }
  }
  if (Array.isArray(evidence?.failures) && evidence.failures.length > 0) {
    failures.push(`final product proof reported failures: ${evidence.failures.join('; ')}`);
  }
  if (failures.length > 0) {
    throw new Error(`final product proof did not produce passing durable evidence: ${failures.join('; ')}`);
  }
}

function collectValidationFailure(failures, label, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`${label}: ${err?.message || String(err)}`);
  }
}

function validateStepHistoryEvidence(status) {
  const failures = [];
  const history = Array.isArray(status?.step_history) ? status.step_history : null;
  if (!history || history.length === 0) {
    throw new Error('post-drain step history is missing');
  }
  const requiredTail = [
    { label: 'post-drain preflight', match: (id) => id === 'post_drain_preflight' },
    { label: 'GCS backup', match: (id) => id === 'gcs_backup' },
    { label: 'chunk reclassification', match: (id) => /^reclassify_chunks_\d+$/.test(id) },
    { label: 'split-vector orphan repair', match: (id) => id === 'split_vec_orphan_repair_after_reclassify' },
    { label: 'split-vector parity check', match: (id) => id === 'vec_orphan_check_after_reclassify' },
    { label: 'source topic metadata repair', match: (id) => id === 'source_topic_metadata_repair' },
    { label: 'topic context regeneration', match: (id) => /^topic_context_(dry_run|noop|\d+)$/.test(id) },
    { label: 'global HNSW rebuild', match: (id) => id === 'global_hnsw_rebuild' },
    { label: 'memory routing repair', match: (id) => id === 'memory_routing_repair' },
    { label: 'memory refocus', match: (id) => /^memory_refocus_\d+$/.test(id) },
    { label: 'memory recalc', match: (id) => id === 'memory_recalc' },
    { label: 'post-memory topic context regeneration', match: (id) => /^post_memory_topic_context_(dry_run|noop|\d+)$/.test(id) },
    { label: 'routing residue audit', match: (id) => id === 'routing_residue_audit' },
    { label: 'final product proof', match: (id) => id === 'final_product_proof' },
  ];
  let cursor = -1;
  for (const required of requiredTail) {
    const index = history.findIndex((step, i) => (
      i > cursor
        && step?.ok === true
        && required.match(String(step?.id || ''))
    ));
    if (index === -1) {
      failures.push(`post-drain step history missing ordered passing ${required.label}`);
      continue;
    }
    const step = history[index];
    const startedMs = Date.parse(String(step.started_at || ''));
    const completedMs = Date.parse(String(step.completed_at || ''));
    if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
      failures.push(`post-drain step history has invalid timestamps for ${required.label}`);
    }
    cursor = index;
  }
  const lastHistory = history[history.length - 1] || null;
  if (status?.last_step?.id !== lastHistory?.id || status?.last_step?.ok !== lastHistory?.ok) {
    failures.push('post-drain last_step does not match step history tail');
  }
  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
}

function validateRunnerCodeEvidence(status) {
  const failures = [];
  const reported = status?.runner_code || {};
  if (!reported.sha256) failures.push('post-drain completion runner code version is not reported');
  if (reported.path && resolve(String(reported.path)) !== SCRIPT_PATH) {
    failures.push('post-drain completion runner code path does not match current runner');
  }
  if (reported.sha256 && reported.sha256 !== RUNNER_CODE_SHA256) {
    failures.push('post-drain completion was produced by stale runner code');
  }
  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
}

function postDrainCompletionEvidenceFromStatus(status) {
  const failures = [];
  const finalProductStepComplete = status?.last_step?.id === 'final_product_proof' && status.last_step.ok === true;
  const completionClaimed = status?.status === 'complete' || finalProductStepComplete;
  if (!completionClaimed) failures.push('status is not complete and final product proof did not pass');
  if (status?.readiness?.handoff_required !== false && status?.readiness?.handoff_launchd_clearance?.ok !== true) {
    failures.push('post-drain readiness did not prove temporary launchd drain was cleared');
  }
  if (status?.pre_backup_backlog_check?.ok !== true || Number(status?.pre_backup_backlog_check?.pending_embeddings ?? -1) !== 0) {
    failures.push('pre-backup backlog check is missing or not zero');
  }
  if (status?.pre_gcs_backup_backlog_check?.ok !== true || Number(status?.pre_gcs_backup_backlog_check?.pending_embeddings ?? -1) !== 0) {
    failures.push('pre-GCS-backup backlog check is missing or not zero');
  }
  if (status?.pre_gcs_backup_source_quiescence?.ok !== true || Number(status?.pre_gcs_backup_source_quiescence?.active_running ?? -1) !== 0) {
    failures.push('pre-GCS-backup source quiescence proof is missing or not quiet');
  }
  if (status?.pre_reclassify_backlog_check?.ok !== true || Number(status?.pre_reclassify_backlog_check?.pending_embeddings ?? -1) !== 0) {
    failures.push('pre-reclassify backlog check is missing or not zero');
  }
  if (status?.pre_reclassify_source_quiescence?.ok !== true || Number(status?.pre_reclassify_source_quiescence?.active_running ?? -1) !== 0) {
    failures.push('pre-reclassify source quiescence proof is missing or not quiet');
  }
  if (status?.pre_topic_context_backlog_check?.ok !== true || Number(status?.pre_topic_context_backlog_check?.pending_embeddings ?? -1) !== 0) {
    failures.push('pre-topic-context backlog check is missing or not zero');
  }
  if (status?.pre_global_hnsw_backlog_check?.ok !== true || Number(status?.pre_global_hnsw_backlog_check?.pending_embeddings ?? -1) !== 0) {
    failures.push('pre-global-HNSW backlog check is missing or not zero');
  }
  if (status?.pre_post_memory_topic_context_backlog_check?.ok !== true || Number(status?.pre_post_memory_topic_context_backlog_check?.pending_embeddings ?? -1) !== 0) {
    failures.push('pre-post-memory-topic-context backlog check is missing or not zero');
  }
  if (status?.chunk_source_quiescence?.ok !== true || Number(status?.chunk_source_quiescence?.active_running ?? -1) !== 0) {
    failures.push('chunk source quiescence proof is missing or not quiet');
  }
  if (status?.pre_topic_context_source_quiescence?.ok !== true || Number(status?.pre_topic_context_source_quiescence?.active_running ?? -1) !== 0) {
    failures.push('pre-topic-context source quiescence proof is missing or not quiet');
  }
  if (status?.pre_global_hnsw_source_quiescence?.ok !== true || Number(status?.pre_global_hnsw_source_quiescence?.active_running ?? -1) !== 0) {
    failures.push('pre-global-HNSW source quiescence proof is missing or not quiet');
  }
  if (status?.pre_post_memory_topic_context_source_quiescence?.ok !== true || Number(status?.pre_post_memory_topic_context_source_quiescence?.active_running ?? -1) !== 0) {
    failures.push('pre-post-memory-topic-context source quiescence proof is missing or not quiet');
  }
  if (status?.pre_routing_audit_source_quiescence?.ok !== true || Number(status?.pre_routing_audit_source_quiescence?.active_running ?? -1) !== 0) {
    failures.push('pre-routing-audit source quiescence proof is missing or not quiet');
  }
  if (status?.pre_routing_audit_backlog_check?.ok !== true || Number(status?.pre_routing_audit_backlog_check?.pending_embeddings ?? -1) !== 0) {
    failures.push('pre-routing-audit backlog check is missing or not zero');
  }
  if (status?.preflight_backup_slot?.ok !== true) {
    failures.push('preflight backup slot clearance proof is missing');
  }
  if (status?.backup_slot?.ok !== true) {
    failures.push('backup slot clearance proof is missing');
  }
  collectValidationFailure(failures, 'runner_code', () => validateRunnerCodeEvidence(status));
  collectValidationFailure(failures, 'post_drain_embed_hold', () => validatePostDrainEmbedHoldEvidence(status));
  collectValidationFailure(failures, 'post_drain_preflight', () => validatePostDrainPreflightEvidence(status?.post_drain_preflight));
  collectValidationFailure(failures, 'gcs_backup', () => validateBackupEvidence(status?.gcs_backup));
  collectValidationFailure(failures, 'reclassify', () => validateReclassifyEvidence(status?.reclassify?.last, { allowPartial: false }));
  collectValidationFailure(failures, 'split_vector_repair', () => validateSplitVectorRepairEvidence(status?.split_vec_orphan_repair_after_reclassify));
  collectValidationFailure(failures, 'split_vector_parity', () => validateSplitVectorParityEvidence(status?.vec_orphan_check_after_reclassify));
  collectValidationFailure(failures, 'source_topic_metadata_repair', () => validateSourceTopicMetadataRepairEvidence(status?.source_topic_metadata_repair));
  collectValidationFailure(failures, 'topic_contexts', () => validateTopicContextEvidence(status?.topic_contexts, 'topic context regeneration'));
  collectValidationFailure(failures, 'global_hnsw_rebuild', () => validateGlobalHnswEvidence(status?.global_hnsw_rebuild));
  collectValidationFailure(failures, 'memory_routing_repair', () => validateMemoryRoutingRepairEvidence(status?.memory_routing_repair));
  collectValidationFailure(failures, 'memory_refocus', () => validateMemoryRefocusEvidence(status?.memory_refocus?.last, { allowPartial: false }));
  collectValidationFailure(failures, 'memory_recalc', () => validateMemoryRecalcEvidence(status?.memory_recalc));
  collectValidationFailure(failures, 'post_memory_topic_contexts', () => validateTopicContextEvidence(status?.post_memory_topic_contexts, 'post-memory topic context regeneration'));
  collectValidationFailure(failures, 'routing_residue_audit', () => validateRoutingResidueEvidence(status?.routing_residue_audit));
  collectValidationFailure(failures, 'final_product_proof', () => validateFinalProductProofEvidence(status?.final_product_proof));
  collectValidationFailure(failures, 'step_history', () => validateStepHistoryEvidence(status));
  if (!finalProductStepComplete) {
    failures.push('last step is not a passing final product proof');
  }
  if (status?.final_backlog_check?.ok !== true || Number(status?.final_backlog_check?.pending_embeddings ?? -1) !== 0) {
    failures.push('final backlog check is missing or not zero');
  }
  if (status?.post_product_proof_source_quiescence?.ok !== true || Number(status?.post_product_proof_source_quiescence?.active_running ?? -1) !== 0) {
    failures.push('post-product-proof source quiescence proof is missing or not quiet');
  }
  if (status?.post_product_proof_backlog_check?.ok !== true || Number(status?.post_product_proof_backlog_check?.pending_embeddings ?? -1) !== 0) {
    failures.push('post-product-proof backlog check is missing or not zero');
  }
  return { ok: failures.length === 0, failures };
}

async function postDrainCompletionEvidenceWithLiveBacklog(status) {
  const evidence = postDrainCompletionEvidenceFromStatus(status);
  try {
    const pending = await pendingBacklogCount();
    evidence.live_pending_embeddings = pending;
    if (pending !== 0) {
      evidence.ok = false;
      evidence.failures.push(`live embeddable backlog is not zero after post-drain completion (${pending})`);
    }
  } catch (err) {
    evidence.ok = false;
    evidence.failures.push(`live embeddable backlog count failed after post-drain completion: ${err?.message || String(err)}`);
  }
  return evidence;
}

function handoffReadyFailures(handoff, { requireFresh = true } = {}) {
  const failures = [];
  const checkedAge = ageMs(handoff?.checked_at);
  if (handoff?.ok !== true) failures.push('handoff ok flag is not true');
  if (handoff?.status !== 'ready_for_reclassify') failures.push('handoff status is not ready_for_reclassify');
  if (handoff?.child_ok !== true) failures.push('handoff child_ok flag is not true');
  if (Number(handoff?.pending_embeddings) !== 0) failures.push('handoff pending embeddings is not zero');
  if (handoff?.pending_count_error) failures.push(`handoff pending count error: ${handoff.pending_count_error}`);
  if (checkedAge === null) {
    failures.push('handoff checked_at is missing or invalid');
  } else if (requireFresh && checkedAge > maxReadyHandoffAgeMs) {
    failures.push(`handoff ready marker is stale (${checkedAge}ms > ${maxReadyHandoffAgeMs}ms)`);
  }
  return failures;
}

function handoffIsReady(handoff, options = {}) {
  return handoffReadyFailures(handoff, options).length === 0;
}

function launchdLabelEvidence(label) {
  const result = spawnSync('launchctl', ['list'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 5000,
  });
  const lines = String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const present = result.status === 0
    ? lines.some((line) => line.split(/\s+/).at(-1) === label)
    : null;
  return {
    ok: result.status === 0,
    label,
    present,
    status: result.status,
    signal: result.signal || null,
    stderr: String(result.stderr || '').trim(),
  };
}

function handoffLaunchdClearance(handoff) {
  const label = handoff?.launchd_label || null;
  const removal = handoff?.launchd_remove || null;
  if (!label) {
    return { ok: true, required: false, reason: 'no_label' };
  }
  if (removal?.ok === true) {
    return { ok: true, required: true, label, reason: 'handoff_remove_ok', launchd_remove: removal };
  }
  const launchd = launchdLabelEvidence(label);
  if (launchd.ok === true && launchd.present === false) {
    return { ok: true, required: true, label, reason: 'label_absent', launchd_remove: removal, launchd };
  }
  return {
    ok: false,
    required: true,
    label,
    reason: launchd.ok === true ? 'label_still_present' : 'launchctl_unavailable',
    launchd_remove: removal,
    launchd,
  };
}

function handoffIsConsumed(handoff) {
  return handoff?.status === 'post_drain_complete'
    && handoff?.post_drain?.status === 'complete';
}

function handoffMatchesReadiness(handoff, status) {
  const prev = status?.readiness;
  return handoffIsReady(handoff, { requireFresh: false })
    && prev?.handoff_status === handoff.status
    && (prev?.handoff_required === false || prev?.handoff_launchd_clearance?.ok === true)
    && prev?.handoff_checked_at
    && handoff?.checked_at
    && prev.handoff_checked_at === handoff.checked_at;
}

async function currentHandoffAlreadyProcessed() {
  const handoff = readJson(HANDOFF_FILE);
  const status = readJson(STATUS_FILE);
  if (!handoffMatchesReadiness(handoff, status)) return null;
  const evidence = await postDrainCompletionEvidenceWithLiveBacklog(status);
  if (!evidence.ok) return null;
  return { handoff, status, reason: 'completion_evidence_passed', evidence };
}

function consumedHandoffEvidenceFailures(handoff, status) {
  const failures = [];
  if (handoff?.post_drain?.status_file !== STATUS_FILE) failures.push('handoff completion did not reference this post-drain status file');
  if (handoff?.post_drain?.log_file !== LOG_PATH) failures.push('handoff completion did not reference this post-drain log file');
  if (handoff?.post_drain?.previous_status !== 'ready_for_reclassify') failures.push('handoff completion did not consume a ready handoff');
  const statusCompletedMs = Date.parse(String(status?.completed_at || ''));
  const handoffCompletedMs = Date.parse(String(handoff?.post_drain?.completed_at || ''));
  if (!Number.isFinite(statusCompletedMs)) failures.push('post-drain status is missing a valid completed_at');
  if (!Number.isFinite(handoffCompletedMs)) failures.push('handoff completion is missing a valid completed_at');
  if (Number.isFinite(statusCompletedMs) && Number.isFinite(handoffCompletedMs) && handoffCompletedMs < statusCompletedMs) {
    failures.push('handoff completion timestamp predates post-drain completion status');
  }
  const consumedCheckedAt = handoff?.post_drain?.previous_checked_at || null;
  const readinessCheckedAt = status?.readiness?.handoff_checked_at || null;
  if (!consumedCheckedAt || !readinessCheckedAt || consumedCheckedAt !== readinessCheckedAt) {
    failures.push('handoff completion does not match post-drain readiness handoff');
  }
  return failures;
}

async function currentConsumedHandoffHasEvidence() {
  const handoff = readJson(HANDOFF_FILE);
  const status = readJson(STATUS_FILE);
  if (!handoffIsConsumed(handoff)) return null;
  const evidence = await postDrainCompletionEvidenceWithLiveBacklog(status);
  const handoffFailures = consumedHandoffEvidenceFailures(handoff, status);
  if (handoffFailures.length > 0) {
    evidence.ok = false;
    evidence.failures = [...evidence.failures, ...handoffFailures];
  }
  return {
    ok: evidence.ok,
    handoff,
    status,
    reason: evidence.ok ? 'consumed_handoff_evidence_passed' : 'consumed_handoff_missing_completion_evidence',
    evidence,
  };
}

function markHandoffConsumed({ recoveredFrom = null, completedAt = new Date().toISOString() } = {}) {
  const handoff = readJson(HANDOFF_FILE) || {};
  atomicWriteJson(HANDOFF_FILE, {
    ...handoff,
    status: 'post_drain_complete',
    post_drain: {
      status: 'complete',
      completed_at: completedAt,
      pid: process.pid,
      status_file: STATUS_FILE,
      log_file: LOG_PATH,
      recovered_from: recoveredFrom,
      previous_status: handoff.status || null,
      previous_checked_at: handoff.checked_at || null,
    },
  });
}

function atomicWriteJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
}

function log(line) {
  const msg = `[post-drain] ${new Date().toISOString()} ${line}`;
  appendFileSync(LOG_PATH, `${msg}\n`);
  console.log(msg);
}

function statusEnvelope(patch) {
  return {
    ...patch,
    pid: process.pid,
    runner_code: {
      path: SCRIPT_PATH,
      sha256: RUNNER_CODE_SHA256,
    },
    updated_at: new Date().toISOString(),
  };
}

function clearCurrentStepFields(patch = {}) {
  return {
    ...patch,
    current_step: null,
    current_step_pid: null,
    current_step_started_at: null,
    current_step_heartbeat_at: null,
    current_step_attempt: null,
    current_step_attempts: null,
  };
}

function inlineStepStatus(id, startedAt, patch = {}) {
  return {
    ...patch,
    status: 'running',
    current_step: id,
    current_step_pid: process.pid,
    current_step_started_at: startedAt,
    current_step_heartbeat_at: new Date().toISOString(),
    current_step_attempt: null,
    current_step_attempts: null,
  };
}

function writeInlineStepProgress(id, startedAt, patch = {}) {
  writeStatus(inlineStepStatus(id, startedAt, patch));
}

function writeFreshStatus(patch) {
  atomicWriteJson(STATUS_FILE, statusEnvelope(patch));
}

function writeStatus(patch) {
  const prev = readJson(STATUS_FILE) || {};
  atomicWriteJson(STATUS_FILE, {
    ...prev,
    ...statusEnvelope(patch),
  });
}

function recordStepResult(result) {
  const prev = readJson(STATUS_FILE) || {};
  const history = Array.isArray(prev.step_history) ? prev.step_history : [];
  const nextHistory = [...history, result].slice(-100);
  atomicWriteJson(STATUS_FILE, {
    ...clearCurrentStepFields({
      ...prev,
      last_step: result,
      step_history: nextHistory,
      pid: process.pid,
      runner_code: {
        path: SCRIPT_PATH,
        sha256: RUNNER_CODE_SHA256,
      },
      updated_at: new Date().toISOString(),
    }),
  });
}

function tryAcquireLock() {
  for (;;) {
    if (!existsSync(LOCK_PATH)) {
      try {
        lockFd = openSync(LOCK_PATH, 'wx');
        writeFileSync(lockFd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
        return { ok: true };
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
      }
    }
    const current = readJson(LOCK_PATH);
    if (current?.pid && processAlive(current.pid)) {
      return { ok: false, reason: 'live_lock', owner_pid: current.pid };
    }
    try { rmSync(LOCK_PATH, { force: true }); } catch {}
  }
}

async function acquireLock() {
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    const result = tryAcquireLock();
    if (result.ok) {
      writeStatus({ lock_acquired_at: new Date().toISOString(), lock_wait_ms: lockWaitMs });
      return;
    }
    if (Date.now() >= deadline || once) {
      writeStatus({
        status: 'blocked_by_lock',
        lock_owner_pid: result.owner_pid || null,
        lock_path: LOCK_PATH,
      });
      throw new Error(`post-drain runner already active: pid=${result.owner_pid || 'unknown'}`);
    }
    log(`lock held by pid=${result.owner_pid}; waiting`);
    await sleep(lockPollMs);
  }
}

function releaseLock() {
  if (lockFd !== null) {
    try { closeSync(lockFd); } catch {}
    lockFd = null;
  }
  try { rmSync(LOCK_PATH, { force: true }); } catch {}
}

function backupSlotEvidence() {
  if (!existsSync(BACKUP_LOCK_FILE)) {
    return {
      ok: true,
      lock_path: BACKUP_LOCK_FILE,
      present: false,
      pid: null,
      process_alive: false,
    };
  }
  let raw = '';
  try {
    raw = readFileSync(BACKUP_LOCK_FILE, 'utf8').trim();
  } catch (err) {
    return {
      ok: false,
      lock_path: BACKUP_LOCK_FILE,
      present: true,
      pid: null,
      process_alive: null,
      error: err?.message || String(err),
    };
  }
  const pid = Number.parseInt(raw, 10);
  const alive = Number.isFinite(pid) && pid > 0 && processAlive(pid);
  if (!alive) {
    try { rmSync(BACKUP_LOCK_FILE, { force: true }); } catch {}
    return {
      ok: true,
      lock_path: BACKUP_LOCK_FILE,
      present: false,
      stale_cleared: true,
      pid: Number.isFinite(pid) ? pid : null,
      process_alive: false,
    };
  }
  return {
    ok: false,
    lock_path: BACKUP_LOCK_FILE,
    present: true,
    pid,
    process_alive: true,
  };
}

async function waitForBackupSlot(label) {
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + backupSlotWaitMs;
  writeInlineStepProgress(label, startedAt);
  for (;;) {
    const evidence = backupSlotEvidence();
    const waitedMs = Math.max(0, Date.now() - Date.parse(startedAt));
    const payload = {
      ...evidence,
      started_at: startedAt,
      checked_at: new Date().toISOString(),
      waited_ms: waitedMs,
      max_wait_ms: backupSlotWaitMs,
      poll_ms: backupSlotPollMs,
    };
    writeInlineStepProgress(label, startedAt, { [label]: payload });
    if (evidence.ok) {
      writeStatus(clearCurrentStepFields({ [label]: payload }));
      return payload;
    }
    if (Date.now() >= deadline || once) {
      throw new Error(`backup slot is still locked by pid=${evidence.pid || 'unknown'} before ${label}`);
    }
    log(`waiting for backup slot before ${label}: pid=${evidence.pid || 'unknown'}`);
    await sleep(backupSlotPollMs);
  }
}

async function pendingBacklogCount() {
  const { default: db } = await import(resolve(ROOT, 'lib/db.js'));
  return Number(db.prepare(`
    SELECT COUNT(*) AS n
    FROM chunks
    WHERE COALESCE(embedded, 0) = 0
      AND COALESCE(skip_embed, 0) = 0
  `).get()?.n || 0);
}

async function assertBacklogStillDrained(label) {
  const startedAt = new Date().toISOString();
  writeInlineStepProgress(label, startedAt);
  let pending = null;
  try {
    pending = await pendingBacklogCount();
  } catch (err) {
    const evidence = {
      ok: false,
      label,
      pending_embeddings: null,
      error: err?.message || String(err),
      checked_at: new Date().toISOString(),
    };
    writeInlineStepProgress(label, startedAt, { [label]: evidence });
    throw err;
  }
  const evidence = {
    ok: pending === 0,
    label,
    pending_embeddings: pending,
    checked_at: new Date().toISOString(),
  };
  writeInlineStepProgress(label, startedAt, { [label]: evidence });
  if (!evidence.ok) {
    throw new Error(`${label}: embeddable backlog is no longer zero (${pending}); rerun the embedding drain before consuming the handoff`);
  }
  writeStatus(clearCurrentStepFields({ [label]: evidence }));
  return evidence;
}

async function runningChunkSourceScans() {
  const { default: db } = await import(resolve(ROOT, 'lib/db.js'));
  return db.prepare(`
    SELECT id,
           unique_key,
           lease_owner,
           lease_expires_at,
           started_at,
           updated_at
    FROM passive_jobs
    WHERE job_type = 'chunk_source_scan'
      AND status = 'running'
    ORDER BY updated_at DESC
    LIMIT 10
  `).all();
}

async function waitForChunkSourceQuiescence(label = 'chunk_source_quiescence') {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  writeInlineStepProgress(label, startedAtIso);
  for (;;) {
    const running = await runningChunkSourceScans();
    const evidence = {
      ok: running.length === 0,
      label,
      active_running: running.length,
      rows: running,
      waited_ms: Date.now() - startedAt,
      checked_at: new Date().toISOString(),
    };
    writeInlineStepProgress(label, startedAtIso, { [label]: evidence });
    if (evidence.ok) {
      writeStatus(clearCurrentStepFields({ [label]: evidence }));
      return evidence;
    }
    if (evidence.waited_ms >= chunkSourceQuietWaitMs || once) {
      throw new Error(`${label}: chunk source scan still running after post-drain hold (${running.length}); wait for chunk worker to yield before consuming the handoff`);
    }
    log(`waiting for chunk source scan quiescence (${label}): running=${running.length}`);
    await sleep(chunkSourceQuietPollMs);
  }
}

async function embedPauseHoldApi() {
  return import(resolve(ROOT, 'lib/embed-pause-hold.js'));
}

function summarizePostDrainEmbedHold(holdResult) {
  const hold = holdResult?.hold || null;
  if (!holdResult) return null;
  return {
    ok: holdResult.ok === true,
    reason: holdResult.reason || null,
    file: holdResult.file || null,
    pid: hold?.pid || null,
    hold_reason: hold?.reason || null,
    created_at: hold?.created_at || null,
    expires_at: hold?.expires_at || null,
    ttl_ms: hold?.ttl_ms || null,
    metadata: hold?.metadata || null,
  };
}

async function acquirePostDrainEmbedHold() {
  const { beginEmbedPauseHold, refreshEmbedPauseHold } = await embedPauseHoldApi();
  postDrainEmbedHoldLostReason = null;
  postDrainEmbedHold = beginEmbedPauseHold({
    reason: 'post_drain_pipeline_sole_writer',
    ttlMs: postDrainEmbedHoldTtlMs,
    metadata: {
      source: 'post-drain-pipeline',
      pid: process.pid,
      handoff_file: HANDOFF_FILE,
    },
  });
  writeStatus({ post_drain_embed_hold: summarizePostDrainEmbedHold(postDrainEmbedHold) });
  if (!postDrainEmbedHold.ok) {
    throw new Error(`post-drain embed writer hold unavailable: ${postDrainEmbedHold.reason}${postDrainEmbedHold.current_reason ? ` (${postDrainEmbedHold.current_reason})` : ''}`);
  }
  postDrainEmbedHoldRefreshTimer = setInterval(() => {
    const refreshed = refreshEmbedPauseHold(postDrainEmbedHold, {
      ttlMs: postDrainEmbedHoldTtlMs,
      metadata: {
        source: 'post-drain-pipeline',
        pid: process.pid,
        refreshed_by: 'interval',
      },
    });
    writeStatus({ post_drain_embed_hold: summarizePostDrainEmbedHold(refreshed) });
    if (!refreshed.ok) {
      postDrainEmbedHoldLostReason = refreshed.reason || 'refresh_failed';
      log(`post-drain embed writer hold refresh failed: ${refreshed.reason || 'unknown'}`);
    } else {
      postDrainEmbedHold = refreshed;
    }
  }, postDrainEmbedHoldRefreshMs);
}

async function releasePostDrainEmbedHold() {
  if (postDrainEmbedHoldRefreshTimer) {
    clearInterval(postDrainEmbedHoldRefreshTimer);
    postDrainEmbedHoldRefreshTimer = null;
  }
  if (!postDrainEmbedHold) return;
  const { releaseEmbedPauseHold } = await embedPauseHoldApi();
  const release = releaseEmbedPauseHold(postDrainEmbedHold);
  writeStatus({ post_drain_embed_hold_release: release });
  postDrainEmbedHold = null;
  postDrainEmbedHoldLostReason = null;
}

async function topicContextPendingCount() {
  const { default: db } = await import(resolve(ROOT, 'lib/db.js'));
  // A topic with a null context but no description can never produce a
  // meaningful context (there is no signal to generate from), so it must NOT
  // count as pending — otherwise the topic-context drain never reaches zero and
  // the handoff stalls. Mirror the maintenance-phases.js regen selector exactly.
  return Number(db.prepare(`
    SELECT COUNT(*) AS n
    FROM user_topics
    WHERE COALESCE(needs_regen, 0) = 1
       OR (
        context_md IS NULL
        AND NULLIF(TRIM(COALESCE(description, '')), '') IS NOT NULL
       )
  `).get()?.n || 0);
}

async function activeEmbedHold() {
  const { readEmbedPauseHold } = await import(resolve(ROOT, 'lib/embed-pause-hold.js'));
  const hold = readEmbedPauseHold({ maxCacheMs: 0 });
  return hold?.active === true ? hold : null;
}

function summarizeEmbedHold(hold) {
  if (!hold) return null;
  const raw = hold.hold && typeof hold.hold === 'object' ? hold.hold : hold;
  const pid = Number(raw.pid || 0);
  return {
    pid: pid || null,
    reason: hold.reason || raw.reason || null,
    process_alive: pid > 0 ? processAlive(pid) : false,
    created_at: raw.created_at || null,
    expires_at: raw.expires_at || null,
    ttl_ms: raw.ttl_ms || null,
    metadata: raw.metadata || null,
    file: hold.file || null,
  };
}

async function readiness() {
  let pending = null;
  let pendingError = null;
  try {
    pending = await pendingBacklogCount();
  } catch (err) {
    pendingError = err?.message || String(err);
  }
  let hold = null;
  let holdError = null;
  try {
    hold = await activeEmbedHold();
  } catch (err) {
    holdError = err?.message || String(err);
  }
  const holdSummary = summarizeEmbedHold(hold);
  const handoff = readJson(HANDOFF_FILE);
  const handoffReadyFailuresList = handoffReadyFailures(handoff);
  const handoffReady = handoffReadyFailuresList.length === 0;
  const handoffLaunchd = handoffLaunchdClearance(handoff);
  const handoffConsumed = handoffIsConsumed(handoff);
  const ready = pending === 0
    && !hold
    && !handoffConsumed
    && (ignoreHandoff || (handoffReady && handoffLaunchd.ok === true));
  return {
    ready,
    pending_embeddings: pending,
    pending_count_error: pendingError,
    handoff_file: HANDOFF_FILE,
    handoff_status: handoff?.status || null,
    handoff_checked_at: handoff?.checked_at || null,
    handoff_age_ms: ageMs(handoff?.checked_at),
    handoff_max_ready_age_ms: maxReadyHandoffAgeMs,
    handoff_ready: handoffReady,
    handoff_ready_failures: handoffReadyFailuresList,
    handoff_launchd_clearance: handoffLaunchd,
    handoff_consumed: handoffConsumed,
    handoff_required: !ignoreHandoff,
    active_embed_hold: holdSummary,
    active_embed_drain_hold: holdSummary?.reason === 'drain_personal_embeddings_sole_writer'
      ? holdSummary
      : null,
    hold_error: holdError,
  };
}

function appendTail(current, next, limit = 4000) {
  return `${current || ''}${next || ''}`.slice(-limit);
}

// Some steps run scripts that print benign warnings on stderr even on a clean
// exit — a killed migration writer marks value_rank as skipped on boot, DB WAL
// checkpoint chatter, etc. When a step FAILS we want the actionable line, not
// the benign boot noise, so `formatStepFailure` filters these out first. If the
// only stderr is benign, fall through to stdout, then to the exit code — never
// let a real failure be masked by (or reported only as) benign boot notices.
function isBenignStepStderrLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return true;
  // st-db4b3118 value_rank backfill skipped on boot — a killed migration writer
  // leaves this notice on every subsequent boot; it is not a step failure.
  const benignPatterns = [
    /st-db4b3118 value_rank backfill skipped on boot/i,
    /SQLITE_BUSY: database is locked \(retrying\)/i,
    /wal_checkpoint/i,
  ];
  return benignPatterns.some((re) => re.test(trimmed));
}

function actionableStderrTail(stderr) {
  return String(stderr || '')
    .split('\n')
    .filter((line) => line.trim() && !isBenignStepStderrLine(line))
    .join('\n')
    .trim();
}

// Build the human-facing failure message for a failed command step. Prefer a
// structured spawn/timeout error, then the actionable (non-benign) stderr tail,
// then stdout, then the raw exit status/signal — so operators see the line that
// actually explains the failure, not the boot noise that precedes it.
function formatStepFailure(id, payload) {
  const parts = [`${id} failed`];
  if (payload?.error) {
    parts.push(String(payload.error));
  } else {
    const stderr = actionableStderrTail(payload?.stderr_tail);
    const stdout = String(payload?.stdout_tail || '').trim();
    if (stderr) {
      parts.push(stderr);
    } else if (stdout) {
      parts.push(stdout);
    } else {
      const status = payload?.status ?? 'unknown';
      const signal = payload?.signal ? ` signal ${payload.signal}` : '';
      parts.push(`exit ${status}${signal}`);
    }
  }
  return parts.join(': ');
}

function runChildCommand(id, command, commandArgs, {
  timeoutMs,
  env,
  attempt,
  attempts,
  stdoutTailLimit = 4000,
}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    let stdoutTail = '';
    let stderrTail = '';
    let settled = false;
    let timedOut = false;
    let spawnError = null;
    let killTimer = null;
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const heartbeat = () => writeStatus({
      status: 'running',
      current_step: id,
      current_step_pid: child.pid || null,
      current_step_started_at: startedAt,
      current_step_heartbeat_at: new Date().toISOString(),
      current_step_attempt: attempt,
      current_step_attempts: attempts,
    });
    let lostHoldTerminated = false;
    const guardedHeartbeat = () => {
      heartbeat();
      if (postDrainEmbedHoldLostReason && !lostHoldTerminated && !settled) {
        lostHoldTerminated = true;
        log(`step ${id}: post-drain embed writer hold lost (${postDrainEmbedHoldLostReason}); terminating pid=${child.pid || 'unknown'}`);
        try { child.kill('SIGTERM'); } catch {}
      }
    };
    guardedHeartbeat();
    const heartbeatTimer = setInterval(guardedHeartbeat, stepHeartbeatMs);
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      log(`step ${id}: attempt ${attempt}/${attempts} timed out after ${timeoutMs}ms; terminating pid=${child.pid || 'unknown'}`);
      try { child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 10_000);
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk || '');
      stdoutTail = appendTail(stdoutTail, text, stdoutTailLimit);
      if (text) appendFileSync(LOG_PATH, text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '');
      stderrTail = appendTail(stderrTail, text);
      if (text) appendFileSync(LOG_PATH, text);
    });
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeatTimer);
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      const error = spawnError?.message
        || (lostHoldTerminated ? `post-drain embed writer hold lost: ${postDrainEmbedHoldLostReason}` : null)
        || (timedOut ? `timeout after ${timeoutMs}ms` : null);
      const ok = code === 0 && !error;
      resolve({
        id,
        ok,
        command,
        args: commandArgs,
        attempt,
        attempts,
        status: code,
        signal: signal || null,
        error,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - started,
        stdout_tail: stdoutTail,
        stderr_tail: stderrTail,
      });
    });
  });
}

async function runCommandStep(id, command, commandArgs, {
  timeoutMs = 30 * 60_000,
  env = {},
  allowFailure = false,
  attempts = 1,
  retryDelayMs = 30_000,
  stdoutTailLimit = 4000,
} = {}) {
  const maxAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  writeStatus({
    status: 'running',
    current_step: id,
    current_step_pid: null,
    current_step_started_at: null,
    current_step_heartbeat_at: null,
    current_step_attempt: 1,
    current_step_attempts: maxAttempts,
  });
  log(`step ${id}: ${[command, ...commandArgs].join(' ')}${maxAttempts > 1 ? ` (attempts=${maxAttempts})` : ''}`);
  if (dryRun) {
    const now = new Date().toISOString();
    const result = {
      id,
      ok: true,
      dry_run: true,
      command,
      args: commandArgs,
      attempt: 1,
      attempts: maxAttempts,
      started_at: now,
      completed_at: now,
      duration_ms: 0,
    };
    recordStepResult(result);
    return result;
  }

  let payload = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    payload = await runChildCommand(id, command, commandArgs, {
      timeoutMs,
      env,
      attempt,
      attempts: maxAttempts,
      stdoutTailLimit,
    });
    recordStepResult(payload);
    if (payload.ok || allowFailure) return payload;
    if (attempt < maxAttempts) {
      log(`step ${id}: attempt ${attempt}/${maxAttempts} failed; retrying in ${retryDelayMs}ms`);
      await sleep(retryDelayMs);
    }
  }

  if (!payload?.ok && !allowFailure) {
    throw new Error(formatStepFailure(id, payload));
  }
  return payload;
}

function recordNoopStep(id, { reason, extra = {} } = {}) {
  const now = new Date().toISOString();
  const result = {
    id,
    ok: true,
    noop: true,
    reason: reason || 'nothing_pending',
    started_at: now,
    completed_at: now,
    duration_ms: 0,
    ...extra,
  };
  recordStepResult(result);
  return result;
}

async function waitForReady() {
  for (;;) {
    const probe = await readiness();
    if (probe.handoff_consumed) {
      const consumed = await currentConsumedHandoffHasEvidence();
      if (!consumed?.ok) {
        const reason = consumed?.evidence?.failures?.[0] || 'missing durable completion evidence';
        writeStatus(clearCurrentStepFields({
          status: 'failed',
          readiness: probe,
          error: `handoff is consumed but durable completion evidence is missing: ${reason}`,
          failed_at: new Date().toISOString(),
        }));
        throw new Error(`handoff is consumed but durable completion evidence is missing: ${reason}`);
      }
      writeStatus(clearCurrentStepFields({ status: 'complete', readiness: probe }));
      log('handoff already consumed with durable evidence; exiting');
      return null;
    }
    if (probe.ready) {
      writeStatus({ status: 'ready', readiness: probe });
      return probe;
    }
    writeStatus({ status: 'waiting', readiness: probe });
    log(`waiting: pending=${probe.pending_embeddings} handoff=${probe.handoff_status || 'missing'} hold=${probe.active_embed_hold ? probe.active_embed_hold.reason : 'none'}`);
    if (once || !watch) return null;
    await sleep(pollMs);
  }
}

async function runReclassifySlices() {
  let slice = 0;
  for (;;) {
    slice += 1;
    if (maxReclassifySlices > 0 && slice > maxReclassifySlices) {
      throw new Error(`reclassify exceeded max slices (${maxReclassifySlices})`);
    }
    try { rmSync(RECLASSIFY_RESULT_FILE, { force: true }); } catch {}
    const result = await runCommandStep(`reclassify_chunks_${slice}`, process.execPath, [
      'scripts/ingest/05-reclassify-chunks.js',
      '--no-regen',
      '--result-file',
      RECLASSIFY_RESULT_FILE,
      '--max-seconds',
      String(reclassifySliceSeconds),
    ], {
      timeoutMs: (reclassifySliceSeconds + 90) * 1000,
      attempts: 2,
      retryDelayMs: 30_000,
      env: { ROBOTDOJO_RECLASSIFY_RESULT_FILE: RECLASSIFY_RESULT_FILE },
    });
    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        slices: slice,
        last: null,
        simulated_step: result,
      };
    }
    const parsed = readRequiredStepJsonResult(RECLASSIFY_RESULT_FILE, `reclassify_chunks_${slice}`, result);
    if (parsed?.partial === true) {
      validateReclassifyEvidence(parsed, { allowPartial: true });
      await sleep(reclassifyPauseMs);
      continue;
    }
    validateReclassifyEvidence(parsed, { allowPartial: false });
    return { slices: slice, last: parsed };
  }
}

async function runTopicContextSlices({
  idPrefix = 'topic_context',
  dryRunId = 'topic_context_dry_run',
  noopId = 'topic_context_noop',
} = {}) {
  let slice = 0;
  const startedAt = new Date().toISOString();
  const initialPending = await topicContextPendingCount();
  let pending = initialPending;
  const sliceResults = [];
  let noopStep = null;
  if (pending <= 0) {
    noopStep = recordNoopStep(noopId, {
      reason: 'no_topic_contexts_pending',
      extra: { initial_pending: initialPending },
    });
  }
  if (dryRun) {
    let simulatedStep = null;
    if (pending > 0) {
      simulatedStep = await runCommandStep(dryRunId, process.execPath, [
        'scripts/maintenance-phases.js',
        '--phase',
        'TOPICS',
        '--max-seconds',
        String(topicSliceSeconds),
      ], { timeoutMs: (topicSliceSeconds + 90) * 1000, attempts: 2, retryDelayMs: 30_000 });
      slice = 1;
      sliceResults.push({
        slice,
        before_pending: pending,
        after_pending: pending,
        checked_at: new Date().toISOString(),
        dry_run: true,
      });
    }
    return {
      ok: true,
      dry_run: true,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      slices: slice,
      initial_pending: initialPending,
      final_pending: pending,
      pending_unmodified: true,
      simulated_step: simulatedStep,
      noop_step: noopStep,
      slice_results: sliceResults,
    };
  }
  while (pending > 0) {
    slice += 1;
    if (maxTopicSlices > 0 && slice > maxTopicSlices) {
      throw new Error(`topic context regeneration still pending after ${maxTopicSlices} slices (${pending})`);
    }
    const before = pending;
    await runCommandStep(`${idPrefix}_${slice}`, process.execPath, [
      'scripts/maintenance-phases.js',
      '--phase',
      'TOPICS',
      '--max-seconds',
      String(topicSliceSeconds),
    ], { timeoutMs: (topicSliceSeconds + 90) * 1000, attempts: 2, retryDelayMs: 30_000 });
    const next = await topicContextPendingCount();
    sliceResults.push({
      slice,
      before_pending: before,
      after_pending: next,
      checked_at: new Date().toISOString(),
    });
    if (next > 0) await sleep(topicPauseMs);
    pending = next;
  }
  return {
    ok: true,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    slices: slice,
    initial_pending: initialPending,
    final_pending: pending,
    noop_step: noopStep,
    slice_results: sliceResults,
  };
}

async function runMemoryRefocusSlices() {
  let slice = 0;
  for (;;) {
    slice += 1;
    if (maxMemoryRefocusSlices > 0 && slice > maxMemoryRefocusSlices) {
      throw new Error(`memory refocus exceeded max slices (${maxMemoryRefocusSlices})`);
    }
    try { rmSync(MEMORY_REFOCUS_RESULT_FILE, { force: true }); } catch {}
    const result = await runCommandStep(`memory_refocus_${slice}`, process.execPath, [
      'scripts/refocus-memory-routing.js',
      '--apply',
      '--json',
      '--max-seconds',
      String(memoryRefocusSliceSeconds),
    ], {
      timeoutMs: (memoryRefocusSliceSeconds + 90) * 1000,
      attempts: 2,
      retryDelayMs: 30_000,
      env: { ROBOTDOJO_MEMORY_REFOCUS_RESULT_FILE: MEMORY_REFOCUS_RESULT_FILE },
    });
    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        slices: slice,
        last: null,
        simulated_step: result,
      };
    }
    const parsed = readRequiredStepJsonResult(MEMORY_REFOCUS_RESULT_FILE, `memory_refocus_${slice}`, result);
    if (parsed?.partial === true) {
      validateMemoryRefocusEvidence(parsed, { allowPartial: true });
      await sleep(memoryRefocusPauseMs);
      continue;
    }
    validateMemoryRefocusEvidence(parsed, { allowPartial: false });
    return { slices: slice, last: parsed };
  }
}

async function runFinalProductProof({ repairCompletedAt }) {
  const finalProductProofStep = await runCommandStep('final_product_proof', process.execPath, [
    ...FINAL_PRODUCT_PROOF_COMMAND_ARGS,
  ], {
    timeoutMs: 45 * 60_000,
    attempts: 2,
    retryDelayMs: 60_000,
    stdoutTailLimit: 512 * 1024,
  });
  const report = finalProductProofReportFromStep(finalProductProofStep);
  const proof = finalProductProofFromReport(report, { repairCompletedAt, step: finalProductProofStep });
  validateFinalProductProofEvidence(proof);
  return proof;
}

async function runPipeline(readinessProbe = null) {
  writeFreshStatus({
    status: 'running',
    started_at: new Date().toISOString(),
    dry_run: dryRun,
    handoff_file: HANDOFF_FILE,
    log_file: LOG_PATH,
    readiness: readinessProbe,
    step_history: [],
    last_step: null,
  });

  if (!dryRun) await acquirePostDrainEmbedHold();
  if (!dryRun) await waitForChunkSourceQuiescence();
  if (!dryRun) await assertBacklogStillDrained('pre_backup_backlog_check');
  if (!dryRun) await waitForBackupSlot('preflight_backup_slot');

  try { rmSync(POST_DRAIN_PREFLIGHT_RESULT_FILE, { force: true }); } catch {}
  const preflightStep = await runCommandStep('post_drain_preflight', process.execPath, [
    'scripts/qa/post-drain-preflight.js',
    '--strict',
    '--result-file',
    POST_DRAIN_PREFLIGHT_RESULT_FILE,
  ], {
    timeoutMs: 10 * 60_000,
    attempts: 2,
    retryDelayMs: 60_000,
    env: { ROBOTDOJO_POST_DRAIN_PREFLIGHT_RESULT_FILE: POST_DRAIN_PREFLIGHT_RESULT_FILE },
  });
  const postDrainPreflight = dryRun ? preflightStep : readRequiredStepJsonResult(POST_DRAIN_PREFLIGHT_RESULT_FILE, 'post_drain_preflight', preflightStep);
  if (!dryRun) validatePostDrainPreflightEvidence(postDrainPreflight);
  writeStatus({ post_drain_preflight: postDrainPreflight });

  if (!dryRun) await waitForBackupSlot('backup_slot');
  if (!dryRun) await waitForChunkSourceQuiescence('pre_gcs_backup_source_quiescence');
  if (!dryRun) await assertBacklogStillDrained('pre_gcs_backup_backlog_check');
  // Reuse a fresh, verified backup when one already exists — the data plane is
  // frozen behind the embed writer hold, so re-running the multi-hour snapshot
  // upload would only burn wall time. Records a synthetic gcs_backup noop step
  // so downstream evidence validation still sees a passing backup for this run.
  const reusableBackup = dryRun ? null : freshReusableBackupEvidence();
  let backup;
  if (reusableBackup) {
    const ageMinutes = Math.round(reusableBackup.ageMs / 60_000);
    log(`step gcs_backup: reusing fresh verified backup evidence (age ${ageMinutes}m); skipping re-upload`);
    recordNoopStep('gcs_backup', {
      reason: 'fresh_verified_backup_reused',
      extra: {
        synthetic: true,
        reused_backup_age_ms: reusableBackup.ageMs,
        reused_from: BACKUP_RESULT_FILE,
        ...reusableBackup.evidence,
      },
    });
    backup = reusableBackup.evidence;
  } else {
    try { rmSync(BACKUP_RESULT_FILE, { force: true }); } catch {}
    const backupStep = await runCommandStep('gcs_backup', process.execPath, [
      'scripts/backup-dispatcher.js',
      '--strict',
      '--force-scheduled',
      '--db-only',
      '--snapshot-db',
      '--snapshot-method',
      'clone',
      '--result-file',
      BACKUP_RESULT_FILE,
    ], {
      timeoutMs: 6 * 60 * 60_000,
      attempts: 3,
      retryDelayMs: 60_000,
      env: { ROBOTDOJO_BACKUP_RESULT_FILE: BACKUP_RESULT_FILE },
    });
    backup = dryRun ? backupStep : readRequiredStepJsonResult(BACKUP_RESULT_FILE, 'gcs_backup', backupStep);
  }
  if (!dryRun) validateBackupEvidence(backup);
  writeStatus({ gcs_backup: backup });

  if (!dryRun) await waitForChunkSourceQuiescence('pre_reclassify_source_quiescence');
  if (!dryRun) await assertBacklogStillDrained('pre_reclassify_backlog_check');
  const reclassify = await runReclassifySlices();
  writeStatus({ reclassify });

  try { rmSync(SPLIT_VEC_REPAIR_RESULT_FILE, { force: true }); } catch {}
  const splitVecRepairStep = await runCommandStep('split_vec_orphan_repair_after_reclassify', process.execPath, [
    'scripts/migration/repair-split-vec-orphans.mjs',
    '--result-file',
    SPLIT_VEC_REPAIR_RESULT_FILE,
  ], {
    timeoutMs: 10 * 60_000,
    attempts: 2,
    retryDelayMs: 30_000,
    env: { ROBOTDOJO_SPLIT_VEC_REPAIR_RESULT_FILE: SPLIT_VEC_REPAIR_RESULT_FILE },
  });
  const splitVecRepair = dryRun ? splitVecRepairStep : readRequiredStepJsonResult(SPLIT_VEC_REPAIR_RESULT_FILE, 'split_vec_orphan_repair_after_reclassify', splitVecRepairStep);
  if (!dryRun) validateSplitVectorRepairEvidence(splitVecRepair);
  writeStatus({ split_vec_orphan_repair_after_reclassify: splitVecRepair });

  try { rmSync(VEC_ORPHAN_RESULT_FILE, { force: true }); } catch {}
  const vecOrphanStep = await runCommandStep('vec_orphan_check_after_reclassify', process.execPath, [
    'scripts/qa/check-vec-orphans.js',
    '--result-file',
    VEC_ORPHAN_RESULT_FILE,
  ], {
    timeoutMs: 10 * 60_000,
    attempts: 2,
    retryDelayMs: 30_000,
    env: { ROBOTDOJO_VEC_ORPHAN_CHECK_RESULT_FILE: VEC_ORPHAN_RESULT_FILE },
  });
  const vecOrphanCheck = dryRun ? vecOrphanStep : readRequiredStepJsonResult(VEC_ORPHAN_RESULT_FILE, 'vec_orphan_check_after_reclassify', vecOrphanStep);
  if (!dryRun) validateSplitVectorParityEvidence(vecOrphanCheck);
  writeStatus({ vec_orphan_check_after_reclassify: vecOrphanCheck });

  try { rmSync(SOURCE_TOPIC_METADATA_REPAIR_RESULT_FILE, { force: true }); } catch {}
  const sourceTopicMetadataRepairStep = await runCommandStep('source_topic_metadata_repair', process.execPath, [
    'scripts/repair-source-topic-metadata.js',
    '--apply',
    '--json',
    '--result-file',
    SOURCE_TOPIC_METADATA_REPAIR_RESULT_FILE,
  ], {
    timeoutMs: 10 * 60_000,
    attempts: 2,
    retryDelayMs: 30_000,
    env: { ROBOTDOJO_SOURCE_TOPIC_METADATA_REPAIR_RESULT_FILE: SOURCE_TOPIC_METADATA_REPAIR_RESULT_FILE },
  });
  const sourceTopicMetadataRepair = dryRun ? sourceTopicMetadataRepairStep : readRequiredStepJsonResult(SOURCE_TOPIC_METADATA_REPAIR_RESULT_FILE, 'source_topic_metadata_repair', sourceTopicMetadataRepairStep);
  if (!dryRun) validateSourceTopicMetadataRepairEvidence(sourceTopicMetadataRepair);
  writeStatus({ source_topic_metadata_repair: sourceTopicMetadataRepair });

  if (!dryRun) await waitForChunkSourceQuiescence('pre_topic_context_source_quiescence');
  if (!dryRun) await assertBacklogStillDrained('pre_topic_context_backlog_check');
  const topicContexts = await runTopicContextSlices({
    idPrefix: 'topic_context',
    dryRunId: 'topic_context_dry_run',
    noopId: 'topic_context_noop',
  });
  if (!dryRun) validateTopicContextEvidence(topicContexts, 'topic context regeneration');
  writeStatus({ topic_contexts: topicContexts });

  if (!dryRun) await waitForChunkSourceQuiescence('pre_global_hnsw_source_quiescence');
  if (!dryRun) await assertBacklogStillDrained('pre_global_hnsw_backlog_check');
  try { rmSync(GLOBAL_HNSW_RESULT_FILE, { force: true }); } catch {}
  const globalHnswStep = await runCommandStep('global_hnsw_rebuild', process.execPath, [
    'scripts/build-global-hnsw.js',
    '--result-file',
    GLOBAL_HNSW_RESULT_FILE,
  ], {
    timeoutMs: globalHnswTimeoutMs,
    attempts: 2,
    retryDelayMs: 60_000,
    env: { ROBOTDOJO_GLOBAL_HNSW_RESULT_FILE: GLOBAL_HNSW_RESULT_FILE },
  });
  const globalHnsw = dryRun ? globalHnswStep : readRequiredStepJsonResult(GLOBAL_HNSW_RESULT_FILE, 'global_hnsw_rebuild', globalHnswStep);
  if (!dryRun) validateGlobalHnswEvidence(globalHnsw);
  writeStatus({ global_hnsw_rebuild: globalHnsw });

  try { rmSync(MEMORY_ROUTING_REPAIR_RESULT_FILE, { force: true }); } catch {}
  const memoryRoutingRepairStep = await runCommandStep('memory_routing_repair', process.execPath, [
    'scripts/repair-memory-routing.js',
    '--apply',
    '--result-file',
    MEMORY_ROUTING_REPAIR_RESULT_FILE,
  ], {
    timeoutMs: 30 * 60_000,
    attempts: 2,
    retryDelayMs: 30_000,
    env: { ROBOTDOJO_MEMORY_ROUTING_REPAIR_RESULT_FILE: MEMORY_ROUTING_REPAIR_RESULT_FILE },
  });
  const memoryRoutingRepair = dryRun ? memoryRoutingRepairStep : readRequiredStepJsonResult(MEMORY_ROUTING_REPAIR_RESULT_FILE, 'memory_routing_repair', memoryRoutingRepairStep);
  if (!dryRun) validateMemoryRoutingRepairEvidence(memoryRoutingRepair);
  writeStatus({ memory_routing_repair: memoryRoutingRepair });

  const memoryRefocus = await runMemoryRefocusSlices();
  writeStatus({ memory_refocus: memoryRefocus });

  try { rmSync(MEMORY_RECALC_RESULT_FILE, { force: true }); } catch {}
  const memoryRecalcStep = await runCommandStep('memory_recalc', process.execPath, [
    'scripts/memory-recalc.js',
    '--all',
    '--json',
    '--result-file',
    MEMORY_RECALC_RESULT_FILE,
  ], {
    timeoutMs: 2 * 60 * 60_000,
    attempts: 2,
    retryDelayMs: 60_000,
    env: { ROBOTDOJO_MEMORY_RECALC_RESULT_FILE: MEMORY_RECALC_RESULT_FILE },
  });
  const memoryRecalc = dryRun ? memoryRecalcStep : readRequiredStepJsonResult(MEMORY_RECALC_RESULT_FILE, 'memory_recalc', memoryRecalcStep);
  if (!dryRun) validateMemoryRecalcEvidence(memoryRecalc);
  writeStatus({ memory_recalc: memoryRecalc });

  if (!dryRun) await waitForChunkSourceQuiescence('pre_post_memory_topic_context_source_quiescence');
  if (!dryRun) await assertBacklogStillDrained('pre_post_memory_topic_context_backlog_check');
  const postMemoryTopicContexts = await runTopicContextSlices({
    idPrefix: 'post_memory_topic_context',
    dryRunId: 'post_memory_topic_context_dry_run',
    noopId: 'post_memory_topic_context_noop',
  });
  if (!dryRun) validateTopicContextEvidence(postMemoryTopicContexts, 'post-memory topic context regeneration');
  writeStatus({ post_memory_topic_contexts: postMemoryTopicContexts });

  if (!dryRun) await waitForChunkSourceQuiescence('pre_routing_audit_source_quiescence');
  if (!dryRun) await assertBacklogStillDrained('pre_routing_audit_backlog_check');
  try { rmSync(ROUTING_AUDIT_RESULT_FILE, { force: true }); } catch {}
  const routingAuditStep = await runCommandStep('routing_residue_audit', process.execPath, [
    'scripts/qa/routing-residue-audit.js',
    '--json',
    '--strict',
    '--result-file',
    ROUTING_AUDIT_RESULT_FILE,
    '--max-personal-pending',
    '0',
    '--max-personal-unexplained-imports',
    String(maxPersonalUnexplainedImports),
    '--max-personal-source-metadata-rows',
    String(maxPersonalSourceMetadataRows),
    '--max-needs-routing-chunks',
    String(maxNeedsRoutingChunks),
    '--max-needs-routing-memory',
    String(maxNeedsRoutingMemory),
    '--require-needs-routing-resolution-review',
    '--needs-routing-review-limit',
    String(maxNeedsRoutingChunks),
  ], {
    timeoutMs: 10 * 60_000,
    env: { ROBOTDOJO_ROUTING_RESIDUE_AUDIT_RESULT_FILE: ROUTING_AUDIT_RESULT_FILE },
  });
  const routingAudit = dryRun ? routingAuditStep : readRequiredStepJsonResult(ROUTING_AUDIT_RESULT_FILE, 'routing_residue_audit', routingAuditStep);
  if (!dryRun) validateRoutingResidueEvidence(routingAudit);
  writeStatus({ routing_residue_audit: routingAudit });

  if (!dryRun) await assertBacklogStillDrained('final_backlog_check');

  if (dryRun) {
    writeStatus(clearCurrentStepFields({
      status: 'dry_run_complete',
      completed_at: new Date().toISOString(),
    }));
    log('dry-run complete; handoff left unconsumed');
    return;
  }

  const repairCompletedAt = new Date().toISOString();
  writeStatus({
    status: 'running',
    repair_completed_at: repairCompletedAt,
    current_step: 'final_product_proof',
    current_step_pid: null,
    current_step_started_at: repairCompletedAt,
    current_step_heartbeat_at: null,
    current_step_attempt: null,
    current_step_attempts: null,
  });
  await releasePostDrainEmbedHold();
  const finalProductProof = await runFinalProductProof({ repairCompletedAt });
  writeStatus({ final_product_proof: finalProductProof });
  await waitForChunkSourceQuiescence('post_product_proof_source_quiescence');
  await assertBacklogStillDrained('post_product_proof_backlog_check');

  const completedAt = new Date().toISOString();
  writeStatus(clearCurrentStepFields({
    status: 'complete',
    repair_completed_at: repairCompletedAt,
    completed_at: completedAt,
  }));
  markHandoffConsumed({ completedAt });
  log('complete');
}

async function main() {
  await acquireLock();
  try {
    const processed = await currentHandoffAlreadyProcessed();
    if (processed) {
      const statusCompletedAt = processed.status?.completed_at || new Date().toISOString();
      const handoffCompletedAt = new Date().toISOString();
      writeStatus(clearCurrentStepFields({
        status: 'complete',
        completed_at: statusCompletedAt,
        readiness: {
          ...processed.status?.readiness,
          handoff_status: 'post_drain_complete',
          handoff_consumed: true,
        },
      }));
      markHandoffConsumed({ recoveredFrom: processed.reason, completedAt: handoffCompletedAt });
      log(`current handoff already processed (${processed.reason}); marked consumed`);
      return;
    }
    const probe = await waitForReady();
    if (!probe) return;
    await runPipeline(probe);
  } catch (err) {
    const prev = readJson(STATUS_FILE) || {};
    const failedStep = prev.current_step ? {
      id: prev.current_step,
      pid: prev.current_step_pid || null,
      started_at: prev.current_step_started_at || null,
      heartbeat_at: prev.current_step_heartbeat_at || null,
      attempt: prev.current_step_attempt || null,
      attempts: prev.current_step_attempts || null,
    } : (prev.last_step ? {
      id: prev.last_step.id || null,
      ok: prev.last_step.ok === true,
      completed_at: prev.last_step.completed_at || null,
    } : null);
    writeStatus(clearCurrentStepFields({
      status: 'failed',
      failed_step: failedStep,
      error: err?.message || String(err),
      failed_at: new Date().toISOString(),
    }));
    log(`failed: ${err?.stack || err}`);
    process.exitCode = 1;
  } finally {
    await releasePostDrainEmbedHold();
    releaseLock();
  }
}

main();
