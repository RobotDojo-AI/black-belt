#!/usr/bin/env node
/**
 * Launch stoplight — one red/green surface for the launch path.
 *
 * The harness is intentionally row-oriented. A full run checks the supported
 * local path, installer/process ownership, retrieval visibility, daemon quieting,
 * and demo/private routing. Row mode runs the requested row plus the smallest
 * prerequisite set needed to make that row truthful.
 */
import crypto from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync, rmSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Agent } from 'undici';
import config from '../../lib/config.js';
import { DEFAULT_CHAT_MODEL_KEY, resolveChatModelId } from '../../lib/chat-models.js';
import { probeServerHealth } from '../background-status.js';
import { getIdleSeconds } from '../../lib/idle-gate.js';
import { activityPauseDecision, chatAppActiveDecision, getActivitySignal } from '../../lib/request-observer.js';
import { LAUNCH_CRITICAL_ROUTINE_JOB_TYPES } from '../../lib/maintenance-routines.js';
import { beginEmbedPauseHold, readEmbedPauseHold, releaseEmbedPauseHold } from '../../lib/embed-pause-hold.js';
import {
  beginEmbedProofFreezeRequest,
  releaseEmbedProofFreezeRequest,
  readEmbedProofFreezeStatus,
} from '../../lib/embed-proof-freeze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const ROW_IDS = [
  'local_readiness',
  'login_session',
  'session_log_nonblocking',
  'foreground_activity_signal',
  'chat_open_daemon_quiet',
  'private_chat',
  'chat_stall_recovery',
  'foreground_under_background',
  'installer_processes',
  'relay_login_chat',
  'embed_writer_exclusivity',
  'embedding_drain_progress',
  'personal_drain_progress',
  'embed_proof_freeze_handshake',
  'data_pipeline_invariants',
  'retrieval_sentinel',
  'browser_product_proof',
  'demo_private_routing',
];

function hasFlag(name) {
  return args.includes(name);
}

function valuesFor(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) out.push(args[i + 1]);
    else if (args[i].startsWith(`${name}=`)) out.push(args[i].slice(name.length + 1));
  }
  return out;
}

const opts = {
  local: hasFlag('--local'),
  relay: hasFlag('--relay'),
  strictLaunchd: hasFlag('--strict-launchd'),
  headless: hasFlag('--headless'),
  fresh: hasFlag('--fresh'),
  requirePrivateChat: hasFlag('--require-private-chat'),
  restartServices: hasFlag('--restart-services'),
  freezeActiveDrain: hasFlag('--freeze-active-drain') || process.env.ROBOTDOJO_STOPLIGHT_FREEZE_ACTIVE_DRAIN === '1',
  rows: valuesFor('--row'),
};

if (!opts.local && !opts.relay && opts.rows.length === 0) opts.local = true;

const reportDir = join(config.configDir || join(homedir(), '.robotdojo'), 'logs');
const reportPath = join(reportDir, 'launch-stoplight-latest.json');
const reportSnapshotDir = join(reportDir, 'launch-stoplight-snapshots');
const runLockPath = join(reportDir, 'launch-stoplight.run.lock');
const runLockWaitMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_RUN_LOCK_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15 * 60_000;
})();
const runLockStaleMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_RUN_LOCK_STALE_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? Math.floor(raw) : 30 * 60_000;
})();
// The installed browser path is localhost: the mkcert cert is issued for
// localhost, while 127.0.0.1 correctly shows a browser privacy error.
let localBase = (process.env.ROBOTDOJO_LOCAL_BASE || `https://localhost:${config.ports.app}`).replace(/\/+$/, '');
const localProxyBase = `http://127.0.0.1:${config.ports.app + 1}`;
const relayBase = (process.env.ROBOTDOJO_RELAY_URL || config.tunnel?.url || (config.deviceSlug ? `https://${config.deviceSlug}.robotdojo.ai` : '')).replace(/\/+$/, '');
const chatActivePingTimeoutMs = Math.max(1, Number(process.env.ROBOTDOJO_STOPLIGHT_CHAT_ACTIVE_TIMEOUT_MS || 3000));
const chatActivePingAttempts = Math.max(1, Number(process.env.ROBOTDOJO_STOPLIGHT_CHAT_ACTIVE_ATTEMPTS || 3));
const chatActivePingRetryDelayMs = Math.max(0, Number(process.env.ROBOTDOJO_STOPLIGHT_CHAT_ACTIVE_RETRY_DELAY_MS || 750));
const privateChatTtftBudgetMs = Math.max(1000, Number(process.env.ROBOTDOJO_STOPLIGHT_PRIVATE_CHAT_TTFT_MS || 10_000));
const privateChatTotalBudgetMs = Math.max(
  privateChatTtftBudgetMs,
  Number(process.env.ROBOTDOJO_STOPLIGHT_PRIVATE_CHAT_TOTAL_MS || 20_000),
);
const localReadinessTimeoutMs = Math.max(10_000, Number(process.env.ROBOTDOJO_STOPLIGHT_LOCAL_READINESS_TIMEOUT_MS || 60_000));
const localReadinessProbeTimeoutMs = Math.max(1000, Number(process.env.ROBOTDOJO_STOPLIGHT_LOCAL_READINESS_PROBE_TIMEOUT_MS || 5000));
const restartLocalTimeoutMs = Math.max(30_000, Number(process.env.ROBOTDOJO_STOPLIGHT_RESTART_LOCAL_TIMEOUT_MS || 240_000));
const foregroundActivityDeltaAttempts = Math.max(1, Number(process.env.ROBOTDOJO_STOPLIGHT_ACTIVITY_DELTA_ATTEMPTS || 3));
const foregroundActivityProbeSettleMs = Math.max(1000, Number(process.env.ROBOTDOJO_STOPLIGHT_ACTIVITY_PROBE_SETTLE_MS || 1500));
const annDriftThreshold = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_ANN_DRIFT || process.env.ROBOTDOJO_ANN_REBUILD_DRIFT || 0.005);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.005;
})();
const annRebuildMinChunks = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_ANN_MIN_CHUNKS || process.env.ROBOTDOJO_ANN_REBUILD_MIN_CHUNKS || 64);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 64;
})();
const maxPendingChunkChars = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_MAX_PENDING_CHUNK_CHARS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200_000;
})();
const workOrderMaxDeriveMs = envNumberAtLeast(
  'ROBOTDOJO_STOPLIGHT_WORK_ORDER_MAX_DERIVE_MS',
  5000,
  500,
);
const dataProofFetchAttempts = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_DATA_PROOF_ATTEMPTS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
})();
const exactAnnDrainFreezeWaitMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_DRAIN_FREEZE_WAIT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : 60_000;
})();
const personalDrainTopic = process.env.ROBOTDOJO_STOPLIGHT_DRAIN_TOPIC || 'personal';
const personalDrainProgressWaitMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_DRAIN_PROGRESS_WAIT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : 60_000;
})();
const personalDrainProgressPollMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_DRAIN_PROGRESS_POLL_MS);
  return Number.isFinite(raw) && raw >= 250 ? Math.floor(raw) : 5000;
})();
const personalDrainProgressMinSampleMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_DRAIN_PROGRESS_MIN_SAMPLE_MS);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : Math.min(30_000, personalDrainProgressWaitMs);
})();
const personalDrainEtaMinCompleted = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_DRAIN_ETA_MIN_COMPLETED);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 512;
})();
const browserProductProofTimeoutMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_BROWSER_PRODUCT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 5 * 60_000;
})();
const BROWSER_PRODUCT_PROOF_SPECS = Object.freeze([
  'scripts/qa/tests/first-session-launch.spec.js',
  'scripts/qa/tests/chat-browser-real-turn.spec.js',
  'scripts/qa/tests/chat-path-matrix.spec.js',
]);
const BROWSER_ENTITY_CARD_PROOF = Object.freeze({
  spec: 'scripts/qa/tests/chat-browser-real-turn.spec.js',
  test_name: 'real browser entity-network turn answers from the local entity card',
  seed_marker: 'browser product proof seed in the local entity network',
  network_question: 'Use my data: is ${name} in my entity network? Answer briefly.',
  direct_find_question: 'Find ${name} in my entity network.',
  negative_premise_question: "Why isn't ${name} in my entity network?",
  expected_answer: 'Yes. ${name} is in your network.',
});
const LOCAL_APP_FRESHNESS_FILES = Object.freeze([
  'index.js',
  'lib/server.js',
  'lib/chat.js',
  'lib/chat-context.js',
  'routes/chat.js',
  'routes/admin.js',
  'lib/data-plane-proof.js',
  'apps/chat/modules/chat.js',
  'apps/chat/modules/inline-recognition.js',
  'scripts/qa/tests/chat-browser-real-turn.spec.js',
]);
const personalDrainMinFreeGb = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_DRAIN_MIN_FREE_GB || process.env.ROBOTDOJO_DRAIN_MIN_FREE_GB);
  return Number.isFinite(raw) && raw >= 0 ? raw : 6;
})();
const postDrainWatcherLabel = process.env.ROBOTDOJO_STOPLIGHT_POST_DRAIN_WATCHER_LABEL
  || 'com.robotdojo.post-embedding-drain-pipeline.codex';
const postDrainStatusPath = process.env.ROBOTDOJO_POST_DRAIN_STATUS_FILE
  || join(config.configDir || join(homedir(), '.robotdojo'), 'runtime', 'post-embedding-drain-pipeline.json');
const postDrainPreflightPath = process.env.ROBOTDOJO_POST_DRAIN_PREFLIGHT_RESULT_FILE
  || join(config.configDir || join(homedir(), '.robotdojo'), 'runtime', 'post-drain-preflight.json');
const postDrainPreflightScript = join(REPO_ROOT, 'scripts/qa/post-drain-preflight.js');
const REQUIRED_POST_DRAIN_PREFLIGHT_COMMANDS = Object.freeze([
  'scripts/migration/run-post-embedding-drain-pipeline.mjs',
  'scripts/qa/post-drain-preflight.js',
  'scripts/backup-dispatcher.js',
  'scripts/ingest/05-reclassify-chunks.js',
  'scripts/migration/repair-split-vec-orphans.mjs',
  'scripts/qa/check-vec-orphans.js',
  'scripts/repair-source-topic-metadata.js',
  'scripts/maintenance-phases.js',
  'scripts/build-global-hnsw.js',
  'scripts/repair-memory-routing.js',
  'scripts/refocus-memory-routing.js',
  'scripts/memory-recalc.js',
  'scripts/qa/routing-residue-audit.js',
  'scripts/qa/launch-stoplight.js',
]);
const REQUIRED_POST_DRAIN_PREFLIGHT_DEPENDENCIES = Object.freeze([
  'lib/db.js',
  'lib/config.js',
  'lib/chat-models.js',
  'lib/rag/embed.js',
  'lib/rag/retrieve.js',
  'lib/rag/work-order.js',
  'lib/rag/lane-pool.js',
  'lib/data-plane-proof.js',
  'lib/chat-context.js',
  'lib/split-vector-store.js',
  'lib/topic-routing-policy.js',
  'lib/memory-scope-routing.js',
  'lib/topic-context.js',
  'lib/ann/usearch-adapter.js',
  'lib/embed-pause-hold.js',
  'lib/embed-proof-freeze.js',
  'lib/maintenance-routines.js',
  'lib/request-observer.js',
  'scripts/backup-to-gcp.js',
  'scripts/background-status.js',
  'scripts/qa/tests/first-session-launch.spec.js',
  'scripts/qa/tests/chat-browser-real-turn.spec.js',
  'scripts/qa/tests/chat-path-matrix.spec.js',
  'scripts/qa/tests/env.js',
  'scripts/qa/tests/frontend-workbench-helpers.js',
  'scripts/qa/global-setup.js',
  'playwright.config.js',
  'config/sla.js',
]);
const postDrainMaxStatusAgeMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_POST_DRAIN_STATUS_MAX_AGE_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 15 * 60_000;
})();
const defaultPostDrainPreflightMaxAgeMs = 72 * 60 * 60_000;
const postDrainMaxPreflightAgeMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_POST_DRAIN_PREFLIGHT_MAX_AGE_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : defaultPostDrainPreflightMaxAgeMs;
})();
const postDrainPreflightMaxAnnSourceLag = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_PREFLIGHT_ANN_SOURCE_MAX_LAG);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2048;
})();
const embedWriterExclusivityMaxPauseAgeMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_WRITER_EXCLUSIVITY_MAX_PAUSE_AGE_MS);
  return Number.isFinite(raw) && raw >= 5000 ? Math.floor(raw) : 120_000;
})();
const dataProofRetryDelayMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_DATA_PROOF_RETRY_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 750;
})();
const embedDaemonLogScanLines = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_EMBED_LOG_SCAN_LINES);
  return Number.isFinite(raw) && raw >= 500 ? Math.floor(raw) : 5000;
})();
const LAUNCH_CRITICAL_ROUTINE_TYPES = new Set(LAUNCH_CRITICAL_ROUTINE_JOB_TYPES);
const maintenanceForegroundQuietMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_MAINT_FOREGROUND_QUIET_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15 * 60_000;
})();
const maintenanceForegroundHidIdleSeconds = (() => {
  const raw = Number(process.env.ROBOTDOJO_MAINT_FOREGROUND_HID_IDLE_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15 * 60;
})();
const maintenanceForegroundBootGraceMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_MAINT_FOREGROUND_BOOT_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15 * 60_000;
})();
const maxCriticalRoutineDueMs = (() => {
  const raw = Number(process.env.ROBOTDOJO_STOPLIGHT_MAX_CRITICAL_ROUTINE_DUE_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 30 * 60_000;
})();
const daemonForegroundIdleSeconds = (() => {
  const raw = Number(process.env.ROBOTDOJO_DAEMON_FOREGROUND_IDLE_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15 * 60;
})();
const localTlsAgent = new Agent({ connect: { rejectUnauthorized: false } });

function readRunLockOwner(path = runLockPath) {
  try {
    return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function runLockAgeMs(path = runLockPath, owner = null, now = Date.now()) {
  const started = Number(owner?.started_at_ms);
  if (Number.isFinite(started) && started > 0) return Math.max(0, now - started);
  try {
    return Math.max(0, now - Number(statSync(path).mtimeMs || now));
  } catch {
    return 0;
  }
}

function runLockIsStale(path = runLockPath, now = Date.now()) {
  const owner = readRunLockOwner(path);
  if (owner?.pid) return !processAlive(owner.pid);
  return runLockAgeMs(path, owner, now) >= runLockStaleMs;
}

async function acquireRunLock() {
  const startedAt = Date.now();
  const token = crypto.randomUUID();
  let attempts = 0;
  mkdirSync(reportDir, { recursive: true });
  while (true) {
    attempts += 1;
    try {
      mkdirSync(runLockPath);
      const owner = {
        token,
        pid: process.pid,
        started_at: new Date().toISOString(),
        started_at_ms: Date.now(),
        argv: process.argv.slice(2),
      };
      writeFileSync(join(runLockPath, 'owner.json'), JSON.stringify(owner, null, 2));
      return {
        ok: true,
        path: runLockPath,
        token,
        attempts,
        waited_ms: Date.now() - startedAt,
        release() {
          const current = readRunLockOwner(runLockPath);
          if (current?.token !== token) return false;
          rmSync(runLockPath, { recursive: true, force: true });
          return true;
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (runLockIsStale(runLockPath)) {
        rmSync(runLockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= runLockWaitMs) {
        const owner = readRunLockOwner(runLockPath);
        const ageMs = runLockAgeMs(runLockPath, owner);
        throw new Error(`launch stoplight run lock busy: owner_pid=${owner?.pid || 'unknown'} age_ms=${ageMs} path=${runLockPath}`);
      }
      await sleep(Math.min(1000, 100 + attempts * 100));
    }
  }
}

function timeoutSignal(ms) {
  return AbortSignal.timeout(Math.max(1, ms));
}

function row(status, detail, evidence = {}) {
  return { status, detail, evidence };
}

function summarizeEmbedPauseHold(hold) {
  const raw = hold?.hold || {};
  return {
    active: hold?.active === true,
    reason: hold?.reason || null,
    file: hold?.file || null,
    pid: raw.pid || null,
    created_at: raw.created_at || null,
    expires_at: raw.expires_at || null,
    ttl_ms: raw.ttl_ms || null,
    metadata: raw.metadata || null,
  };
}

function activeEmbeddingDrainProofBlock(activeEmbedHold) {
  return {
    blocked_by_active_embedding_drain: true,
    chat_sla_applicability: 'n/a',
    exact_ann_proof_deferred: true,
    expected_while_draining: true,
    operator_action_required: false,
    next_action: 'none_for_chat_wait_for_embedding_drain_before_exact_data_plane_proof',
    recommended_command: 'node scripts/qa/data-pipeline-status.js --summary-json --respect-cadence --strict',
    live_refresh_command: 'node scripts/qa/data-pipeline-status.js --summary-json --strict',
    exact_proof_override_command: 'node scripts/qa/launch-stoplight.js --row data_pipeline_invariants --freeze-active-drain',
    hold_reason: activeEmbedHold?.reason || 'embed-pause-hold',
  };
}

function summarizeEmbedProofFreezeStatus(status) {
  const raw = status?.status || status || {};
  return {
    ok: status?.ok ?? true,
    active: raw.active === true,
    reason: raw.reason || status?.reason || null,
    id: raw.id || null,
    pid: raw.pid || null,
    topic: raw.topic || null,
    pending: Number.isFinite(Number(raw.pending)) ? Number(raw.pending) : null,
    embedded: Number.isFinite(Number(raw.embedded)) ? Number(raw.embedded) : null,
    parked_at: raw.parked_at || null,
    metadata: raw.metadata || null,
  };
}

async function waitForEmbedProofFreezeStatus(id, {
  timeoutMs = exactAnnDrainFreezeWaitMs,
  intervalMs = 500,
} = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started <= timeoutMs) {
    const status = readEmbedProofFreezeStatus();
    last = summarizeEmbedProofFreezeStatus(status);
    if (status.ok && status.status?.active === true && status.status?.id === id) {
      return {
        ok: true,
        reason: 'embed_proof_freeze_active',
        waited_ms: Date.now() - started,
        status: last,
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    reason: 'embed_proof_freeze_timeout',
    waited_ms: Date.now() - started,
    status: last,
  };
}

async function waitForEmbedProofFreezeStatusClear(id, {
  timeoutMs = 10_000,
  intervalMs = 500,
} = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started <= timeoutMs) {
    const status = readEmbedProofFreezeStatus();
    last = summarizeEmbedProofFreezeStatus(status);
    if (!status.ok || status.status?.id !== id) {
      return {
        ok: true,
        reason: 'embed_proof_freeze_status_cleared',
        waited_ms: Date.now() - started,
        status: last,
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    reason: 'embed_proof_freeze_status_still_present',
    waited_ms: Date.now() - started,
    status: last,
  };
}

function fetchOptionsFor(url) {
  return /^https:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/)/.test(String(url))
    ? { dispatcher: localTlsAgent }
    : {};
}

function localHealthUrls() {
  return process.env.ROBOTDOJO_LOCAL_BASE
    ? [`${localBase}/api/server-health`]
    : [`${localProxyBase}/api/server-health`, `${localBase}/api/server-health`];
}

function annGrowthThreshold(builtFrom) {
  const count = Number(builtFrom) || 0;
  if (count <= 0) return 1;
  return Math.max(annRebuildMinChunks, Math.ceil(count * annDriftThreshold));
}

function requiredBoundariesPass(body) {
  const required = Array.isArray(body?.required_boundaries) ? body.required_boundaries : [];
  return required.length > 0 && required.every((name) => body?.boundaries?.[name]?.ok === true);
}

function countsAllZero(counts) {
  return Object.values(counts || {}).every((value) => Number(value) === 0);
}

function readServerActivityRow(db) {
  return db.prepare(`
    SELECT in_flight, last_request_at, last_chat_request_at, last_chat_app_active_at, updated_at
    FROM server_activity
    WHERE id = 1
  `).get() || null;
}

function writeServerActivityRow(db, row) {
  if (!row) return false;
  db.prepare(`
    UPDATE server_activity
       SET in_flight = ?,
           last_request_at = ?,
           last_chat_request_at = ?,
           last_chat_app_active_at = ?,
           updated_at = ?
     WHERE id = 1
  `).run(
    Number(row.in_flight) || 0,
    Number(row.last_request_at) || 0,
    Number(row.last_chat_request_at) || 0,
    Number(row.last_chat_app_active_at) || 0,
    Number(row.updated_at) || 0,
  );
  return true;
}

function beginExactAnnProofEmbedFreeze(db) {
  const before = readServerActivityRow(db);
  const ttlMs = Number(process.env.ROBOTDOJO_STOPLIGHT_EXACT_ANN_FREEZE_TTL_MS || 15 * 60_000);
  const hold = beginEmbedPauseHold({
    reason: 'exact_ann_proof_embed_pause_hold',
    ttlMs,
    metadata: {
      source: 'launch-stoplight',
      server_activity_before: before,
    },
  });
  return {
    ...hold,
    reason: hold.ok ? 'exact_ann_proof_embed_freeze_active' : hold.reason,
    hold_reason: hold.reason,
    server_activity_before: before,
  };
}

function releaseExactAnnProofEmbedFreeze(db, freeze) {
  const release = releaseEmbedPauseHold(freeze);
  return {
    ...release,
    reason: release.ok && !release.skipped ? 'exact_ann_proof_embed_freeze_released' : release.reason,
    server_activity_after: readServerActivityRow(db),
  };
}

function activityRowsEqual(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

async function waitForStableActivityRow(db, { attempts = 3, intervalMs = 1200 } = {}) {
  const samples = [];
  let previous = readServerActivityRow(db);
  samples.push(previous);
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs);
    const current = readServerActivityRow(db);
    samples.push(current);
    if (activityRowsEqual(previous, current)) return { stable: true, samples };
    previous = current;
  }
  return { stable: false, samples };
}

async function proveForegroundActivityDeltas(db, base) {
  const attempts = [];
  for (let attempt = 1; attempt <= foregroundActivityDeltaAttempts; attempt += 1) {
    const stable = await waitForStableActivityRow(db);
    const evidence = {
      attempt,
      stable_before_probe: stable.stable,
      stable_samples: stable.samples,
    };
    if (!stable.stable) {
      attempts.push({
        ...evidence,
        skipped: true,
        reason: 'activity_row_not_quiet_enough_for_delta_proof',
      });
      continue;
    }

    const beforeStatic = readServerActivityRow(db);
    const staticRes = await fetchJson(`${base}/chat/app.js?v=5`, {}, 5000);
    await sleep(foregroundActivityProbeSettleMs);
    const afterStatic = readServerActivityRow(db);
    const staticUnchanged = activityRowsEqual(beforeStatic, afterStatic);

    if (!staticUnchanged) {
      let restore = { attempted: false };
      const currentBeforeRestore = readServerActivityRow(db);
      if (activityRowsEqual(currentBeforeRestore, afterStatic)) {
        try {
          writeServerActivityRow(db, beforeStatic);
          await sleep(250);
          restore = {
            attempted: true,
            restored: activityRowsEqual(readServerActivityRow(db), beforeStatic),
            before_restore: currentBeforeRestore,
            restored_to: beforeStatic,
            after_restore: readServerActivityRow(db),
          };
        } catch (err) {
          restore = { attempted: true, restored: false, error: err?.message || String(err) };
        }
      }
      attempts.push({
        ...evidence,
        skipped: false,
        static_asset: {
          status: staticRes.res.status,
          before: beforeStatic,
          after: afterStatic,
          unchanged: false,
        },
        restore,
        retry_reason: 'activity_changed_during_static_probe',
      });
      continue;
    }

    await sleep(1000);
    const beforeShell = readServerActivityRow(db);
    const shellRes = await fetchJson(`${base}/chat`, {}, 5000);
    await sleep(foregroundActivityProbeSettleMs);
    const afterShell = readServerActivityRow(db);
    const shellMoved = Number(afterShell?.last_request_at || 0) > Number(beforeShell?.last_request_at || 0)
      && Number(afterShell?.updated_at || 0) > Number(beforeShell?.updated_at || 0);

    let restore = { attempted: false };
    const currentBeforeRestore = readServerActivityRow(db);
    if (activityRowsEqual(currentBeforeRestore, afterShell)) {
      try {
        writeServerActivityRow(db, beforeStatic);
        await sleep(250);
        restore = {
          attempted: true,
          restored: activityRowsEqual(readServerActivityRow(db), beforeStatic),
          before_restore: currentBeforeRestore,
          restored_to: beforeStatic,
          after_restore: readServerActivityRow(db),
        };
      } catch (err) {
        restore = { attempted: true, restored: false, error: err?.message || String(err) };
      }
    } else {
      restore = {
        attempted: false,
        reason: 'activity_changed_after_probe',
        current: currentBeforeRestore,
        expected_probe_row: afterShell,
      };
    }

    const proof = {
      ...evidence,
      skipped: false,
      static_asset: {
        status: staticRes.res.status,
        before: beforeStatic,
        after: afterStatic,
        unchanged: staticUnchanged,
      },
      chat_shell: {
        status: shellRes.res.status,
        before: beforeShell,
        after: afterShell,
        moved: shellMoved,
      },
      restore,
    };
    attempts.push(proof);
    if (staticUnchanged && shellMoved) {
      return { ok: true, evidence: { ...proof, attempts } };
    }
  }

  const last = attempts.at(-1) || { skipped: true, reason: 'no_activity_delta_attempts' };
  const onlySkipped = attempts.length > 0 && attempts.every((item) => item.skipped === true);
  return {
    ok: onlySkipped,
    evidence: {
      ...last,
      skipped: onlySkipped,
      reason: onlySkipped ? 'activity_row_not_quiet_enough_for_delta_proof' : 'activity_delta_probe_failed',
      attempts,
    },
  };
}

function healthBackgroundSummary(body, supervisorHeartbeat = null) {
  const passive = body?.passive_jobs || {};
  const durable = body?.session_log_queue?.durable || {};
  const passiveReady = passive.ok === true && passive.warming !== true;
  const durableReady = durable.ok === true && durable.warming !== true;
  const passiveWarming = passive.warming === true || passive.reason === 'worker-summary-warming';
  const durableWarming = durable.warming === true || durable.reason === 'worker-summary-warming';
  const workerAlive = supervisorHeartbeat?.alive === true;
  const foregroundSafeWarming = workerAlive && (passiveWarming || durableWarming);
  const ready = passiveReady && durableReady;

  return {
    ready,
    state: ready
      ? 'ready'
      : foregroundSafeWarming
        ? 'foreground_safe_warming'
        : 'not_ready',
    passive_jobs: {
      ready: passiveReady,
      warming: passiveWarming,
      reason: passive.reason || passive.error || null,
      depth: passive.totals?.depth ?? null,
      checked_at: passive.checked_at || null,
      age_ms: passive._age_ms ?? null,
    },
    session_log_durable: {
      ready: durableReady,
      warming: durableWarming,
      reason: durable.reason || durable.error || null,
      depth: durable.totals?.depth ?? null,
      checked_at: durable.checked_at || null,
      age_ms: durable._age_ms ?? null,
    },
    supervisor: supervisorHeartbeat || null,
  };
}

function maintenanceForegroundState(db) {
  try {
    const now = Date.now();
    const signal = getActivitySignal(db);
    const worker = readMaintenanceWorkerState(now);
    const appOpen = chatAppActiveDecision(signal, { now });
    const activity = activityPauseDecision(signal, { now, pauseMs: maintenanceForegroundQuietMs });
    const hidIdleSeconds = getIdleSeconds();
    if (worker.boot_grace_active) {
      return {
        ok: false,
        reason: 'worker-boot-grace',
        signal,
        worker,
        hid_idle_seconds: hidIdleSeconds,
        quiet_ms: maintenanceForegroundQuietMs,
        hid_idle_threshold_seconds: maintenanceForegroundHidIdleSeconds,
      };
    }
    if (appOpen) {
      return {
        ok: false,
        reason: 'chat-app-open',
        signal,
        worker,
        hid_idle_seconds: hidIdleSeconds,
        quiet_ms: maintenanceForegroundQuietMs,
        hid_idle_threshold_seconds: maintenanceForegroundHidIdleSeconds,
      };
    }
    if (activity.pause) {
      return {
        ok: false,
        reason: activity.reason,
        signal,
        worker,
        hid_idle_seconds: hidIdleSeconds,
        quiet_ms: maintenanceForegroundQuietMs,
        hid_idle_threshold_seconds: maintenanceForegroundHidIdleSeconds,
      };
    }
    if ((Number(hidIdleSeconds) || 0) < maintenanceForegroundHidIdleSeconds) {
      return {
        ok: false,
        reason: 'user-active',
        signal,
        worker,
        hid_idle_seconds: hidIdleSeconds,
        quiet_ms: maintenanceForegroundQuietMs,
        hid_idle_threshold_seconds: maintenanceForegroundHidIdleSeconds,
      };
    }
    return {
      ok: true,
      reason: 'foreground-idle',
      signal,
      worker,
      hid_idle_seconds: hidIdleSeconds,
      quiet_ms: maintenanceForegroundQuietMs,
      hid_idle_threshold_seconds: maintenanceForegroundHidIdleSeconds,
    };
  } catch (err) {
    return { ok: false, reason: 'foreground-state-unreadable', error: err?.message || String(err) };
  }
}

function maintenanceWorkerLockPath() {
  return process.env.ROBOTDOJO_MAINT_LOCK
    || join(config.configDir || join(homedir(), '.robotdojo'), 'supervisor-maintenance.lock');
}

function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function processStartMs(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  const result = spawnSync('ps', ['-p', String(n), '-o', 'lstart='], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 3000,
  });
  if (result.status !== 0) return null;
  const ms = Date.parse(String(result.stdout || '').trim());
  return Number.isFinite(ms) ? ms : null;
}

function localAppProcessCandidates() {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.stdout || 'ps_failed', candidates: [] };
  }
  const indexPath = join(REPO_ROOT, 'index.js');
  const candidates = String(result.stdout || '')
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter(Boolean)
    .filter((candidate) => candidate.command.includes(indexPath))
    .filter((candidate) => processAlive(candidate.pid))
    .map((candidate) => ({
      ...candidate,
      process_started_ms: processStartMs(candidate.pid),
    }))
    .sort((a, b) => Number(b.process_started_ms || 0) - Number(a.process_started_ms || 0));
  return { ok: true, candidates };
}

function localAppRuntimeFreshnessEvidence() {
  const processEvidence = localAppProcessCandidates();
  const candidate = processEvidence.candidates?.[0] || null;
  const files = LOCAL_APP_FRESHNESS_FILES.map((rel) => {
    const path = join(REPO_ROOT, rel);
    let mtimeMs = null;
    try { mtimeMs = statSync(path).mtimeMs; } catch {}
    return {
      path: rel,
      mtime: Number.isFinite(mtimeMs) ? new Date(mtimeMs).toISOString() : null,
      stale: candidate && Number.isFinite(candidate.process_started_ms) && Number.isFinite(mtimeMs)
        ? candidate.process_started_ms < mtimeMs - 1000
        : true,
    };
  });
  const staleFiles = files.filter((file) => file.stale).map((file) => file.path);
  return {
    ok: processEvidence.ok === true && Boolean(candidate) && staleFiles.length === 0,
    process_found: Boolean(candidate),
    pid: candidate?.pid || null,
    process_started_at: Number.isFinite(candidate?.process_started_ms)
      ? new Date(candidate.process_started_ms).toISOString()
      : null,
    stale_files: staleFiles,
    files,
    candidates: processEvidence.candidates || [],
    error: processEvidence.error || null,
  };
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return null;
  }
}

function sha256File(path) {
  try {
    return crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function readMaintenanceWorkerState(now = Date.now()) {
  const lock_path = maintenanceWorkerLockPath();
  try {
    const raw = JSON.parse(readFileSync(lock_path, 'utf8'));
    const startedMs = Date.parse(raw?.started_at || '');
    const ageMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : null;
    const remainingMs = ageMs == null ? null : Math.max(0, maintenanceForegroundBootGraceMs - ageMs);
    return {
      lock_path,
      pid: Number(raw?.pid) || null,
      alive: processAlive(raw?.pid),
      started_at: raw?.started_at || null,
      age_ms: ageMs,
      boot_grace_ms: maintenanceForegroundBootGraceMs,
      boot_grace_remaining_ms: remainingMs,
      boot_grace_active: remainingMs !== null && remainingMs > 0,
    };
  } catch (err) {
    return {
      lock_path,
      pid: null,
      alive: false,
      started_at: null,
      age_ms: null,
      boot_grace_ms: maintenanceForegroundBootGraceMs,
      boot_grace_remaining_ms: null,
      boot_grace_active: false,
      error: err?.code === 'ENOENT' ? null : (err?.message || String(err)),
    };
  }
}

async function passiveRoutineLaunchHealth() {
  try {
    const { default: db } = await import('../../lib/db.js');
    const { ROUTINES } = await import('../../lib/maintenance-routines.js');
    const {
      PASSIVE_DEGRADATION_OWNERS,
      classifyPassiveJobDegradation,
      passiveJobUniqueKey,
    } = await import('../../lib/passive-jobs.js');
    const { repairStaleMaintenanceRoutinesForLaunch } = await import('../../lib/passive-supervisor.js');
    const repair = repairStaleMaintenanceRoutinesForLaunch();
    const criticalRoutines = ROUTINES
      .filter((routine) => LAUNCH_CRITICAL_ROUTINE_TYPES.has(routine.jobType))
      .map((routine) => {
        const targetId = routine.targetId || 'maintenance';
        return {
          job_type: routine.jobType,
          target_id: targetId,
          unique_key: passiveJobUniqueKey({
            jobType: routine.jobType,
            targetType: 'system',
            targetId,
          }),
        };
      });
    const keys = criticalRoutines.map((routine) => routine.unique_key);
    const rows = keys.length
      ? db.prepare(`
          SELECT unique_key, job_type, target_id, status, attempts, retry_count,
                 run_after, last_success_at, last_failure_at, last_error,
                 quarantine_reason, updated_at
            FROM passive_jobs
           WHERE unique_key IN (${keys.map(() => '?').join(', ')})
        `).all(...keys)
      : [];
    const byKey = new Map(rows.map((row) => [row.unique_key, row]));
    const now = Date.now();
    const critical = criticalRoutines.map((routine) => {
      const current = byKey.get(routine.unique_key) || null;
      const status = current?.status || 'missing';
      const runAfterMs = current?.run_after ? Date.parse(current.run_after) : NaN;
      const dueAgeMs = Number.isFinite(runAfterMs) ? Math.max(0, now - runAfterMs) : null;
      return {
        ...routine,
        status,
        open: status === 'queued' || status === 'running',
        blocked: status === 'quarantined',
        due: ['queued', 'paused'].includes(status) && Number.isFinite(runAfterMs) && runAfterMs <= now,
        due_age_ms: dueAgeMs,
        attempts: current?.attempts ?? null,
        retry_count: current?.retry_count ?? null,
        run_after: current?.run_after || null,
        last_success_at: current?.last_success_at || null,
        last_failure_at: current?.last_failure_at || null,
        last_error: current?.last_error || null,
        quarantine_reason: current?.quarantine_reason || null,
        updated_at: current?.updated_at || null,
      };
    });
    const quarantines = db.prepare(`
      SELECT job_type, target_id, COUNT(*) AS count,
             MAX(updated_at) AS latest_updated_at,
             MAX(last_failure_at) AS latest_failure_at,
             MAX(last_error) AS sample_error
        FROM passive_jobs
       WHERE status = 'quarantined'
       GROUP BY job_type, target_id
       ORDER BY count DESC, latest_updated_at DESC
       LIMIT 50
    `).all().map((current) => {
      const classification = classifyPassiveJobDegradation(current);
      return {
        job_type: current.job_type,
        target_id: current.target_id,
        count: Number(current.count || 0),
        latest_updated_at: current.latest_updated_at || null,
        latest_failure_at: current.latest_failure_at || null,
        sample_error: current.sample_error || null,
        launch_critical: LAUNCH_CRITICAL_ROUTINE_TYPES.has(current.job_type),
        degradation_owner: classification.owner,
        build_owned_degradation: classification.build_owned,
        degradation_action: classification.action,
        label: classification.label,
        owner_file: classification.owner_file,
      };
    });
    const foreground = maintenanceForegroundState(db);
    const blocked = critical.filter((routine) => routine.blocked);
    const staleOpen = critical.filter((routine) =>
      routine.open && routine.due === true && Number(routine.due_age_ms || 0) > maxCriticalRoutineDueMs);
    const stuck = foreground.ok === true ? staleOpen : [];
    const foregroundWaiting = foreground.ok !== true ? staleOpen : [];
    const buildOwnedDegraded = quarantines.filter((current) =>
      current.build_owned_degradation && !current.launch_critical);
    const visibleExternalDegraded = quarantines.filter((current) =>
      !current.build_owned_degradation && !current.launch_critical);
    const ownerActionRequired = visibleExternalDegraded.filter((current) =>
      current.degradation_owner === PASSIVE_DEGRADATION_OWNERS.OWNER_ACTION);
    const ok = blocked.length === 0 && stuck.length === 0 && buildOwnedDegraded.length === 0;
    return {
      ok,
      reason: !ok
        ? (blocked.length
          ? 'launch_critical_routine_quarantined'
          : stuck.length
            ? 'launch_critical_routine_stuck_open'
            : 'build_owned_degradation_present')
        : foregroundWaiting.length
          ? 'launch_critical_routines_foreground_safe_waiting'
          : 'launch_critical_routines_not_quarantined',
      repair,
      foreground,
      max_due_ms: maxCriticalRoutineDueMs,
      critical,
      blocked,
      stuck,
      foreground_waiting: foregroundWaiting,
      build_owned_degraded_quarantines: buildOwnedDegraded,
      visible_external_degraded_quarantines: visibleExternalDegraded,
      owner_action_required: ownerActionRequired,
      degraded_quarantines: quarantines.filter((current) => !current.launch_critical),
    };
  } catch (err) {
    return { ok: false, reason: 'passive_routine_launch_health_errored', error: err?.message || String(err) };
  }
}

function localApiBases(preferred = localBase) {
  const bases = [preferred];
  if (!process.env.ROBOTDOJO_LOCAL_BASE) bases.push(localProxyBase);
  bases.push(localBase);
  return [...new Set(bases.filter(Boolean).map((base) => String(base).replace(/\/+$/, '')))];
}

function fetchErrorEvidence(err) {
  return {
    error: err?.name || 'fetch_error',
    message: err?.message || String(err),
    cause_code: err?.cause?.code || null,
    cause_message: err?.cause?.message || null,
  };
}

async function adminDataPlaneProof(base = localBase) {
  if (!config.authToken) return { ok: false, error: 'auth_token_missing' };
  const attempts = [];
  const timeoutMs = Number(process.env.ROBOTDOJO_STOPLIGHT_DATA_PROOF_TIMEOUT_MS || 60_000);
  for (const proofBase of localApiBases(base)) {
    const proofUrl = `${proofBase}/api/admin/data-plane-proof`;
    let proof = null;
    let proofDurationMs = null;
    for (let attempt = 1; attempt <= dataProofFetchAttempts; attempt++) {
      const started = Date.now();
      try {
        proof = await fetchJson(proofUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.authToken}`,
          },
          body: JSON.stringify({ cleanup: true }),
        }, timeoutMs);
        proofDurationMs = Date.now() - started;
        const body = proof.body || {};
        const semantic = body.boundaries?.semantic_retrieval || {};
        const cleanup = body.cleanup || {};
        const semanticReady = semantic.ok === true
          && semantic.evidence?.state === 'semantic_ready'
          && semantic.checks?.ann_corpus_exactly_indexed === true
          && Number(semantic.counts?.ann_drift_chunks || 0) === 0;
        const proofOk = proof.res.ok
          && body.ok === true
          && requiredBoundariesPass(body)
          && semanticReady
          && cleanup.ok === true
          && countsAllZero(cleanup.remaining_after_cleanup);
        attempts.push({
          base: proofBase,
          ok: proofOk,
          attempt,
          status: proof.res.status,
          duration_ms: proofDurationMs,
          body_ok: body.ok === true,
          error: body.error || body.reason || null,
          semantic_ok: semantic.ok === true,
          semantic_ready: semanticReady,
          semantic_state: semantic.evidence?.state || null,
          cleanup_ok: cleanup.ok === true,
        });
        if (proofOk || attempt === dataProofFetchAttempts) {
          return {
            ok: proofOk,
            base: proofBase,
            status: proof.res.status,
            attempts,
            required_boundaries: body.required_boundaries || [],
            boundaries: body.boundaries || {},
            semantic_retrieval: {
              ok: semantic.ok === true,
              ready: semanticReady,
              state: semantic.evidence?.state || null,
              checks: semantic.checks || {},
              counts: semantic.counts || {},
            },
            cleanup: {
              ok: cleanup.ok === true,
              pre_existing_removed: cleanup.pre_existing_removed || cleanup.before || {},
              proof_rows_removed: cleanup.proof_rows_removed || cleanup.after || {},
              remaining_after_cleanup: cleanup.remaining_after_cleanup || {},
            },
          };
        }
        await sleep(dataProofRetryDelayMs);
      } catch (err) {
        attempts.push({
          base: proofBase,
          ok: false,
          attempt,
          duration_ms: Date.now() - started,
          ...fetchErrorEvidence(err),
        });
        if (attempt < dataProofFetchAttempts) await sleep(dataProofRetryDelayMs);
      }
    }
  }
  return { ok: false, error: 'data_plane_proof_fetch_failed', attempts };
}

async function fetchJson(url, init = {}, timeoutMs = 5000) {
  const res = await fetch(url, { ...fetchOptionsFor(url), ...init, signal: timeoutSignal(timeoutMs), redirect: 'manual' });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { res, body, text };
}

function setCookieValues(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get?.('set-cookie');
  if (!raw) return [];
  return String(raw).split(/,\s*(?=[A-Za-z0-9_%-]+=)/);
}

function cookieFrom(headers) {
  return setCookieValues(headers)
    .map((part) => String(part).split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function loginAt(base, { loginTimeoutMs = 30_000, verifyTimeoutMs = 8000 } = {}) {
  const token = config.authToken;
  if (!token) return { ok: false, error: 'auth_token_missing' };
  const login = await fetchJson(`${base}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, redirect: '/chat' }),
  }, loginTimeoutMs);
  const cookie = cookieFrom(login.res.headers);
  if (!login.res.ok || !cookie) {
    return { ok: false, status: login.res.status, body: login.body, error: 'token_login_failed' };
  }
  const me = await fetchJson(`${base}/api/auth/me`, { headers: { Cookie: cookie } }, verifyTimeoutMs);
  const refresh = await fetchJson(`${base}/api/auth/me`, { headers: { Cookie: cookie } }, verifyTimeoutMs);
  return {
    ok: me.res.ok && refresh.res.ok && Boolean(me.body?.user),
    cookie,
    status: { login: login.res.status, me: me.res.status, refresh: refresh.res.status },
    user: me.body?.user ? { email: me.body.user.email || null, belt: me.body.user.belt || null } : null,
  };
}

async function streamChatAt(base, cookie, { prompt, timeoutMs = 60_000, simulate = null } = {}) {
  const url = `${base}/api/chat/stream${simulate ? `?simulate=${encodeURIComponent(simulate)}` : ''}`;
  const conversationId = crypto.randomUUID();
  try {
    const res = await fetch(url, {
      ...fetchOptionsFor(url),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        conversationId,
        messages: [{ role: 'user', content: prompt }],
        context: 'general',
        thinking: 'low',
      }),
      signal: timeoutSignal(timeoutMs),
    });
    if (!res.ok || !res.body) return { ok: false, status: res.status, conversationId, error: 'chat_http_failed' };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let done = false;
    let ragMeta = null;
    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let event = null;
        try { event = JSON.parse(payload); } catch { continue; }
        if (event.type === 'delta') text += event.text || '';
        if (event.type === 'rag_meta') ragMeta = event;
        if (event.type === 'done') done = true;
        if (event.type === 'error') return { ok: false, status: res.status, conversationId, error: event.message || 'chat_error', ragMeta };
      }
    }
    return {
      ok: done && text.trim().length > 0,
      status: res.status,
      conversationId,
      done,
      text: text.trim(),
      text_chars: text.trim().length,
      ragMeta,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      conversationId,
      error: isTransientFetchStall(err) ? 'chat_stream_stalled' : 'chat_stream_failed',
      message: err?.message || String(err),
    };
  }
}

async function cleanupStoplightConversation(conversationId) {
  if (!conversationId) return { ok: true, skipped: true, reason: 'conversation_id_missing' };
  try {
    const { default: db } = await import('../../lib/db.js');
    const conv = db.prepare('SELECT file_path FROM conversations WHERE id = ?').get(conversationId) || null;
    const filePath = conv?.file_path || null;
    const counts = {};
    const tx = db.transaction(() => {
      for (const [name, sql] of [
        ['chat_turn_metrics', 'DELETE FROM chat_turn_metrics WHERE conversation_id = ?'],
        ['message_threads', 'DELETE FROM message_threads WHERE conversation_id = ?'],
        ['messages', 'DELETE FROM messages WHERE conversation_id = ?'],
        ['conversation_topics', 'DELETE FROM conversation_topics WHERE conversation_id = ?'],
        ['conversations', 'DELETE FROM conversations WHERE id = ?'],
      ]) {
        counts[name] = db.prepare(sql).run(conversationId).changes;
      }
    });
    tx();
    let transcript_deleted = false;
    if (filePath) {
      const remaining = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE file_path = ?').get(filePath)?.n || 0;
      if (remaining === 0 && existsSync(filePath)) {
        unlinkSync(filePath);
        transcript_deleted = true;
      }
    }
    const remaining = {
      chat_turn_metrics: db.prepare('SELECT COUNT(*) AS n FROM chat_turn_metrics WHERE conversation_id = ?').get(conversationId)?.n || 0,
      message_threads: db.prepare('SELECT COUNT(*) AS n FROM message_threads WHERE conversation_id = ?').get(conversationId)?.n || 0,
      messages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conversationId)?.n || 0,
      conversation_topics: db.prepare('SELECT COUNT(*) AS n FROM conversation_topics WHERE conversation_id = ?').get(conversationId)?.n || 0,
      conversations: db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ?').get(conversationId)?.n || 0,
    };
    const transcript_exists = Boolean(filePath && existsSync(filePath));
    const ok = Object.values(remaining).every((n) => Number(n) === 0) && !transcript_exists;
    return {
      ok,
      conversation_id: conversationId,
      deleted: counts,
      remaining,
      transcript_path: filePath,
      transcript_deleted,
      transcript_exists,
      reason: ok ? 'stoplight_conversation_cleaned' : 'stoplight_conversation_residue',
    };
  } catch (err) {
    return { ok: false, conversation_id: conversationId, error: err?.message || String(err) };
  }
}

function runCommand(command, commandArgs, { timeout = 60_000, env = {} } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    stdout: String(result.stdout || '').trim().split('\n').filter(Boolean).slice(-20),
    stderr: String(result.stderr || '').trim().split('\n').filter(Boolean).slice(-20),
  };
}

function tailLines(text, n = 20) {
  return String(text || '').trim().split('\n').filter(Boolean).slice(-n);
}

function envNumberAtLeast(name, fallback, minimum) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= minimum ? raw : fallback;
}

function parseDaemonLogClockMs(line, now = Date.now()) {
  const match = String(line || '').match(/^(\d{2}):(\d{2}):(\d{2})\s/);
  if (!match) return null;
  const date = new Date(now);
  date.setUTCHours(Number(match[1]), Number(match[2]), Number(match[3]), 0);
  let ms = date.getTime();
  if (ms - now > 60_000) ms -= 24 * 60 * 60 * 1000;
  return Number.isFinite(ms) ? ms : null;
}

function isEmbedDaemonProgressLine(line) {
  const text = String(line || '');
  return /\]\s+\S+:\s+\+\d+\s+\(/.test(text)
    || /^\[embed\]\s+topic="[^"]+"\s+embedded\s+\d+\s+chunks\b/.test(text)
    || /\bwrote\s+[1-9]\d*\s+this slice\b/.test(text);
}

function nearestDaemonLogClockMs(lines, index, now = Date.now()) {
  const direct = parseDaemonLogClockMs(lines[index], now);
  if (direct !== null) return direct;
  for (let i = index - 1; i >= 0; i -= 1) {
    const previous = parseDaemonLogClockMs(lines[i], now);
    if (previous !== null) return previous;
  }
  return null;
}

function daemonForegroundPauseState(db) {
  const now = Date.now();
  const activity = activityPauseDecision(getActivitySignal(db), { now });
  if (activity.pause) {
    return { pause: true, reason: activity.reason, source: 'server_activity' };
  }
  const hidIdleSeconds = getIdleSeconds();
  if (daemonForegroundIdleSeconds > 0 && hidIdleSeconds < daemonForegroundIdleSeconds) {
    return {
      pause: true,
      reason: 'user-active',
      source: 'hid',
      hid_idle_seconds: hidIdleSeconds,
      foreground_idle_seconds: daemonForegroundIdleSeconds,
    };
  }
  return {
    pause: false,
    reason: 'quiet',
    source: 'none',
    hid_idle_seconds: hidIdleSeconds,
    foreground_idle_seconds: daemonForegroundIdleSeconds,
  };
}

async function embedDaemonRuntimeEvidence() {
  const logPath = process.env.ROBOTDOJO_EMBED_DAEMON_LOG
    || join(config.configDir || join(homedir(), '.robotdojo'), 'logs', 'robotdojo-chunk-embed-daemon.out.log');
  const maxRequestPauseMs = envNumberAtLeast('ROBOTDOJO_STOPLIGHT_MAX_EMBED_REQUEST_PAUSE_MS', 10_000, 1);
  const maxProgressAgeMs = envNumberAtLeast('ROBOTDOJO_STOPLIGHT_MAX_EMBED_PROGRESS_AGE_MS', 20 * 60_000, 60_000);
  const maxStartupProgressMs = envNumberAtLeast('ROBOTDOJO_STOPLIGHT_MAX_EMBED_STARTUP_PROGRESS_MS', 5 * 60_000, 60_000);
  const processProbe = runCommand('pgrep', ['-fl', 'chunk-embed-daemon'], { timeout: 3000 });
  const evidence = {
    log_path: logPath,
    max_request_pause_ms: maxRequestPauseMs,
    max_progress_age_ms: maxProgressAgeMs,
    max_startup_progress_ms: maxStartupProgressMs,
    process: {
      ok: processProbe.ok,
      status: processProbe.status,
      count: processProbe.stdout.length,
      lines: processProbe.stdout,
      error: processProbe.stderr,
    },
  };

  if (!existsSync(logPath)) return { ok: false, reason: 'embed_daemon_log_missing', ...evidence };

  const lines = tailLines(readFileSync(logPath, 'utf8'), embedDaemonLogScanLines);
  const latestStartIndex = lines.findLastIndex((line) => line.includes('start —') && line.includes('requestPauseMs='));
  const latestStartupGraceIndex = lines.findLastIndex((line) => /startup grace \d+ms/.test(line));
  const latestLifecycleIndex = Math.max(latestStartIndex, latestStartupGraceIndex);
  if (latestLifecycleIndex === -1) {
    return { ok: false, reason: 'embed_daemon_start_line_missing', ...evidence, recent_log: lines.slice(-40) };
  }

  const latestStart = latestStartIndex === -1 ? null : lines[latestStartIndex];
  const latestLifecycleLine = lines[latestLifecycleIndex];
  const inStartupGrace = latestStartupGraceIndex > latestStartIndex;
  const afterStart = lines.slice(latestLifecycleIndex);
  const requestPauseMatch = latestStart?.match(/\brequestPauseMs=(\d+)\b/);
  const requestPauseMs = requestPauseMatch ? Number(requestPauseMatch[1]) : null;
  let pendingBacklog = null;
  let foregroundPause = { pause: false, reason: 'unknown', source: 'unread' };
  try {
    const { default: db } = await import('../../lib/db.js');
    pendingBacklog = Number(db.prepare(`
      SELECT COUNT(*) AS n
      FROM chunks
      WHERE embedded = 0
        AND COALESCE(skip_embed, 0) = 0
    `).get()?.n || 0);
    foregroundPause = daemonForegroundPauseState(db);
  } catch (err) {
    foregroundPause = { pause: false, reason: 'unread', source: 'error', error: err?.message || String(err) };
  }
  const recentRequestPauseTicks = afterStart
    .map((line) => {
      const match = line.match(/daemon:pause-tick — elapsedMs=(\d+) reason=recent-request(?: reasonElapsedMs=(\d+))?/);
      return match ? { line, elapsed_ms: Number(match[2] || match[1]) } : null;
    })
    .filter(Boolean);
  const overlongRecentRequestPause = recentRequestPauseTicks.find((tick) => tick.elapsed_ms > maxRequestPauseMs * 2);
  const now = Date.now();
  const progressEntries = afterStart
    .map((line, index) => isEmbedDaemonProgressLine(line)
      ? { line, at_ms: nearestDaemonLogClockMs(afterStart, index, now) }
      : null)
    .filter(Boolean);
  const recentProgress = progressEntries.slice(-10);
  const latestStartAtMs = parseDaemonLogClockMs(latestLifecycleLine, now);
  const latestStartAgeMs = latestStartAtMs === null ? null : Math.max(0, now - latestStartAtMs);
  const latestProgress = recentProgress.at(-1) || null;
  const latestProgressLine = latestProgress?.line || null;
  const latestProgressAtMs = latestProgress?.at_ms ?? null;
  const latestProgressAgeMs = latestProgressAtMs === null ? null : Math.max(0, now - latestProgressAtMs);
  const startupProgressGrace = latestProgressLine === null
    && pendingBacklog > 0
    && latestStartAgeMs !== null
    && (inStartupGrace || latestStartAgeMs <= maxStartupProgressMs);
  const progressFresh = pendingBacklog === 0
    || foregroundPause.pause === true
    || startupProgressGrace
    || (latestProgressAgeMs !== null && latestProgressAgeMs <= maxProgressAgeMs);
  const pauseLines = afterStart.filter((line) => /activity-pause|daemon:pause-tick/.test(line)).slice(-10);
  const heartbeatLines = afterStart.filter((line) => line.includes('daemon:heartbeat')).slice(-10);
  const runtime = {
    latest_start: latestStart,
    latest_start_age_ms: latestStartAgeMs,
    latest_lifecycle_line: latestLifecycleLine,
    in_startup_grace: inStartupGrace,
    request_pause_ms: requestPauseMs,
    pending_backlog: pendingBacklog,
    foreground_pause: foregroundPause,
    latest_progress_line: latestProgressLine,
    latest_progress_at_ms: latestProgressAtMs,
    latest_progress_age_ms: latestProgressAgeMs,
    startup_progress_grace: startupProgressGrace,
    progress_fresh: progressFresh,
    recent_progress: recentProgress.map((entry) => entry.line),
    recent_pauses: pauseLines,
    recent_heartbeats: heartbeatLines,
    overlong_recent_request_pause: overlongRecentRequestPause || null,
  };

  if (!evidence.process.ok || evidence.process.count < 1) {
    return { ok: false, reason: 'embed_daemon_process_missing', ...evidence, ...runtime };
  }
  if (!inStartupGrace && !Number.isFinite(requestPauseMs)) {
    return { ok: false, reason: 'embed_daemon_request_pause_unparseable', ...evidence, ...runtime };
  }
  if (!inStartupGrace && requestPauseMs > maxRequestPauseMs) {
    return { ok: false, reason: 'generic_request_pause_too_long', ...evidence, ...runtime };
  }
  if (overlongRecentRequestPause) {
    return { ok: false, reason: 'recent_request_pause_exceeded_runtime_cap', ...evidence, ...runtime };
  }
  if (!progressFresh) {
    return { ok: false, reason: 'embed_daemon_progress_stale_with_backlog', ...evidence, ...runtime };
  }
  return { ok: true, reason: 'embed_daemon_runtime_request_pause_launch_safe', ...evidence, ...runtime };
}

function embedWriterProcessEvidence() {
  const probe = runCommand('pgrep', ['-fl', 'chunk-embed-daemon|drain-personal-embeddings|chunk-embed-lane'], { timeout: 3000 });
  const lines = probe.stdout || [];
  return {
    ok: probe.ok,
    status: probe.status,
    lines,
    daemon: lines.filter((line) => /chunk-embed-daemon\.mjs/.test(line)),
    drain: lines.filter((line) => /drain-personal-embeddings\.mjs/.test(line)),
    lanes: lines.filter((line) => /chunk-embed-lane\.mjs/.test(line)),
    stderr: probe.stderr,
  };
}

function daemonHoldLogEvidence(hold) {
  const logPath = process.env.ROBOTDOJO_EMBED_DAEMON_LOG
    || join(config.configDir || join(homedir(), '.robotdojo'), 'logs', 'robotdojo-chunk-embed-daemon.out.log');
  if (!existsSync(logPath)) {
    return {
      ok: false,
      reason: 'embed_daemon_log_missing',
      log_path: logPath,
    };
  }
  const now = Date.now();
  const lines = tailLines(readFileSync(logPath, 'utf8'), embedDaemonLogScanLines);
  const holdReason = hold?.reason || null;
  const holdCreatedAt = Number(hold?.hold?.created_at || 0);
  const latestPauseIndex = lines.findLastIndex((line) =>
    holdReason && (
      line.includes(`daemon:pause-tick`) && line.includes(`reason=${holdReason}`)
      || line.includes(`activity-pause — ${holdReason}`)
    ));
  const latestPauseLine = latestPauseIndex >= 0 ? lines[latestPauseIndex] : null;
  const latestPauseAtMs = latestPauseIndex >= 0 ? nearestDaemonLogClockMs(lines, latestPauseIndex, now) : null;
  const latestWriteIndex = lines.findLastIndex((line) => /\[chunk-embed-daemon\]\s+\S+:\s+\+\d+\s+\(/.test(line));
  const latestWriteLine = latestWriteIndex >= 0 ? lines[latestWriteIndex] : null;
  const latestWriteAtMs = latestWriteIndex >= 0 ? nearestDaemonLogClockMs(lines, latestWriteIndex, now) : null;
  const latestPauseAgeMs = latestPauseAtMs === null ? null : Math.max(0, now - latestPauseAtMs);
  const latestPauseAfterHold = holdCreatedAt > 0
    && latestPauseAtMs !== null
    && latestPauseAtMs + 1000 >= holdCreatedAt;
  const latestWriteAfterHold = holdCreatedAt > 0
    && latestWriteAtMs !== null
    && latestWriteAtMs > holdCreatedAt + 5000;
  return {
    ok: true,
    reason: 'embed_daemon_log_read',
    log_path: logPath,
    hold_reason: holdReason,
    hold_created_at: holdCreatedAt || null,
    latest_pause_line: latestPauseLine,
    latest_pause_at_ms: latestPauseAtMs,
    latest_pause_age_ms: latestPauseAgeMs,
    latest_pause_after_hold: latestPauseAfterHold,
    latest_write_line: latestWriteLine,
    latest_write_at_ms: latestWriteAtMs,
    latest_write_after_hold: latestWriteAfterHold,
    recent: lines.slice(-40),
  };
}

async function embedWriterExclusivity() {
  const hold = readEmbedPauseHold({ maxCacheMs: 0 });
  const holdSummary = summarizeEmbedPauseHold(hold);
  const processes = embedWriterProcessEvidence();
  const daemonLog = daemonHoldLogEvidence(hold);
  const evidence = {
    embed_pause_hold: holdSummary,
    hold_process_alive: holdSummary.pid ? processAlive(holdSummary.pid) : false,
    processes,
    daemon_log: daemonLog,
    max_pause_age_ms: embedWriterExclusivityMaxPauseAgeMs,
  };

  if (!holdSummary.active) {
    const ok = processes.drain.length === 0 && processes.daemon.length >= 1;
    return ok
      ? row('green', 'product embed daemon is the only active embed writer', evidence)
      : row('red', 'embed writer ownership is ambiguous without an active hold', evidence);
  }

  if (holdSummary.reason !== 'drain_personal_embeddings_sole_writer') {
    return row('red', 'embed writer hold is owned by a non-drain process', evidence);
  }
  if (!evidence.hold_process_alive) {
    return row('red', 'embed writer hold owner process is not alive', evidence);
  }
  if (processes.drain.length < 1) {
    return row('red', 'embed writer drain hold is active but no drain process is visible', evidence);
  }
  if (processes.daemon.length < 1) {
    return row('red', 'durable embed daemon is missing while temporary drain owns writer', evidence);
  }
  if (!daemonLog.ok) {
    return row('red', 'embed writer exclusivity could not read daemon log', evidence);
  }
  if (daemonLog.latest_write_after_hold) {
    return row('red', 'durable embed daemon wrote after the temporary drain took ownership', evidence);
  }
  if (!daemonLog.latest_pause_line || !daemonLog.latest_pause_after_hold || daemonLog.latest_pause_age_ms > embedWriterExclusivityMaxPauseAgeMs) {
    return row('red', 'durable embed daemon has not recently acknowledged the current drain pause hold', evidence);
  }

  return row('green', 'temporary drain owns the embed writer and durable daemon is paused', evidence);
}

function latestPersonalDrainLogPath() {
  const configured = process.env.ROBOTDOJO_PERSONAL_DRAIN_LOG || process.env.ROBOTDOJO_DRAIN_PERSONAL_LOG;
  if (configured) return configured;
  const logDir = join(config.configDir || join(homedir(), '.robotdojo'), 'logs');
  try {
    const candidates = readdirSync(logDir)
      .filter((name) => /^drain-personal-embeddings.*\.log$/.test(name))
      .map((name) => {
        const file = join(logDir, name);
        let mtimeMs = 0;
        try { mtimeMs = statSync(file).mtimeMs; } catch {}
        return { file, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.file || join(logDir, 'drain-personal-embeddings.log');
  } catch {
    return join(logDir, 'drain-personal-embeddings.log');
  }
}

function parsePersonalDrainLog(logPath, topic = personalDrainTopic) {
  if (!existsSync(logPath)) {
    return {
      ok: false,
      reason: 'personal_drain_log_missing',
      path: logPath,
      mtime_ms: null,
      recent: [],
    };
  }
  const stat = statSync(logPath);
  const lines = tailLines(readFileSync(logPath, 'utf8'), embedDaemonLogScanLines);
  const topicProgressPrefix = topic ? `[embed] topic="${topic}" embedded ` : null;
  const latestProgressLine = topicProgressPrefix
    ? lines.findLast((line) => line.includes(topicProgressPrefix)) || null
    : lines.findLast((line) => /^\[embed\]\s+topic="[^"]+"\s+embedded\s+\d+\s+chunks\b/.test(line)) || null;
  const latestStartLine = lines.findLast((line) => line.includes('[drain-personal] start topic=')) || null;
  const latestSelectedLine = lines.findLast((line) => line.includes('[drain-personal] work-order selected topic=')) || null;
  const latestFreezeLine = lines.findLast((line) => line.includes('[drain-personal] exact proof freeze')) || null;
  const latestPassLine = lines.findLast((line) => line.includes('[drain-personal] pass=')) || null;
  const passMatch = latestPassLine?.match(/\bpass=(\d+)(?:\s+topic=([^\s]+))?\s+embedded=(\d+)\s+completed=(\d+)\s+reused=(\d+)\s+pending=(\d+)\s+rate_per_hour=(\d+)\s+aborted=([^\s]+)/);
  const latestDrainProgressLine = lines.findLast((line) => line.includes('[drain-personal] progress ')) || null;
  const drainProgressMatch = latestDrainProgressLine?.match(/\bpass=([^\s]+)\s+topic=([^\s]+)\s+completed=(\d+)\s+embedded=(\d+)\s+reused=(\d+)\s+pending_estimate=([^\s]+)\s+rate_per_hour=(\d+)\s+elapsed_ms=(\d+)/);
  const progressMatch = latestProgressLine?.match(/^\[embed\]\s+topic="([^"]+)"\s+embedded\s+(\d+)\s+chunks\b/);
  return {
    ok: true,
    reason: 'personal_drain_log_read',
    path: logPath,
    mtime_ms: stat.mtimeMs,
    mtime_age_ms: Math.max(0, Date.now() - stat.mtimeMs),
    latest_start: latestStartLine,
    latest_selected: latestSelectedLine,
    latest_progress: latestProgressLine,
    latest_progress_topic: progressMatch ? progressMatch[1] : null,
    latest_progress_count: progressMatch ? Number(progressMatch[2]) : null,
    latest_freeze: latestFreezeLine,
    latest_pass: passMatch ? {
      line: latestPassLine,
      pass: Number(passMatch[1]),
      topic: passMatch[2] || null,
      embedded: Number(passMatch[3]),
      completed: Number(passMatch[4]),
      reused: Number(passMatch[5]),
      pending: Number(passMatch[6]),
      rate_per_hour: Number(passMatch[7]),
      aborted: passMatch[8],
    } : null,
    latest_drain_progress: drainProgressMatch ? {
      line: latestDrainProgressLine,
      pass: drainProgressMatch[1] === 'unknown' ? null : Number(drainProgressMatch[1]),
      topic: drainProgressMatch[2],
      completed: Number(drainProgressMatch[3]),
      embedded: Number(drainProgressMatch[4]),
      reused: Number(drainProgressMatch[5]),
      pending_estimate: drainProgressMatch[6] === 'unknown' ? null : Number(drainProgressMatch[6]),
      rate_per_hour: Number(drainProgressMatch[7]),
      elapsed_ms: Number(drainProgressMatch[8]),
    } : null,
    recent: lines.slice(-40),
  };
}

function diskFreeEvidence(path = config.configDir || join(homedir(), '.robotdojo')) {
  const result = spawnSync('df', ['-Pk', path], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 3000,
  });
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  const fields = (lines[1] || '').trim().split(/\s+/);
  const availableKb = Number(fields[3]);
  const freeGb = Number.isFinite(availableKb) ? availableKb / 1024 / 1024 : null;
  return {
    ok: result.status === 0 && freeGb !== null,
    status: result.status,
    path,
    free_gb: freeGb === null ? null : Number(freeGb.toFixed(2)),
    min_free_gb: personalDrainMinFreeGb,
    above_floor: freeGb === null ? false : freeGb >= personalDrainMinFreeGb,
    stdout: lines,
    stderr: String(result.stderr || '').trim().split('\n').filter(Boolean).slice(-5),
  };
}

function readDrainTopicCounts(db, topic = personalDrainTopic) {
  const sql = topic === null ? `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(embedded, 0) = 1 THEN 1 ELSE 0 END) AS embedded,
      SUM(CASE WHEN COALESCE(embedded, 0) = 0 AND COALESCE(skip_embed, 0) = 0 THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN COALESCE(skip_embed, 0) = 1 THEN 1 ELSE 0 END) AS skipped
    FROM chunks
  ` : `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(embedded, 0) = 1 THEN 1 ELSE 0 END) AS embedded,
      SUM(CASE WHEN COALESCE(embedded, 0) = 0 AND COALESCE(skip_embed, 0) = 0 THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN COALESCE(skip_embed, 0) = 1 THEN 1 ELSE 0 END) AS skipped
    FROM chunks
    WHERE topic = ?
  `;
  const row = topic === null
    ? db.prepare(sql).get()
    : db.prepare(sql).get(topic);
  return {
    topic: topic === null ? '*' : topic,
    total: Number(row?.total || 0),
    embedded: Number(row?.embedded || 0),
    pending: Number(row?.pending || 0),
    skipped: Number(row?.skipped || 0),
    checked_at_ms: Date.now(),
    checked_at: new Date().toISOString(),
  };
}

function drainProgressSummary(before, after, { baseline = null } = {}) {
  const elapsedMs = Math.max(1, Number(after?.checked_at_ms || 0) - Number(before?.checked_at_ms || 0));
  const embeddedDelta = Math.max(0, Number(after?.embedded || 0) - Number(before?.embedded || 0));
  const pendingDelta = Math.max(0, Number(before?.pending || 0) - Number(after?.pending || 0));
  const completed = Math.max(embeddedDelta, pendingDelta);
  const ratePerHour = completed > 0 ? completed * 3_600_000 / elapsedMs : 0;
  const baselineRateRaw = Number(baseline?.rate_per_hour);
  const baselineRate = Number.isFinite(baselineRateRaw) && baselineRateRaw > 0 ? baselineRateRaw : null;
  const sampleRepresentative = completed >= personalDrainEtaMinCompleted;
  const baselineRepresentative = baselineRate !== null && baseline?.representative === true;
  const sampleRateForEta = sampleRepresentative && ratePerHour > 0 ? ratePerHour : null;
  const conservativeRate = baselineRate === null
    ? sampleRateForEta
    : (sampleRateForEta === null ? baselineRate : Math.min(sampleRateForEta, baselineRate));
  const etaRepresentative = sampleRepresentative || baselineRepresentative;
  const etaHours = ratePerHour > 0 ? Number((Number(after?.pending || 0) / ratePerHour).toFixed(1)) : null;
  const conservativeEtaHours = conservativeRate > 0
    ? Number((Number(after?.pending || 0) / conservativeRate).toFixed(1))
    : null;
  return {
    elapsed_ms: elapsedMs,
    embedded_delta: embeddedDelta,
    pending_delta: pendingDelta,
    completed,
    rate_per_hour: Number(ratePerHour.toFixed(1)),
    baseline_rate_per_hour: baselineRate,
    baseline_rate_source: baseline?.source || null,
    baseline_rate_completed: baseline?.completed ?? null,
    baseline_rate_representative: baselineRepresentative,
    eta_min_completed: personalDrainEtaMinCompleted,
    sample_eta_representative: sampleRepresentative,
    eta_representative: etaRepresentative,
    conservative_rate_per_hour: conservativeRate === null ? null : Number(conservativeRate.toFixed(1)),
    eta_hours: etaHours,
    eta_days: etaHours === null ? null : Number((etaHours / 24).toFixed(1)),
    conservative_eta_hours: conservativeEtaHours,
    conservative_eta_days: conservativeEtaHours === null ? null : Number((conservativeEtaHours / 24).toFixed(1)),
    full_drain_eta_exceeds_48h: etaRepresentative && conservativeEtaHours !== null ? conservativeEtaHours > 48 : null,
  };
}

function drainBaselineEvidenceFromLog(log) {
  const inPassRate = Number(log?.latest_drain_progress?.rate_per_hour);
  const inPassCompleted = Number(log?.latest_drain_progress?.completed);
  if (
    Number.isFinite(inPassRate)
    && inPassRate > 0
    && Number.isFinite(inPassCompleted)
    && inPassCompleted >= personalDrainEtaMinCompleted
  ) {
    return {
      rate_per_hour: inPassRate,
      completed: inPassCompleted,
      representative: true,
      source: 'in_pass_progress',
    };
  }
  const completedPassRate = Number(log?.latest_pass?.rate_per_hour);
  const completedPassCompleted = Number(log?.latest_pass?.completed);
  if (Number.isFinite(completedPassRate) && completedPassRate > 0) {
    return {
      rate_per_hour: completedPassRate,
      completed: Number.isFinite(completedPassCompleted) ? completedPassCompleted : null,
      representative: Number.isFinite(completedPassCompleted) && completedPassCompleted >= personalDrainEtaMinCompleted,
      source: 'latest_completed_pass',
    };
  }
  return null;
}

function foregroundDrainPauseEvidence(db) {
  try {
    const signal = getActivitySignal(db);
    const activity = activityPauseDecision(signal, { pauseMs: 0 });
    const chat = chatAppActiveDecision(signal);
    return {
      pause: Boolean(chat || activity.pause),
      chat_app_active: Boolean(chat),
      activity_pause: Boolean(activity.pause),
      activity_reason: activity.reason || null,
      signal,
    };
  } catch (err) {
    return {
      pause: false,
      chat_app_active: false,
      activity_pause: false,
      activity_reason: 'unreadable',
      error: err?.message || String(err),
    };
  }
}

function postDrainWatcherEvidence(now = Date.now(), { liveEmbedded = null } = {}) {
  const result = spawnSync('launchctl', ['list'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 5000,
  });
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  const launchdLine = lines.find((line) => line.trim().endsWith(`\t${postDrainWatcherLabel}`))
    || lines.find((line) => line.includes(postDrainWatcherLabel))
    || null;
  const fields = launchdLine ? launchdLine.trim().split(/\s+/) : [];
  const pid = fields[0] && fields[0] !== '-' ? Number(fields[0]) : null;
  const launchdStatus = fields[1] && fields[1] !== '-' ? Number(fields[1]) : null;
  const status = readJsonFile(postDrainStatusPath);
  const updatedMs = status?.updated_at ? Date.parse(status.updated_at) : NaN;
  const statusAgeMs = Number.isFinite(updatedMs) ? Math.max(0, now - updatedMs) : null;
  const statusFresh = statusAgeMs !== null && statusAgeMs <= postDrainMaxStatusAgeMs;
  const failedStatus = ['failed', 'blocked_by_lock'].includes(status?.status);
  const alive = pid ? processAlive(pid) : false;
  const preflight = postDrainPreflightEvidence(now, { liveEmbedded });
  return {
    ok: result.status === 0
      && launchdLine !== null
      && alive
      && statusFresh
      && !failedStatus
      && preflight.ok === true,
    label: postDrainWatcherLabel,
    launchd_line: launchdLine,
    launchd_status: launchdStatus,
    pid,
    process_alive: alive,
    status_path: postDrainStatusPath,
    status: status?.status || null,
    status_updated_at: status?.updated_at || null,
    status_age_ms: statusAgeMs,
    max_status_age_ms: postDrainMaxStatusAgeMs,
    status_fresh: statusFresh,
    failed_status: failedStatus,
    preflight,
    readiness: status?.readiness || null,
    launchctl: {
      ok: result.status === 0,
      status: result.status,
      stderr: String(result.stderr || '').trim().split('\n').filter(Boolean).slice(-5),
    },
  };
}

function postDrainPreflightAnnSourceEvidence(evidence, { liveEmbedded = null } = {}) {
  const projection = evidence?.global_ann_source_projection || null;
  const embedded = Number(projection?.embedded_total);
  const readable = Number(projection?.readable_vectors);
  const live = Number(liveEmbedded);
  const lag = Number.isFinite(live) && Number.isFinite(embedded)
    ? Math.max(0, live - embedded)
    : null;
  const ok = projection?.ok === true
    && Number.isFinite(embedded)
    && embedded > 0
    && Number.isFinite(readable)
    && readable === embedded
    && Number(projection?.missing_vectors || 0) === 0
    && Number(projection?.malformed_rows || 0) === 0;
  return {
    ok,
    present: Boolean(projection),
    embedded_total: Number.isFinite(embedded) ? embedded : null,
    readable_vectors: Number.isFinite(readable) ? readable : null,
    missing_vectors: Number(projection?.missing_vectors || 0),
    malformed_rows: Number(projection?.malformed_rows || 0),
    hnsw_dims: Number(projection?.hnsw_dims || 0) || null,
    live_embedded: Number.isFinite(live) ? live : null,
    lag_chunks: lag,
    max_lag_chunks: postDrainPreflightMaxAnnSourceLag,
    within_lag: lag === null ? null : lag <= postDrainPreflightMaxAnnSourceLag,
  };
}

function postDrainPreflightEvidence(now = Date.now(), { liveEmbedded = null } = {}) {
  const evidence = readJsonFile(postDrainPreflightPath);
  const checkedMs = Date.parse(String(evidence?.checked_at || ''));
  const ageMs = Number.isFinite(checkedMs) ? Math.max(0, now - checkedMs) : null;
  const fresh = ageMs !== null && ageMs <= postDrainMaxPreflightAgeMs;
  const diskSha = sha256File(postDrainPreflightScript);
  const evidenceSha = evidence?.script?.sha256 || null;
  const scriptMatchesDisk = Boolean(diskSha && evidenceSha && diskSha === evidenceSha);
  const dbSnapshots = Array.isArray(evidence?.db_snapshots) ? evidence.db_snapshots : [];
  const dbSnapshotChecksOk = dbSnapshots.length >= 2 && dbSnapshots.every((snapshot) => (
    snapshot?.ok === true
      && snapshot?.snapshot_method === 'clone'
      && snapshot?.verification?.ok === true
      && snapshot?.verification?.mode === 'open_schema'
  ));
  const commandChecks = Array.isArray(evidence?.post_drain_commands) ? evidence.post_drain_commands : [];
  const commandChecksOk = commandChecks.length > 0 && commandChecks.every((item) => item?.exists === true);
  const selfCommandPresent = commandChecks.some((item) => item?.rel === 'scripts/qa/post-drain-preflight.js');
  const dependencyChecks = Array.isArray(evidence?.post_drain_dependencies) ? evidence.post_drain_dependencies : [];
  const dependencyChecksOk = dependencyChecks.length > 0 && dependencyChecks.every((item) => item?.exists === true);
  const commandHashChecks = commandChecks.map((item) => {
    const rel = String(item?.rel || '');
    const currentSha = rel ? sha256File(join(REPO_ROOT, rel)) : null;
    const recordedSha = item?.sha256 || null;
    return {
      rel,
      exists: item?.exists === true,
      recorded_sha256: recordedSha,
      current_sha256: currentSha,
      matches_disk: Boolean(recordedSha && currentSha && recordedSha === currentSha),
    };
  });
  const commandHashMissing = commandHashChecks.filter((item) => item.exists && !item.recorded_sha256).map((item) => item.rel);
  const commandHashMissingCurrent = commandHashChecks.filter((item) => item.exists && !item.current_sha256).map((item) => item.rel);
  const commandHashMismatches = commandHashChecks.filter((item) => item.recorded_sha256 && item.current_sha256 && item.recorded_sha256 !== item.current_sha256).map((item) => item.rel);
  const dependencyHashChecks = dependencyChecks.map((item) => {
    const rel = String(item?.rel || '');
    const currentSha = rel ? sha256File(join(REPO_ROOT, rel)) : null;
    const recordedSha = item?.sha256 || null;
    return {
      rel,
      exists: item?.exists === true,
      recorded_sha256: recordedSha,
      current_sha256: currentSha,
      matches_disk: Boolean(recordedSha && currentSha && recordedSha === currentSha),
    };
  });
  const dependencyHashMissing = dependencyHashChecks.filter((item) => item.exists && !item.recorded_sha256).map((item) => item.rel);
  const dependencyHashMissingCurrent = dependencyHashChecks.filter((item) => item.exists && !item.current_sha256).map((item) => item.rel);
  const dependencyHashMismatches = dependencyHashChecks.filter((item) => item.recorded_sha256 && item.current_sha256 && item.recorded_sha256 !== item.current_sha256).map((item) => item.rel);
  const commandCheckRels = new Set(commandChecks.map((item) => String(item?.rel || '')).filter(Boolean));
  const dependencyCheckRels = new Set(dependencyChecks.map((item) => String(item?.rel || '')).filter(Boolean));
  const commandHashMissingRequired = REQUIRED_POST_DRAIN_PREFLIGHT_COMMANDS
    .filter((rel) => !commandCheckRels.has(rel));
  const dependencyHashMissingRequired = REQUIRED_POST_DRAIN_PREFLIGHT_DEPENDENCIES
    .filter((rel) => !dependencyCheckRels.has(rel));
  const commandHashesOk = commandHashChecks.length > 0
    && commandHashMissingRequired.length === 0
    && commandHashMissing.length === 0
    && commandHashMissingCurrent.length === 0
    && commandHashMismatches.length === 0;
  const dependencyHashesOk = dependencyHashChecks.length > 0
    && dependencyHashMissingRequired.length === 0
    && dependencyHashMissing.length === 0
    && dependencyHashMissingCurrent.length === 0
    && dependencyHashMismatches.length === 0;
  const annSource = postDrainPreflightAnnSourceEvidence(evidence, { liveEmbedded });
  const topicProjection = evidence?.topic_context_projection || {};
  const backupProjection = evidence?.backup_dispatcher_projection || {};
  const backupDryRun = backupProjection?.projection || {};
  const reclassifyProjection = evidence?.reclassify_projection || {};
  const reclassifyDryRun = reclassifyProjection?.projection || {};
  const memoryProjection = evidence?.memory_refocus_projection || {};
  const memoryDryRun = memoryProjection?.projection || {};
  const topicTotal = Number(topicProjection.total_topics);
  const topicCapacity = Number(topicProjection.capacity);
  const topicPending = Number(topicProjection.pending_now);
  const backupLockedCompatible = backupProjection.locked === true && backupProjection.lock_compatible === true;
  const reclassifyStatus = String(reclassifyDryRun.status || '');
  const memoryAfter = Number(memoryDryRun.after_current_needs_routing_links);
  const memoryThreshold = Number(memoryProjection.threshold);
  const failures = Array.isArray(evidence?.failures) ? evidence.failures : [];
  const projectionFailures = [];
  if (topicProjection.ok !== true) projectionFailures.push('post-drain preflight topic context projection not ok');
  if (topicProjection.read_only !== true) projectionFailures.push('post-drain preflight topic context projection was not read-only');
  if (!Number.isFinite(topicTotal) || !Number.isFinite(topicCapacity) || topicCapacity < topicTotal) {
    projectionFailures.push('post-drain preflight topic context capacity cannot cover all topics');
  }
  if (!Number.isFinite(topicPending)) projectionFailures.push('post-drain preflight topic context projection did not report pending topics');
  if (backupProjection.ok !== true) projectionFailures.push('post-drain preflight backup dispatcher projection not ok');
  if (backupProjection.read_only !== true) projectionFailures.push('post-drain preflight backup dispatcher projection was not read-only');
  if (backupLockedCompatible) {
    if (backupProjection.lock_process_alive !== true) projectionFailures.push('post-drain preflight backup lock compatibility did not prove a live owner');
  } else {
    if (backupDryRun.action !== 'backup_to_gcp' || backupDryRun.dry_run !== true) {
      projectionFailures.push('post-drain preflight backup dispatcher projection was not a dry-run backup');
    }
    if (
      backupDryRun.db_only !== true
        || backupDryRun.snapshot_dbs !== true
        || backupDryRun.strict !== true
        || backupDryRun.strict_ok !== true
        || backupDryRun.db_snapshot_enabled !== true
        || backupDryRun.db_snapshot_method !== 'clone'
    ) {
      projectionFailures.push('post-drain preflight backup dispatcher projection did not enforce strict clone DB snapshots');
    }
    if (!Array.isArray(backupDryRun.db_missing_required) || backupDryRun.db_missing_required.length > 0) {
      projectionFailures.push('post-drain preflight backup dispatcher projection has missing required DBs');
    }
  }
  if (reclassifyProjection.ok !== true) projectionFailures.push('post-drain preflight reclassify projection not ok');
  if (reclassifyProjection.read_only !== true) projectionFailures.push('post-drain preflight reclassify projection was not read-only');
  if (reclassifyDryRun.ok !== true || reclassifyDryRun.dry_run !== true || reclassifyDryRun.skip_regen !== true) {
    projectionFailures.push('post-drain preflight reclassify projection did not run as dry-run no-regen');
  }
  if (!['partial_slice', 'complete'].includes(reclassifyStatus)) {
    projectionFailures.push('post-drain preflight reclassify projection reported invalid status');
  }
  if (!Array.isArray(reclassifyDryRun.passes) || reclassifyDryRun.passes.length === 0) {
    projectionFailures.push('post-drain preflight reclassify projection did not report pass evidence');
  }
  if (memoryProjection.ok !== true) projectionFailures.push('post-drain preflight memory refocus projection not ok');
  if (memoryProjection.read_only !== true) projectionFailures.push('post-drain preflight memory refocus projection was not read-only');
  if (memoryDryRun.ok !== true || memoryDryRun.applied !== false) {
    projectionFailures.push('post-drain preflight memory refocus projection did not run read-only');
  }
  if (memoryDryRun.partial !== false) projectionFailures.push('post-drain preflight memory refocus projection did not complete');
  if (!Number.isFinite(memoryAfter) || !Number.isFinite(memoryThreshold) || memoryAfter > memoryThreshold) {
    projectionFailures.push('post-drain preflight memory refocus projection does not clear unresolved links below threshold');
  }
  const ok = evidence?.ok === true
    && evidence?.read_only === true
    && fresh
    && scriptMatchesDisk
    && evidence?.backup?.configured === true
    && evidence?.backup?.skipped !== true
    && evidence?.gcloud?.bucket_access === true
    && dbSnapshotChecksOk
    && commandChecksOk
    && selfCommandPresent
    && commandHashesOk
    && dependencyChecksOk
    && dependencyHashesOk
    && annSource.ok
    && failures.length === 0
    && projectionFailures.length === 0;
  return {
    ok,
    path: postDrainPreflightPath,
    present: Boolean(evidence),
    checked_at: evidence?.checked_at || null,
    age_ms: ageMs,
    max_age_ms: postDrainMaxPreflightAgeMs,
    fresh,
    read_only: evidence?.read_only === true,
    script_matches_disk: scriptMatchesDisk,
    backup: evidence?.backup || null,
    gcloud: evidence?.gcloud || null,
    db_snapshot_checks_ok: dbSnapshotChecksOk,
    ann_source_projection: annSource,
    topic_context_projection: topicProjection,
    backup_dispatcher_projection: backupProjection,
    reclassify_projection: reclassifyProjection,
    memory_refocus_projection: memoryProjection,
    projection_failures: projectionFailures,
    command_checks_ok: commandChecksOk,
    self_command_present: selfCommandPresent,
    command_hashes_ok: commandHashesOk,
    command_hash_missing_required: commandHashMissingRequired,
    command_hash_missing: commandHashMissing,
    command_hash_missing_current: commandHashMissingCurrent,
    command_hash_mismatches: commandHashMismatches,
    dependency_checks_ok: dependencyChecksOk,
    dependency_hashes_ok: dependencyHashesOk,
    dependency_hash_missing_required: dependencyHashMissingRequired,
    dependency_hash_missing: dependencyHashMissing,
    dependency_hash_missing_current: dependencyHashMissingCurrent,
    dependency_hash_mismatches: dependencyHashMismatches,
    failures,
  };
}

async function personalDrainProgress() {
  const logPath = latestPersonalDrainLogPath();
  const hold = readEmbedPauseHold({ maxCacheMs: 0 });
  const holdSummary = summarizeEmbedPauseHold(hold);
  const drainMode = holdSummary.metadata?.mode === 'work-order'
    || holdSummary.metadata?.topic === 'work-order'
    ? 'work-order'
    : 'topic';
  const countTopic = drainMode === 'work-order' ? null : personalDrainTopic;
  const evidence = {
    topic: personalDrainTopic,
    drain_mode: drainMode,
    count_scope: countTopic === null ? 'global' : countTopic,
    wait_ms: personalDrainProgressWaitMs,
    poll_ms: personalDrainProgressPollMs,
    min_sample_ms: personalDrainProgressMinSampleMs,
    embed_pause_hold: holdSummary,
    hold_process_alive: holdSummary.pid ? processAlive(holdSummary.pid) : false,
    proof_freeze_status: summarizeEmbedProofFreezeStatus(readEmbedProofFreezeStatus()),
    log: parsePersonalDrainLog(logPath, drainMode === 'work-order' ? null : personalDrainTopic),
    disk: diskFreeEvidence(),
    post_drain_watcher: postDrainWatcherEvidence(),
  };
  if (evidence.disk.ok && !evidence.disk.above_floor) {
    return row('red', 'personal drain is below the disk free floor', evidence);
  }

  try {
    const { default: db } = await import('../../lib/db.js');
    const before = readDrainTopicCounts(db, countTopic);
    evidence.counts_before = before;
    const globalBefore = countTopic === null ? before : readDrainTopicCounts(db, null);
    evidence.global_counts_before = globalBefore;
    evidence.post_drain_watcher = postDrainWatcherEvidence(Date.now(), {
      liveEmbedded: globalBefore.embedded,
    });
    if (countTopic !== personalDrainTopic) {
      evidence.personal_counts_before = readDrainTopicCounts(db, personalDrainTopic);
    }
    evidence.foreground_pause = foregroundDrainPauseEvidence(db);

    if (before.pending === 0) {
      if (evidence.post_drain_watcher.status !== 'complete' && evidence.post_drain_watcher.ok !== true) {
        return row('red', 'embedding drain is empty but post-drain handoff watcher is not healthy', evidence);
      }
      return row('green', 'embedding drain scope has no pending embeddings', evidence);
    }
    if (!holdSummary.active) {
      return row('red', 'personal drain backlog exists but no drain-owned hold is active', evidence);
    }
    if (holdSummary.reason !== 'drain_personal_embeddings_sole_writer') {
      return row('red', 'personal drain backlog exists but another embed hold owns the pipeline', evidence);
    }
    if (!evidence.hold_process_alive) {
      return row('red', 'personal drain hold owner process is not alive', evidence);
    }
    if (evidence.post_drain_watcher.ok !== true) {
      return row('red', 'post-drain handoff watcher is not healthy while embedding drain is active', evidence);
    }
    if (evidence.proof_freeze_status.active) {
      return row('green', 'personal drain is parked for an exact proof freeze', evidence);
    }
    if (evidence.foreground_pause.pause) {
      return row('green', 'personal drain is correctly yielding to foreground activity', evidence);
    }

    const samples = [before];
    const deadline = Date.now() + personalDrainProgressWaitMs;
    let after = before;
    while (Date.now() < deadline) {
      await sleep(Math.min(personalDrainProgressPollMs, Math.max(0, deadline - Date.now())));
      after = readDrainTopicCounts(db, countTopic);
      samples.push(after);
      const progress = drainProgressSummary(before, after, {
        baseline: drainBaselineEvidenceFromLog(evidence.log),
      });
      if (progress.completed > 0 && progress.elapsed_ms >= personalDrainProgressMinSampleMs) {
        evidence.counts_after = after;
        if (countTopic !== personalDrainTopic) {
          evidence.personal_counts_after = readDrainTopicCounts(db, personalDrainTopic);
        }
        evidence.samples = samples;
        evidence.progress = progress;
        return row('green', 'embedding drain is actively reducing the live backlog', evidence);
      }
    }

    evidence.counts_after = after;
    if (countTopic !== personalDrainTopic) {
      evidence.personal_counts_after = readDrainTopicCounts(db, personalDrainTopic);
    }
    evidence.samples = samples;
    evidence.progress = drainProgressSummary(before, after, {
      baseline: drainBaselineEvidenceFromLog(evidence.log),
    });
    evidence.log_after = parsePersonalDrainLog(logPath, drainMode === 'work-order' ? null : personalDrainTopic);
    if (evidence.progress.completed > 0) {
      return row('green', 'embedding drain is actively reducing the live backlog', evidence);
    }
    return row('red', 'embedding drain made no measurable progress during the sample window', evidence);
  } catch (err) {
    return row('red', 'embedding drain progress check errored', {
      ...evidence,
      error: err?.message || String(err),
    });
  }
}

async function embedWorkOrderFairness() {
  const workOrderStarted = Date.now();
  const result = spawnSync(process.execPath, ['scripts/chunk-embed-work-order.mjs'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ROBOTDOJO_DAEMON_IMPORT_ONLY: '1' },
    encoding: 'utf8',
    timeout: Number(process.env.ROBOTDOJO_STOPLIGHT_WORK_ORDER_TIMEOUT_MS || 120_000),
  });
  const deriveMs = Date.now() - workOrderStarted;
  if (result.status !== 0) {
    return {
      ok: false,
      reason: 'work_order_derive_failed',
      derive_ms: deriveMs,
      max_derive_ms: workOrderMaxDeriveMs,
      status: result.status,
      signal: result.signal || null,
      stdout: tailLines(result.stdout),
      stderr: tailLines(result.stderr),
    };
  }

  let order = null;
  try {
    const line = tailLines(result.stdout, 1)[0] || '[]';
    order = JSON.parse(line);
  } catch (err) {
    return {
      ok: false,
      reason: 'work_order_json_invalid',
      derive_ms: deriveMs,
      max_derive_ms: workOrderMaxDeriveMs,
      error: err?.message || String(err),
      stdout: tailLines(result.stdout),
      stderr: tailLines(result.stderr),
    };
  }
  if (!Array.isArray(order)) {
    return {
      ok: false,
      reason: 'work_order_not_array',
      derive_ms: deriveMs,
      max_derive_ms: workOrderMaxDeriveMs,
      type: typeof order,
    };
  }

  const previousImportOnly = process.env.ROBOTDOJO_DAEMON_IMPORT_ONLY;
  process.env.ROBOTDOJO_DAEMON_IMPORT_ONLY = '1';
  let selectEmbeddingPassOrder;
  try {
    ({ selectEmbeddingPassOrder } = await import('../../scripts/chunk-embed-daemon.mjs'));
  } finally {
    if (previousImportOnly === undefined) delete process.env.ROBOTDOJO_DAEMON_IMPORT_ONLY;
    else process.env.ROBOTDOJO_DAEMON_IMPORT_ONLY = previousImportOnly;
  }

  const hasShort = (topic) => (Number(topic.shortPending) || 0) > 0;
  const shortRich = order.filter(hasShort);
  const longOnly = order.filter((topic) => !hasShort(topic));
  const summarizeTopic = ({ topic, pending, shortPending, longPending, priority, emailShare }) => ({
    topic,
    pending: Number(pending) || 0,
    shortPending: Number(shortPending) || 0,
    longPending: Number(longPending) || 0,
    priority: Number(priority) || 0,
    emailShare: Number(Number(emailShare || 0).toFixed(3)),
  });

  const summary = {
    derive_ms: deriveMs,
    max_derive_ms: workOrderMaxDeriveMs,
    topic_count: order.length,
    short_rich_count: shortRich.length,
    long_only_count: longOnly.length,
    total_pending: order.reduce((sum, topic) => sum + (Number(topic.pending) || 0), 0),
    top: order.slice(0, 12).map(summarizeTopic),
  };

  if (deriveMs > workOrderMaxDeriveMs) return { ok: false, reason: 'work_order_derive_too_slow', ...summary };
  if (!order.length) return { ok: true, reason: 'no_pending_backlog', ...summary };
  if (!shortRich.length) return { ok: true, reason: 'no_short_rich_backlog_all_long_only_topics_eligible', ...summary };
  if (!longOnly.length) return { ok: true, reason: 'no_long_only_backlog', ...summary };

  const passes = [];
  const coveredLongOnly = new Set();
  let cursor = 0;
  const maxPasses = Math.max(longOnly.length + 1, 2);
  for (let i = 0; i < maxPasses; i++) {
    const pass = selectEmbeddingPassOrder(order, { longOnlyStart: cursor });
    const selectedLongOnly = pass.filter((topic) => !hasShort(topic)).map((topic) => topic.topic);
    selectedLongOnly.forEach((topic) => coveredLongOnly.add(topic));
    passes.push({
      start: cursor,
      topics: pass.map((topic) => topic.topic),
      long_only_selected: selectedLongOnly,
    });
    if (selectedLongOnly.length === 0) break;
    cursor += selectedLongOnly.length;
  }

  const shortEveryPass = passes.every((pass) =>
    shortRich.every((topic) => pass.topics.includes(topic.topic)));
  const longRotationCoversAll = longOnly.every((topic) => coveredLongOnly.has(topic.topic));
  const ok = shortEveryPass && longRotationCoversAll;
  return {
    ok,
    reason: ok
      ? 'short_rich_topics_preserved_and_long_only_rotation_covers_backlog'
      : 'embed_work_order_starvation_risk',
    ...summary,
    short_rich_topics: shortRich.slice(0, 20).map(summarizeTopic),
    long_only_topics: longOnly.slice(0, 20).map(summarizeTopic),
    passes: passes.slice(0, 20),
    short_every_pass: shortEveryPass,
    long_rotation_covers_all: longRotationCoversAll,
  };
}

async function embedBacklogHygiene() {
  try {
    const { default: db } = await import('../../lib/db.js');
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total_chunks,
        SUM(CASE WHEN embedded = 1 THEN 1 ELSE 0 END) AS embedded_chunks,
        SUM(CASE WHEN embedded = 0 AND COALESCE(skip_embed, 0) = 0 THEN 1 ELSE 0 END) AS pending_chunks,
        SUM(CASE WHEN embedded = 0 AND COALESCE(skip_embed, 0) = 0 AND LENGTH(TRIM(COALESCE(content, ''))) = 0 THEN 1 ELSE 0 END) AS pending_empty_chunks,
        SUM(CASE WHEN embedded = 0 AND COALESCE(skip_embed, 0) = 0 AND (topic IS NULL OR LENGTH(TRIM(topic)) = 0) THEN 1 ELSE 0 END) AS pending_topicless_chunks,
        SUM(CASE WHEN embedded = 0 AND COALESCE(skip_embed, 0) = 0 AND COALESCE(value_rank, 0) = 0 THEN 1 ELSE 0 END) AS pending_unranked_chunks,
        SUM(CASE WHEN embedded = 0 AND COALESCE(skip_embed, 0) = 0 AND LENGTH(COALESCE(content, '')) > ? THEN 1 ELSE 0 END) AS pending_oversized_chunks,
        MAX(CASE WHEN embedded = 0 AND COALESCE(skip_embed, 0) = 0 THEN LENGTH(COALESCE(content, '')) ELSE 0 END) AS max_pending_chars
      FROM chunks
    `).get(maxPendingChunkChars);
    const byTopic = db.prepare(`
      SELECT
        topic,
        COUNT(*) AS pending,
        SUM(CASE WHEN LENGTH(COALESCE(content, '')) <= 2000 THEN 1 ELSE 0 END) AS short_pending,
        SUM(CASE WHEN LENGTH(COALESCE(content, '')) > 2000 THEN 1 ELSE 0 END) AS long_pending,
        MAX(LENGTH(COALESCE(content, ''))) AS max_chars
      FROM chunks
      WHERE embedded = 0
        AND COALESCE(skip_embed, 0) = 0
      GROUP BY topic
      ORDER BY pending DESC
      LIMIT 12
    `).all();
    const bySourceType = db.prepare(`
      SELECT topic, source_type, COUNT(*) AS pending
      FROM chunks
      WHERE embedded = 0
        AND COALESCE(skip_embed, 0) = 0
      GROUP BY topic, source_type
      ORDER BY pending DESC
      LIMIT 12
    `).all();
    const ok = Number(counts.pending_empty_chunks || 0) === 0
      && Number(counts.pending_topicless_chunks || 0) === 0
      && Number(counts.pending_unranked_chunks || 0) === 0
      && Number(counts.pending_oversized_chunks || 0) === 0;
    return {
      ok,
      reason: ok ? 'embed_backlog_hygiene_ok' : 'embed_backlog_hygiene_failed',
      max_pending_chunk_chars: maxPendingChunkChars,
      counts: {
        total_chunks: Number(counts.total_chunks || 0),
        embedded_chunks: Number(counts.embedded_chunks || 0),
        pending_chunks: Number(counts.pending_chunks || 0),
        pending_empty_chunks: Number(counts.pending_empty_chunks || 0),
        pending_topicless_chunks: Number(counts.pending_topicless_chunks || 0),
        pending_unranked_chunks: Number(counts.pending_unranked_chunks || 0),
        pending_oversized_chunks: Number(counts.pending_oversized_chunks || 0),
        max_pending_chars: Number(counts.max_pending_chars || 0),
      },
      top_pending_topics: byTopic.map((row) => ({
        topic: row.topic,
        pending: Number(row.pending || 0),
        short_pending: Number(row.short_pending || 0),
        long_pending: Number(row.long_pending || 0),
        max_chars: Number(row.max_chars || 0),
      })),
      top_pending_sources: bySourceType.map((row) => ({
        topic: row.topic,
        source_type: row.source_type,
        pending: Number(row.pending || 0),
      })),
    };
  } catch (err) {
    return { ok: false, reason: 'embed_backlog_hygiene_errored', error: err?.message || String(err) };
  }
}

function embedWorkOrderCoverage(backlogHygieneBefore, workOrder, backlogHygieneAfter = null) {
  const beforePending = Number(backlogHygieneBefore?.counts?.pending_chunks ?? NaN);
  const afterPending = Number(backlogHygieneAfter?.counts?.pending_chunks ?? NaN);
  const workOrderPending = Number(workOrder?.total_pending ?? NaN);
  const observed = [beforePending, afterPending].filter(Number.isFinite);
  const observedMin = observed.length ? Math.min(...observed) : NaN;
  const observedMax = observed.length ? Math.max(...observed) : NaN;
  const measurable = observed.length > 0 && Number.isFinite(workOrderPending);
  const ok = measurable && workOrderPending >= observedMin && workOrderPending <= observedMax;
  const movementObserved = observed.length > 1 && beforePending !== afterPending;
  const drift = !measurable
    ? NaN
    : workOrderPending < observedMin
      ? observedMin - workOrderPending
      : workOrderPending > observedMax
        ? workOrderPending - observedMax
        : 0;
  return {
    ok,
    reason: ok
      ? (movementObserved ? 'work_order_covers_observed_backlog_window' : 'work_order_covers_clean_backlog')
      : 'work_order_backlog_coverage_gap',
    before_hygiene_pending: Number.isFinite(beforePending) ? beforePending : null,
    after_hygiene_pending: Number.isFinite(afterPending) ? afterPending : null,
    work_order_pending: Number.isFinite(workOrderPending) ? workOrderPending : null,
    observed_min_pending: Number.isFinite(observedMin) ? observedMin : null,
    observed_max_pending: Number.isFinite(observedMax) ? observedMax : null,
    drift: Number.isFinite(drift) ? drift : null,
    allowed_drift: 0,
  };
}

async function qaSurfaceLeakCheck() {
  try {
    const { default: db } = await import('../../lib/db.js');
    const topicLeaks = db.prepare(`
      SELECT slug, label, parent_slug, visible, created_at
      FROM user_topics
      WHERE visible = 1
        AND (
          slug GLOB 'tc-*'
          OR slug GLOB 'black-belt-*'
          OR slug GLOB 'wb-*'
          OR label IN (
            'Context Guard Test',
            'BB Created Topic',
            'Black Belt Created Topic',
            'WB Created',
            'WB Put Target',
            'WB Renamed',
            'WB Del Target',
            'To Delete',
            'To Update',
            'Refresh Test'
          )
        )
      ORDER BY created_at DESC, slug
      LIMIT 50
    `).all();
    const conversationLeaks = db.prepare(`
      SELECT c.id, c.title, c.topic_slug, c.created_at
      FROM conversations c
      WHERE c.deleted_at IS NULL
        AND (
          c.title LIKE 'QA smoke check:%'
          OR c.title LIKE 'Launch stoplight smoke:%'
          OR c.title LIKE 'Relay launch stoplight smoke:%'
          OR c.title LIKE 'Chrome smoke test after embedding daemon fix:%'
          OR c.topic_slug IN (
            SELECT slug
            FROM user_topics
            WHERE slug GLOB 'tc-*'
              OR slug GLOB 'black-belt-*'
              OR slug GLOB 'wb-*'
              OR label IN (
                'Context Guard Test',
                'BB Created Topic',
                'Black Belt Created Topic',
                'WB Created',
                'WB Put Target',
                'WB Renamed',
                'WB Del Target',
                'To Delete',
                'To Update',
                'Refresh Test'
              )
          )
        )
      ORDER BY c.created_at DESC
      LIMIT 20
    `).all();
    return {
      ok: topicLeaks.length === 0 && conversationLeaks.length === 0,
      reason: topicLeaks.length || conversationLeaks.length
        ? 'qa_artifacts_visible_in_product_surface'
        : 'no_visible_qa_artifacts',
      topic_leaks: topicLeaks,
      conversation_leaks: conversationLeaks,
    };
  } catch (err) {
    return { ok: false, reason: 'qa_surface_leak_check_error', error: err?.message || String(err) };
  }
}

function annBaseDir() {
  return process.env.ROBOTDOJO_ANN_DIR || join(homedir(), '.robotdojo-ann');
}

function readAnnArtifacts(annDir = annBaseDir()) {
  const sidecarPath = join(annDir, 'sidecar.json');
  return {
    sidecar: existsSync(sidecarPath),
    hot: existsSync(join(annDir, 'hot.usearch')),
    full: existsSync(join(annDir, 'full.usearch')),
    building_lock: existsSync(`${sidecarPath}.building`),
  };
}

function readAnnSidecar(annDir = annBaseDir()) {
  const sidecarPath = join(annDir, 'sidecar.json');
  if (!existsSync(sidecarPath)) return null;
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  return {
    raw: sidecar,
    summary: {
      hot_size: Number(sidecar.hot_size) || 0,
      full_size: Number(sidecar.full_size) || 0,
      built_from_count: Number(sidecar.built_from_count) || 0,
      source_embedded_count: Number(sidecar.source_embedded_count) || 0,
      dim: Number(sidecar.dim) || 0,
      embedding_model_id: sidecar.embedding_model_id || null,
    },
  };
}

function globalHnswBuilders() {
  const result = spawnSync('pgrep', ['-fl', 'build-global-hnsw'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 3000,
  });
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  return {
    ok: result.status === 0 || result.status === 1,
    status: result.status,
    count: lines.length,
    lines,
    error: result.error?.message || null,
  };
}

async function waitForGlobalHnswBuildersIdle(annDir = annBaseDir()) {
  return await waitForOk(() => {
    const builders = globalHnswBuilders();
    const artifacts = readAnnArtifacts(annDir);
    return {
      ok: builders.ok && builders.count === 0 && artifacts.building_lock !== true,
      reason: builders.count > 0
        ? 'global_hnsw_builder_still_running'
        : artifacts.building_lock
          ? 'global_hnsw_building_lock_still_present'
          : 'global_hnsw_builders_idle',
      builders,
      artifacts,
    };
  }, {
    timeoutMs: Number(process.env.ROBOTDOJO_STOPLIGHT_ANN_BUILDER_IDLE_TIMEOUT_MS || 300_000),
    intervalMs: Number(process.env.ROBOTDOJO_STOPLIGHT_ANN_BUILDER_IDLE_POLL_MS || 1500),
  });
}

async function currentServerHealth({ timeoutMs = 4000 } = {}) {
  const bases = process.env.ROBOTDOJO_LOCAL_BASE
    ? [localBase]
    : [localProxyBase, localBase];
  const attempts = [];
  for (const base of bases) {
    const started = Date.now();
    try {
      const res = await fetchJson(`${base}/api/server-health`, {}, timeoutMs);
      const attempt = {
        base,
        ok: res.res.ok && res.body?.status === 'ok',
        status: res.res.status,
        duration_ms: Date.now() - started,
        warmup_complete: res.body?.warmup_complete ?? null,
        ann_chunks: res.body?.warmup?.ann_chunks ?? null,
        ann_runtime_full_size: res.body?.ann_runtime?.full_size ?? null,
        ann_runtime_stale_on_disk: res.body?.ann_runtime?.stale_on_disk ?? null,
      };
      attempts.push(attempt);
      if (attempt.ok) return { ok: true, base, body: res.body, attempts };
    } catch (err) {
      attempts.push({ base, ok: false, error: err?.message || String(err), duration_ms: Date.now() - started });
    }
  }
  return { ok: false, attempts };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientFetchStall(err) {
  const name = String(err?.name || '');
  const message = String(err?.message || '');
  return name === 'AbortError'
    || name === 'TimeoutError'
    || /\b(abort|timeout|timed out)\b/i.test(message);
}

async function postChatActivePing(base, cookie) {
  const attempts = [];
  for (let attempt = 1; attempt <= chatActivePingAttempts; attempt++) {
    const started = Date.now();
    try {
      const ping = await fetchJson(`${base}/api/chat/active`, { method: 'POST', headers: { Cookie: cookie } }, chatActivePingTimeoutMs);
      const evidence = { attempt, ok: ping.res.ok, status: ping.res.status, ms: Date.now() - started, body: ping.body };
      attempts.push(evidence);
      if (ping.res.ok && ping.body?.ok === true) return { ok: true, status: ping.res.status, body: ping.body, attempts };
      return { ok: false, error: 'chat_active_http_failed', status: ping.res.status, body: ping.body, attempts };
    } catch (err) {
      const transientStall = isTransientFetchStall(err);
      attempts.push({
        attempt,
        ok: false,
        ms: Date.now() - started,
        error: err?.name || 'fetch_error',
        message: err?.message || String(err),
        transient_stall: transientStall,
      });
      if (!transientStall || attempt === chatActivePingAttempts) {
        return { ok: false, error: transientStall ? 'chat_active_ping_stalled' : 'chat_active_ping_failed', attempts };
      }
      await sleep(chatActivePingRetryDelayMs);
    }
  }
  return { ok: false, error: 'chat_active_ping_not_attempted', attempts };
}

async function waitForOk(fn, { timeoutMs = 30_000, intervalMs = 1000 } = {}) {
  const started = Date.now();
  const deadline = Date.now() + timeoutMs;
  let last = null;
  const polls = [];
  while (Date.now() < deadline) {
    try {
      last = await fn();
      polls.push(last);
      if (last?.ok) return {
        ...last,
        poll_attempts: polls.length,
        poll_ms: Date.now() - started,
      };
    } catch (err) {
      last = { ok: false, error: err?.message || String(err) };
      polls.push(last);
    }
    await sleep(intervalMs);
  }
  return {
    ...(last || { ok: false, error: 'timeout' }),
    poll_attempts: polls.length,
    poll_ms: Date.now() - started,
    recent_polls: polls.slice(-5),
  };
}

async function localFetchReadiness() {
  const health = await probeServerHealth({
    timeoutMs: localReadinessProbeTimeoutMs,
    urls: localHealthUrls(),
  });
  if (!health.ok) return health;
  if (health.url && !process.env.ROBOTDOJO_LOCAL_BASE) {
    try { localBase = new URL(health.url).origin; } catch {}
  }
  const authBase = health.url ? new URL(health.url).origin : localBase;
  try {
    const probe = await fetch(`${authBase}/api/auth/probe`, {
      ...fetchOptionsFor(authBase),
      method: 'GET',
      signal: timeoutSignal(4000),
      redirect: 'manual',
    });
    if (probe.status !== 200) {
      return { ok: false, base: authBase, health, auth_probe_status: probe.status };
    }
    if (config.authToken) {
      const authWrite = await loginAt(authBase, { loginTimeoutMs: 30_000, verifyTimeoutMs: 8000 });
      if (!authWrite.ok) {
        return {
          ok: false,
          base: authBase,
          health,
          auth_probe_status: probe.status,
          auth_write: { ...authWrite, cookie: undefined },
        };
      }
      return {
        ok: true,
        base: authBase,
        health,
        auth_probe_status: probe.status,
        auth_write: {
          ok: true,
          status: authWrite.status,
          user: authWrite.user,
        },
      };
    }
    return { ok: true, base: authBase, health, auth_probe_status: probe.status };
  } catch (err) {
    return { ok: false, health, error: err?.message || String(err) };
  }
}

async function localReadiness() {
  if (opts.fresh || opts.restartServices) {
    const ready = await waitForOk(localFetchReadiness, { timeoutMs: restartLocalTimeoutMs, intervalMs: 1500 });
    return ready.ok
      ? row('green', 'local server and auth-write readiness responded', ready)
      : row('red', 'local server/auth-write readiness failed', ready);
  }
  const health = await waitForOk(async () => {
    const probe = await probeServerHealth({ timeoutMs: localReadinessProbeTimeoutMs, urls: localHealthUrls() });
    return probe.ok ? { ...probe, ok: true } : probe;
  }, {
    timeoutMs: localReadinessTimeoutMs,
    intervalMs: 1500,
  });
  if (health.ok && health.url && !process.env.ROBOTDOJO_LOCAL_BASE) {
    try { localBase = new URL(health.url).origin; } catch {}
  }
  if (!health.ok) return row('red', 'local server health failed', health);
  const runtimeFreshness = localAppRuntimeFreshnessEvidence();
  return runtimeFreshness.ok
    ? row('green', 'local server health responded and running app code is current', { ...health, runtime_freshness: runtimeFreshness })
    : row('red', 'local server health responded but running app code is stale or unproven', { ...health, runtime_freshness: runtimeFreshness });
}

async function loginSession(base = localBase) {
  const login = await loginAt(base);
  return login.ok
    ? row('green', 'token login and session refresh passed', { base, status: login.status, user: login.user })
    : row('red', 'token login or session refresh failed', { base, ...login, cookie: undefined });
}

async function privateChat(base = localBase, cookie = null) {
  const auth = cookie ? { ok: true, cookie } : await loginAt(base);
  if (!auth.ok) return row('red', 'private chat prerequisite login failed', { base, error: auth.error, status: auth.status });
  if (!opts.requirePrivateChat && process.env.ROBOTDOJO_STOPLIGHT_SKIP_MODEL === '1') {
    return row('green', 'private chat model smoke skipped by explicit env', { base, skipped: true });
  }
  // Product bar F4: personal awareness, not "any short sentence under TTFT".
  // Vendor-agnostic: accept whichever provider/model completed the turn.
  const chat = await streamChatAt(base, auth.cookie, {
    prompt: 'Who am I? Answer from my Robot Dojo identity context in one or two short sentences. If personal context did not load, say that plainly.',
    timeoutMs: Number(process.env.ROBOTDOJO_STOPLIGHT_CHAT_TIMEOUT_MS || 60_000),
  });
  if (!chat.ok) {
    const cleanup = await cleanupStoplightConversation(chat.conversationId);
    return row('red', 'private chat failed to complete', { base, ...chat, cleanup });
  }

  let metric = null;
  let identityHint = '';
  try {
    const { default: db } = await import('../../lib/db.js');
    metric = db.prepare(`
      SELECT request_model, response_model, provider_name, error_type, recovery_path,
             request_start_ms, first_token_ms, ttft_ms, completion_ms
      FROM chat_turn_metrics
      WHERE conversation_id = ?
      ORDER BY request_start_ms DESC
      LIMIT 1
    `).get(chat.conversationId) || null;
  } catch (err) {
    const cleanup = await cleanupStoplightConversation(chat.conversationId);
    return row('red', 'private chat completed but model evidence could not be read', {
      base,
      ...chat,
      metric_error: err?.message || String(err),
      cleanup,
    });
  }
  try {
    const { getIdentityCard } = await import('../../lib/identity-card.js');
    identityHint = String(getIdentityCard() || '').slice(0, 200);
  } catch { /* identity optional on empty install */ }

  // Any configured vendor that completes without error is fine (not Anthropic-only).
  const modelOk = Boolean(metric?.request_model || metric?.response_model) && !metric?.error_type;
  const observedTtftMs = Number.isFinite(Number(metric?.ttft_ms))
    ? Number(metric.ttft_ms)
    : Number(metric?.first_token_ms) - Number(metric?.request_start_ms);
  const observedTotalMs = Number(metric?.completion_ms) - Number(metric?.request_start_ms);
  const latency = {
    ttft_ms: Number.isFinite(observedTtftMs) ? observedTtftMs : null,
    total_ms: Number.isFinite(observedTotalMs) ? observedTotalMs : null,
    ttft_budget_ms: privateChatTtftBudgetMs,
    total_budget_ms: privateChatTotalBudgetMs,
  };
  const latencyOk = latency.ttft_ms !== null
    && latency.total_ms !== null
    && latency.ttft_ms > 0
    && latency.total_ms >= latency.ttft_ms
    && latency.ttft_ms <= privateChatTtftBudgetMs
    && latency.total_ms <= privateChatTotalBudgetMs;
  const answer = String(chat.text || '').trim();
  const honestMiss = /personal context did not load|context (?:did not|didn't) load|do not have|don't have|no (?:personal )?context|cannot (?:see|access) (?:your|my)/i.test(answer);
  // If identity vessel exists, answer should use it (name token or multi-sentence personal claim).
  // If vessel empty, honest miss is green. Generic one-liner with no identity is red when vessel exists.
  const nameToken = (identityHint.match(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/) || [])[0] || '';
  const usesIdentity = nameToken
    ? answer.toLowerCase().includes(nameToken.toLowerCase().split(/\s+/)[0])
    : answer.length >= 40;
  const awarenessOk = identityHint.trim()
    ? (usesIdentity || honestMiss)
    : (honestMiss || answer.length >= 20);
  const cleanup = await cleanupStoplightConversation(chat.conversationId);

  return modelOk && latencyOk && awarenessOk && cleanup.ok
    ? row('green', 'private chat answered a personal identity question with awareness or honest miss', {
      base,
      ...chat,
      latency,
      metric,
      awareness: { usesIdentity, honestMiss, identity_present: Boolean(identityHint.trim()) },
      cleanup,
    })
    : row('red', cleanup.ok
      ? (!awarenessOk
        ? 'private chat completed but failed personal-awareness bar'
        : 'private chat completed with model error or missed latency budget')
      : 'private chat completed but cleanup failed', {
      base,
      ...chat,
      latency,
      metric,
      awareness: { usesIdentity, honestMiss, identity_present: Boolean(identityHint.trim()) },
      cleanup,
    });
}

async function chatStallRecovery() {
  const chatModule = readFileSync(join(REPO_ROOT, 'apps/chat/modules/chat.js'), 'utf8');
  const streamClient = readFileSync(join(REPO_ROOT, 'apps/chat/modules/stream-client.js'), 'utf8');
  const ok = chatModule.includes('streamChatTurn(')
    && chatModule.includes('rehydrateFromDB')
    && streamClient.includes('closed_without_done')
    && streamClient.includes("recovery_path: 'db_rehydrate'");
  return ok
    ? row('green', 'private chat uses shared watchdog and DB rehydrate path', { static_contract: true })
    : row('red', 'private chat recovery contract missing', { static_contract: false });
}

function cleanupRetrievalSentinel(db, openEmbeddingsDb, sourceId) {
  const oldRows = db.prepare(`
    SELECT id
    FROM chunks
    WHERE topic = 'general'
      AND source_type = 'qa'
      AND source_id = ?
      AND chunk_index = 0
  `).all(sourceId);
  const oldIds = oldRows.map((r) => String(r.id));
  let fts = 0;
  let vectors = 0;
  let chunks = 0;
  for (const id of oldIds) {
    try { fts += db.prepare('DELETE FROM chunks_fts WHERE rowid = ?').run(id).changes; } catch {}
  }
  if (oldIds.length) {
    for (const database of [db, openEmbeddingsDb()].filter(Boolean)) {
      try {
        const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chunk_vec_general'").get();
        if (!exists) continue;
        const del = database.prepare('DELETE FROM chunk_vec_general WHERE chunk_id = ?');
        for (const id of oldIds) vectors += del.run(id).changes;
      } catch {}
    }
  }
  chunks = db.prepare(`
    DELETE FROM chunks
    WHERE topic = 'general'
      AND source_type = 'qa'
      AND source_id = ?
      AND chunk_index = 0
  `).run(sourceId).changes;
  const remaining = db.prepare(`
    SELECT COUNT(*) AS n
    FROM chunks
    WHERE topic = 'general'
      AND source_type = 'qa'
      AND source_id = ?
      AND chunk_index = 0
  `).get(sourceId)?.n || 0;
  return {
    ok: remaining === 0,
    reason: remaining === 0 ? 'launch_stoplight_sentinel_cleaned' : 'launch_stoplight_sentinel_residue',
    deleted: { chunks, fts, vectors },
    remaining,
  };
}

async function retrievalSentinel() {
  const sourceId = 'launch-stoplight-sentinel';
  let dbRef = null;
  let openEmbeddingsDbRef = null;
  try {
    process.env.ROBOTDOJO_ALLOW_PLAINTEXT ||= '1';
    const { default: db, openEmbeddingsDb } = await import('../../lib/db.js');
    dbRef = db;
    openEmbeddingsDbRef = openEmbeddingsDb;
    const { retrieve } = await import('../../lib/rag/retrieve.js');
    const fact = 'Robot Dojo launch sentinel fact: blue orchid seven is the launch recall phrase.';
    const cleanupBefore = cleanupRetrievalSentinel(db, openEmbeddingsDb, sourceId);
    db.prepare(`
      INSERT INTO chunks (topic, source_type, source_id, chunk_index, content, metadata, token_count, embedded, skip_embed)
      VALUES ('general', 'qa', ?, 0, ?, '{"title":"Launch stoplight sentinel"}', 18, 0, 1)
    `).run(sourceId, fact);
    try {
      const inserted = db.prepare(`
        SELECT id, content
        FROM chunks
        WHERE topic = 'general'
          AND source_type = 'qa'
          AND source_id = ?
          AND chunk_index = 0
      `).get(sourceId);
      const ftsHit = inserted && db.prepare(`
        SELECT 1
        FROM chunks_fts
        WHERE rowid = ?
          AND chunks_fts MATCH ?
        LIMIT 1
      `).get(inserted.id, 'blue orchid seven');
      if (inserted && !ftsHit) {
        db.prepare('INSERT INTO chunks_fts(rowid, content) VALUES (?, ?)').run(inserted.id, inserted.content);
      }
    } catch {}
    const fallbackChecked = await retrieve('What is the blue orchid seven launch recall phrase?', { topicScope: ['general'], limit: 5 });
    const fallbackFound = (fallbackChecked.results || []).some((r) => String(r.content || '').includes('blue orchid seven'));
    const fallbackMeta = fallbackChecked.rag_meta || { mode: 'none', degraded: true, hit_count: 0, reason: 'no_hits' };
    const activeEmbedHold = readEmbedPauseHold({ maxCacheMs: 0 });
    const activeDrainBlock = activeEmbedHold.active && activeEmbedHold.reason === 'drain_personal_embeddings_sole_writer'
      ? activeEmbeddingDrainProofBlock(activeEmbedHold)
      : null;
    if (activeDrainBlock && !opts.freezeActiveDrain) {
      const evidence = {
        fallback: { found: fallbackFound, rag_meta: fallbackMeta },
        ann: {
          primary: false,
          not_applicable_to_chat_sla: true,
          reason: 'active_embedding_drain',
        },
        active_drain_block: activeDrainBlock,
        cleanup_before: cleanupBefore,
        cleanup_after: cleanupRetrievalSentinel(db, openEmbeddingsDb, sourceId),
      };
      const cleanupOk = evidence.cleanup_after.ok === true;
      return fallbackFound && fallbackMeta.hit_count > 0 && cleanupOk
        ? row('green', 'retrieval sentinel proved exact fallback; primary ANN proof n/a during active embedding drain', evidence)
        : row('red', 'retrieval sentinel failed exact fallback during active embedding drain', evidence);
    }

    const annQuery = process.env.ROBOTDOJO_STOPLIGHT_ANN_QUERY || 'deep operational memory decisions source additions robot dojo workbench';
    const annTopicScope = (process.env.ROBOTDOJO_STOPLIGHT_ANN_TOPIC_SCOPE || 'robot-dojo')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const annChecked = await retrieve(annQuery, { topicScope: annTopicScope, limit: 10 });
    const annMeta = annChecked.rag_meta || { mode: 'none', degraded: true, hit_count: 0, reason: 'no_hits' };
    const annPrimary = !annChecked.insufficient
      && annMeta.qualified_hit_count > 0
      && (annMeta.mode === 'vector' || annMeta.mode === 'hybrid')
      && annMeta.degraded === false
      && Array.isArray(annMeta.phases)
      && annMeta.phases.includes('rag.ann');

    const evidence = {
      fallback: { found: fallbackFound, rag_meta: fallbackMeta },
      ann: { query: annQuery, topic_scope: annTopicScope, primary: annPrimary, rag_meta: annMeta },
      cleanup_before: cleanupBefore,
      cleanup_after: cleanupRetrievalSentinel(db, openEmbeddingsDb, sourceId),
    };
    const cleanupOk = evidence.cleanup_after.ok === true;
    return fallbackFound && fallbackMeta.hit_count > 0 && annPrimary && cleanupOk
      ? row('green', 'retrieval sentinel proved exact fallback and primary ANN retrieval', evidence)
      : row('red', 'retrieval sentinel failed exact fallback or primary ANN retrieval', evidence);
  } catch (err) {
    let cleanupAfter = null;
    if (dbRef && openEmbeddingsDbRef) {
      try { cleanupAfter = cleanupRetrievalSentinel(dbRef, openEmbeddingsDbRef, sourceId); } catch {}
    }
    return row('red', 'retrieval sentinel errored', { error: err?.message || String(err), cleanup_after: cleanupAfter });
  }
}

async function embedProofFreezeHandshake() {
  let freeze = null;
  const evidence = {
    embed_pause_hold: summarizeEmbedPauseHold(readEmbedPauseHold({ maxCacheMs: 0 })),
  };
  if (!evidence.embed_pause_hold.active) {
    return row('red', 'embed proof freeze handshake requires an active drain hold', evidence);
  }
  if (evidence.embed_pause_hold.reason !== 'drain_personal_embeddings_sole_writer') {
    return row('red', 'embed proof freeze handshake found a non-drain hold', evidence);
  }

  try {
    freeze = beginEmbedProofFreezeRequest({
      reason: 'launch_stoplight_freeze_handshake',
      ttlMs: Number(process.env.ROBOTDOJO_STOPLIGHT_DRAIN_FREEZE_TTL_MS || 2 * 60_000),
      metadata: {
        source: 'launch-stoplight',
        row: 'embed_proof_freeze_handshake',
        hold_reason: evidence.embed_pause_hold.reason,
      },
    });
    evidence.request = {
      ok: freeze.ok,
      reason: freeze.reason,
      id: freeze.id || null,
      current_reason: freeze.current_reason || null,
    };
    if (!freeze.ok) {
      return row('red', 'embed proof freeze handshake request failed', evidence);
    }

    evidence.parked = await waitForEmbedProofFreezeStatus(freeze.id, {
      timeoutMs: Number(process.env.ROBOTDOJO_STOPLIGHT_DRAIN_FREEZE_HANDSHAKE_WAIT_MS || 45_000),
      intervalMs: 500,
    });
    if (!evidence.parked.ok) {
      return row('red', 'embed proof freeze handshake did not park the drain', evidence);
    }
  } finally {
    if (freeze) {
      evidence.release = releaseEmbedProofFreezeRequest(freeze);
      evidence.cleared = await waitForEmbedProofFreezeStatusClear(freeze.id);
    }
  }

  const ok = evidence.request?.ok === true
    && evidence.parked?.ok === true
    && evidence.release?.ok === true
    && evidence.cleared?.ok === true;
  return ok
    ? row('green', 'embed proof freeze handshake parked and released the drain', evidence)
    : row('red', 'embed proof freeze handshake cleanup failed', evidence);
}

async function dataPipelineInvariants() {
  const annDir = annBaseDir();
  let exactAnnFreezeDb = null;
  let exactAnnFreeze = null;
  let drainProofFreeze = null;
  let drainProofFreezeActive = false;
  const evidence = {
    ann_dir: annDir,
    artifacts: readAnnArtifacts(annDir),
    drift_threshold: annDriftThreshold,
    min_new_chunks: annRebuildMinChunks,
    post_drain_preflight: postDrainPreflightEvidence(),
  };
  const activeEmbedHold = readEmbedPauseHold({ maxCacheMs: 0 });
  evidence.embed_pause_hold = summarizeEmbedPauseHold(activeEmbedHold);
  if (activeEmbedHold.active) {
    if (
      opts.freezeActiveDrain
      && activeEmbedHold.reason === 'drain_personal_embeddings_sole_writer'
    ) {
      drainProofFreeze = beginEmbedProofFreezeRequest({
        reason: 'launch_stoplight_exact_ann_proof',
        ttlMs: Number(process.env.ROBOTDOJO_STOPLIGHT_DRAIN_FREEZE_TTL_MS || 10 * 60_000),
        metadata: {
          source: 'launch-stoplight',
          hold_reason: activeEmbedHold.reason,
        },
      });
      evidence.embed_proof_freeze = {
        request: {
          ok: drainProofFreeze.ok,
          reason: drainProofFreeze.reason,
          id: drainProofFreeze.id || null,
          current_reason: drainProofFreeze.current_reason || null,
        },
      };
      if (!drainProofFreeze.ok) {
        evidence.ann_repair_required = true;
        evidence.ann_repair = {
          loaded: false,
          reason: 'exact_ann_freeze_unavailable',
          hold_reason: activeEmbedHold.reason || 'embed-pause-hold',
          freeze_reason: drainProofFreeze.reason,
        };
        return row('red', 'data pipeline exact ANN proof freeze request failed', evidence);
      }
      const parked = await waitForEmbedProofFreezeStatus(drainProofFreeze.id);
      evidence.embed_proof_freeze.parked = parked;
      if (!parked.ok) {
        releaseEmbedProofFreezeRequest(drainProofFreeze);
        evidence.embed_proof_freeze.release = { ok: true, reason: 'released_after_park_timeout' };
        evidence.ann_repair_required = true;
        evidence.ann_repair = {
          loaded: false,
          reason: 'exact_ann_freeze_unavailable',
          hold_reason: activeEmbedHold.reason || 'embed-pause-hold',
          freeze_reason: parked.reason,
        };
        return row('red', 'data pipeline exact ANN proof drain freeze did not park', evidence);
      }
      drainProofFreezeActive = true;
    } else if (activeEmbedHold.reason === 'drain_personal_embeddings_sole_writer') {
      evidence.ann_repair_required = true;
      evidence.ann_repair = {
        loaded: false,
        reason: 'exact_ann_freeze_unavailable',
        hold_reason: activeEmbedHold.reason || 'embed-pause-hold',
      };
      evidence.active_drain_block = activeEmbeddingDrainProofBlock(activeEmbedHold);
      return row(
        'green',
        'data pipeline exact ANN proof intentionally blocked by active embedding drain',
        evidence,
      );
    } else {
      evidence.ann_repair_required = true;
      evidence.ann_repair = {
        loaded: false,
        reason: 'exact_ann_freeze_unavailable',
        hold_reason: activeEmbedHold.reason || 'embed-pause-hold',
      };
      return row('red', 'data pipeline exact ANN proof blocked by non-drain embed hold', evidence);
    }
  }
  evidence.qa_surface = await qaSurfaceLeakCheck();

  const vecOrphanRepair = runCommand(process.execPath, ['scripts/migration/repair-split-vec-orphans.mjs'], { timeout: 120_000 });
  evidence.vec_orphan_repair = vecOrphanRepair;
  const orphanCheck = runCommand(process.execPath, ['scripts/qa/check-vec-orphans.js'], { timeout: 120_000 });
  evidence.orphan_check = orphanCheck;
  evidence.embed_daemon_runtime = await embedDaemonRuntimeEvidence();
  evidence.embed_backlog_hygiene_before = await embedBacklogHygiene();
  evidence.embed_work_order = await embedWorkOrderFairness();
  evidence.embed_backlog_hygiene = await embedBacklogHygiene();
  evidence.embed_work_order_coverage = embedWorkOrderCoverage(
    evidence.embed_backlog_hygiene_before,
    evidence.embed_work_order,
    evidence.embed_backlog_hygiene,
  );

  try {
    const sidecar = readAnnSidecar(annDir);
    if (sidecar) evidence.sidecar = sidecar.summary;
  } catch (err) {
    evidence.sidecar_error = err?.message || String(err);
  }

  try {
    const { default: db } = await import('../../lib/db.js');
    const {
      ensureGlobalIndexAvailableForRetrieval,
      getGlobalAnnReadiness,
      reclaimStaleGlobalRebuildLock,
    } = await import('../../lib/ann/usearch-adapter.js');
    evidence.ann_lock_reclaim = reclaimStaleGlobalRebuildLock();
    evidence.artifacts = readAnnArtifacts(annDir);
    let liveEmbedded = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1').get()?.n || 0;
    const migratedTopics = db.prepare('SELECT COUNT(*) AS n FROM topic_vec_migrations').get()?.n || 0;
    evidence.db = { live_embedded: liveEmbedded, migrated_topics: migratedTopics };
    evidence.post_drain_preflight = postDrainPreflightEvidence(Date.now(), {
      liveEmbedded,
    });

    if (orphanCheck.ok && liveEmbedded > 0 && process.env.ROBOTDOJO_STOPLIGHT_SKIP_ANN_REPAIR !== '1') {
      exactAnnFreezeDb = db;
      exactAnnFreeze = drainProofFreezeActive
        ? {
            ok: true,
            reason: 'drain_owned_exact_ann_freeze_active',
            hold_reason: activeEmbedHold.reason,
            proof_freeze_id: drainProofFreeze?.id || null,
          }
        : beginExactAnnProofEmbedFreeze(db);
      evidence.exact_ann_embed_freeze = exactAnnFreeze;
      if (!exactAnnFreeze.ok) {
        evidence.ann_repair_required = true;
        evidence.ann_repair = {
          loaded: false,
          reason: 'exact_ann_freeze_unavailable',
          hold_reason: exactAnnFreeze.hold_reason || exactAnnFreeze.reason,
          current_reason: exactAnnFreeze.current_reason || null,
        };
      } else {
        await sleep(Number(process.env.ROBOTDOJO_STOPLIGHT_EXACT_ANN_FREEZE_SETTLE_MS || 1500));
        evidence.ann_repair_required = true;
        evidence.ann_repair = await ensureGlobalIndexAvailableForRetrieval(db, {
          forceSynchronous: true,
          maxAllowedDriftChunks: 0,
          reason: 'launch-stoplight',
          yieldEveryN: 1000,
        });
        liveEmbedded = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1').get()?.n || 0;
        evidence.db.live_embedded = liveEmbedded;
        evidence.artifacts = readAnnArtifacts(annDir);
        try {
          const repairedSidecar = readAnnSidecar(annDir);
          if (repairedSidecar) evidence.sidecar = repairedSidecar.summary;
          else delete evidence.sidecar;
        } catch (err) {
          evidence.sidecar_error = err?.message || String(err);
        }
      }
    } else {
      evidence.ann_repair_required = false;
    }

    evidence.ann_readiness = getGlobalAnnReadiness(db);

    if (evidence.sidecar) {
      evidence.ann_drift_chunks = liveEmbedded - evidence.sidecar.built_from_count;
      evidence.ann_growth_threshold = annGrowthThreshold(evidence.sidecar.built_from_count);
      evidence.ann_drift = evidence.ann_drift_chunks / Math.max(evidence.sidecar.built_from_count, 1);
    }
  } catch (err) {
    evidence.db_error = err?.message || String(err);
  }

  try {
    evidence.data_plane_proof = await adminDataPlaneProof();
    evidence.ann_rebuild_ownership = await waitForGlobalHnswBuildersIdle(annDir);
    if (evidence.ann_rebuild_ownership?.artifacts) {
      evidence.artifacts = evidence.ann_rebuild_ownership.artifacts;
    }
    if (evidence.ann_rebuild_ownership?.builders) {
      evidence.builders = evidence.ann_rebuild_ownership.builders;
    }
    try {
      const refreshedSidecar = readAnnSidecar(annDir);
      if (refreshedSidecar) evidence.sidecar = refreshedSidecar.summary;
      const { default: db } = await import('../../lib/db.js');
      const { getGlobalAnnReadiness } = await import('../../lib/ann/usearch-adapter.js');
      const liveEmbedded = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1').get()?.n || 0;
      evidence.db = { ...(evidence.db || {}), live_embedded: liveEmbedded };
      evidence.ann_readiness = getGlobalAnnReadiness(db);
      if (evidence.sidecar) {
        evidence.ann_drift_chunks = liveEmbedded - evidence.sidecar.built_from_count;
        evidence.ann_growth_threshold = annGrowthThreshold(evidence.sidecar.built_from_count);
        evidence.ann_drift = evidence.ann_drift_chunks / Math.max(evidence.sidecar.built_from_count, 1);
      }
    } catch (err) {
      evidence.ann_final_refresh_error = err?.message || String(err);
    }
  } finally {
    if (exactAnnFreezeDb && exactAnnFreeze?.ok === true && exactAnnFreeze?.token) {
      evidence.exact_ann_embed_freeze_release = releaseExactAnnProofEmbedFreeze(exactAnnFreezeDb, exactAnnFreeze);
    } else if (exactAnnFreeze) {
      evidence.exact_ann_embed_freeze_release = {
        ok: true,
        skipped: true,
        reason: 'exact_ann_freeze_not_acquired',
      };
    }
    if (drainProofFreeze) {
      evidence.embed_proof_freeze = {
        ...(evidence.embed_proof_freeze || {}),
        release: releaseEmbedProofFreezeRequest(drainProofFreeze),
      };
    }
  }

  if (!evidence.builders) evidence.builders = globalHnswBuilders();
  evidence.health = await waitForOk(async () => {
    const health = await currentServerHealth({ timeoutMs: 4000 });
    const body = health.body || {};
    const runtimeFullSize = Number(body.ann_runtime?.full_size || body.warmup?.ann_chunks || 0);
    return {
      ...health,
      ok: health.ok
        && body.warmup_complete === true
        && (body.ann_runtime?.loaded === true || body.warmup?.ann_done === true)
        && body.ann_runtime?.readiness?.ready === true
        && body.ann_runtime?.stale_on_disk !== true
        && runtimeFullSize === Number(evidence.sidecar?.built_from_count || -1),
    };
  }, {
    timeoutMs: Number(process.env.ROBOTDOJO_STOPLIGHT_DATA_HEALTH_TIMEOUT_MS || 60_000),
    intervalMs: 1500,
  });
  let supervisorHeartbeat = null;
  try {
    const { readSupervisorHeartbeat } = await import('../../lib/supervisor-status.js');
    supervisorHeartbeat = readSupervisorHeartbeat();
  } catch (err) {
    supervisorHeartbeat = { alive: false, error: err?.message || String(err) };
  }
  evidence.background_health = healthBackgroundSummary(
    evidence.health.body || {},
    supervisorHeartbeat,
  );
  evidence.passive_routines = await passiveRoutineLaunchHealth();

  const sidecarOk = evidence.sidecar
    && evidence.sidecar.dim === 1024
    && evidence.sidecar.hot_size >= 0
    && evidence.sidecar.full_size === evidence.sidecar.built_from_count
    && evidence.sidecar.source_embedded_count === evidence.sidecar.built_from_count
    && (evidence.sidecar.hot_size === 0 || evidence.artifacts.hot);
  const driftOk = Number.isFinite(evidence.ann_drift_chunks)
    && evidence.ann_drift_chunks >= 0
    && evidence.ann_drift_chunks === 0;
  const annRepairOk = evidence.ann_repair_required !== true
    || evidence.ann_repair?.loaded === true;
  const annReadinessOk = evidence.ann_readiness?.ready === true;
  const vecOrphanRepairOk = evidence.vec_orphan_repair?.ok === true;
  const postDrainPreflightCoversLive = evidence.post_drain_preflight?.ann_source_projection?.within_lag !== false;
  const ok = vecOrphanRepairOk
    && orphanCheck.ok
    && annRepairOk
    && annReadinessOk
    && evidence.data_plane_proof.ok
    && evidence.qa_surface.ok
    && evidence.embed_daemon_runtime.ok
    && evidence.embed_backlog_hygiene_before.ok
    && evidence.embed_backlog_hygiene.ok
    && evidence.embed_work_order.ok
    && evidence.embed_work_order_coverage.ok
    && evidence.artifacts.sidecar
    && (evidence.sidecar?.hot_size === 0 || evidence.artifacts.hot)
    && evidence.artifacts.full
    && !evidence.artifacts.building_lock
    && sidecarOk
    && driftOk
    && evidence.builders.ok
    && evidence.builders.count === 0
    && evidence.health.ok
    && evidence.passive_routines.ok
    && evidence.post_drain_preflight.ok
    && postDrainPreflightCoversLive
    && (evidence.background_health.ready || evidence.background_health.state === 'foreground_safe_warming');

  return ok
    ? row(
        'green',
        evidence.background_health.ready
          ? 'data pipeline invariants passed: proof rows, vectors, ANN, warmup, passive summaries, and rebuild ownership are coherent'
          : 'data pipeline semantic invariants passed; passive summaries are foreground-safe warming',
        evidence,
      )
    : row('red', 'data pipeline invariant failed', evidence);
}

async function foregroundActivitySignal() {
  const evidence = {};
  try {
    const { default: db } = await import('../../lib/db.js');
    const { shouldRecordForegroundActivity } = await import('../../lib/request-observer.js');

    const classifierCases = [
      { method: 'GET', path: '/api/auth/probe', expected: false, reason: 'login-probe liveness' },
      { method: 'POST', path: '/api/admin/data-plane-proof', expected: false, reason: 'admin launch proof' },
      { method: 'GET', path: '/api/server-health?deep=1', expected: false, reason: 'server health probe' },
      { method: 'GET', path: '/api/public-chat/health', expected: false, reason: 'public chat health probe' },
      { method: 'GET', path: '/chat/app.js?v=5', expected: false, reason: 'chat static alias app bundle' },
      { method: 'GET', path: '/chat/style.css?v=3', expected: false, reason: 'chat static alias stylesheet' },
      { method: 'GET', path: '/chat/modules/chat.js', expected: false, reason: 'chat static alias module' },
      { method: 'GET', path: '/chat', expected: true, reason: 'chat app shell' },
      { method: 'GET', path: '/chat/career-deep-tech-a1b2c3d4', expected: true, reason: 'chat conversation shell' },
      { method: 'POST', path: '/api/chat/stream', expected: true, reason: 'chat turn stream' },
      { method: 'POST', path: '/api/accounts/connect', expected: true, reason: 'connect/login mutation' },
    ].map((item) => ({
      ...item,
      actual: shouldRecordForegroundActivity({ method: item.method, path: item.path }),
    }));
    evidence.classifier = {
      ok: classifierCases.every((item) => item.actual === item.expected),
      cases: classifierCases,
    };

    const serverSource = readFileSync(join(REPO_ROOT, 'lib/server.js'), 'utf8');
    evidence.server_wiring = {
      ok: serverSource.includes('shouldRecordForegroundActivity')
        && serverSource.includes('if (foregroundActivity) recordActivityStart(dbModule)')
        && serverSource.includes('if (foregroundActivity) recordActivityFinish(dbModule)')
        && serverSource.includes('recordChatActivity(dbModule)'),
    };

    const health = await waitForOk(async () => {
      const result = await currentServerHealth({ timeoutMs: 4000 });
      return {
        ...result,
        ok: result.ok && result.body?.warmup_complete === true,
      };
    }, {
      timeoutMs: Number(process.env.ROBOTDOJO_STOPLIGHT_ACTIVITY_HEALTH_TIMEOUT_MS || 60_000),
      intervalMs: 1500,
    });
    evidence.health = {
      ok: health.ok,
      base: health.base || localBase,
      warmup_complete: health.body?.warmup_complete ?? null,
      poll_attempts: health.poll_attempts,
      poll_ms: health.poll_ms,
    };
    const base = health.base || localBase;

    const authProbe = await fetchJson(`${base}/api/auth/probe`, {}, 5000);
    const chatAsset = await fetchJson(`${base}/chat/app.js?v=5`, {}, 5000);
    const chatCss = await fetchJson(`${base}/chat/style.css?v=3`, {}, 5000);
    const chatShell = await fetchJson(`${base}/chat`, {}, 5000);
    evidence.live_routes = {
      ok: authProbe.res.status === 200
        && authProbe.body?.ok === true
        && chatAsset.res.status === 200
        && /javascript/i.test(chatAsset.res.headers.get('content-type') || '')
        && chatCss.res.status === 200
        && /css/i.test(chatCss.res.headers.get('content-type') || '')
        && [200, 302, 303, 307, 308].includes(chatShell.res.status),
      auth_probe: { status: authProbe.res.status, ok: authProbe.body?.ok === true },
      chat_asset: { status: chatAsset.res.status, content_type: chatAsset.res.headers.get('content-type') || null },
      chat_css: { status: chatCss.res.status, content_type: chatCss.res.headers.get('content-type') || null },
      chat_shell: { status: chatShell.res.status, location: chatShell.res.headers.get('location') || null },
    };

    const deltaProof = await proveForegroundActivityDeltas(db, base);
    evidence.live_activity_row = deltaProof.evidence;
    const rowProofOk = deltaProof.ok;
    const ok = evidence.classifier.ok
      && evidence.server_wiring.ok
      && evidence.health.ok
      && evidence.live_routes.ok
      && rowProofOk;

    return ok
      ? row('green', 'foreground activity signal separates probes/assets from real product work', evidence)
      : row('red', 'foreground activity signal contract failed', evidence);
  } catch (err) {
    return row('red', 'foreground activity signal check errored', {
      ...evidence,
      error: err?.message || String(err),
    });
  }
}

async function sessionLogNonblocking() {
  const start = Date.now();
  try {
    const res = await fetchJson(`${localBase}/api/session-log/turn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {}),
      },
      body: JSON.stringify({
        source: 'launch-stoplight',
        threadId: 'launch-stoplight',
        role: 'user',
        content: 'session-log nonblocking probe',
      }),
    }, 2000);
    const ms = Date.now() - start;
    const ok = res.res.status === 202
      && res.body?.ok === true
      && ['memory', 'file', 'durable', 'dropped'].includes(res.body.mode)
      && ms < 250;
    return ok
      ? row('green', 'session-log accepted/deferred/dropped within budget', { status: res.res.status, ms, body: res.body })
      : row('red', 'session-log response missed nonblocking contract', { status: res.res.status, ms, body: res.body });
  } catch (err) {
    return row('red', 'session-log nonblocking probe failed', { error: err?.message || String(err) });
  }
}

async function foregroundUnderBackground() {
  const result = runCommand(process.execPath, ['scripts/qa/passive-launch-chaos.js', '--max-ms', '500'], { timeout: 120_000 });
  return result.ok
    ? row('green', 'foreground probes stayed fast under background pressure', result)
    : row('red', 'foreground/background chaos probe failed', result);
}

async function installerProcesses() {
  const parity = runCommand(process.execPath, ['scripts/check-installer-parity.js']);
  const ownership = runCommand(process.execPath, ['scripts/check-launch-state-ownership.js']);
  const launchIntent = runCommand(process.execPath, ['scripts/check-live-launch-agents.js', '--packaged-only'], { timeout: 30_000 });
  const live = opts.strictLaunchd
    ? runCommand(process.execPath, ['scripts/check-live-launch-agents.js', '--print-loaded'], { timeout: 30_000 })
    : { ok: true, skipped: true };
  const ok = parity.ok && ownership.ok && launchIntent.ok && live.ok;
  return ok
    ? row('green', 'installer manifest, ownership, and launch process checks passed', { parity, ownership, launchIntent, live })
    : row('red', 'installer/process ownership check failed', { parity, ownership, launchIntent, live });
}

async function relayLoginChat() {
  if (!relayBase) return row('red', 'relay URL unavailable', { relayBase: null });
  const auth = await loginAt(relayBase);
  if (!auth.ok) return row('red', 'relay token login failed', { relayBase, error: auth.error, status: auth.status });
  const chat = await streamChatAt(relayBase, auth.cookie, {
    prompt: 'Relay launch stoplight smoke: answer with one short sentence.',
    timeoutMs: Number(process.env.ROBOTDOJO_STOPLIGHT_CHAT_TIMEOUT_MS || 75_000),
  });
  const cleanup = await cleanupStoplightConversation(chat.conversationId);
  return chat.ok && cleanup.ok
    ? row('green', 'relay login and private chat passed through standalone-sni path', { relayBase, ...chat, cleanup })
    : row('red', chat.ok ? 'relay private chat cleanup failed' : 'relay private chat failed', { relayBase, ...chat, cleanup });
}

async function chatOpenDaemonQuiet() {
  const unit = runCommand(process.execPath, ['--test', 'tests/embed-chat-app-active.test.js'], { timeout: 60_000 });
  let active = null;
  try {
    const auth = await loginAt(localBase);
    if (auth.ok) {
      active = await postChatActivePing(localBase, auth.cookie);
    } else {
      active = { ok: false, error: auth.error };
    }
  } catch (err) {
    active = { ok: false, error: err?.message || String(err) };
  }
  const ok = unit.ok && (active?.ok || process.env.ROBOTDOJO_STOPLIGHT_ALLOW_STATIC_CHAT_ACTIVE === '1');
  return ok
    ? row('green', 'chat-open signal quieting contract passed', { unit, active })
    : row('red', 'chat-open daemon quieting failed', { unit, active });
}

async function demoPrivateRouting() {
  const result = runCommand(process.execPath, ['--test', 'tests/demo-shell-guard.test.js'], { timeout: 60_000 });
  return result.ok
    ? row('green', 'demo/private routing guard passed', result)
    : row('red', 'demo/private routing guard failed', result);
}

async function browserProductProof() {
  const commandArgs = [
    'node_modules/@playwright/test/cli.js',
    'test',
    ...BROWSER_PRODUCT_PROOF_SPECS,
  ];
  const result = runCommand(process.execPath, commandArgs, {
    timeout: browserProductProofTimeoutMs,
    env: {
      QA_BASE_URL: process.env.QA_BASE_URL || localBase,
      QA_HEADLESS: process.env.QA_HEADLESS || '1',
    },
  });
  const entityCardContract = browserEntityCardContractEvidence();
  const evidence = {
    command: [process.execPath, ...commandArgs],
    specs: [...BROWSER_PRODUCT_PROOF_SPECS],
    entity_card_contract: entityCardContract,
    timeout_ms: browserProductProofTimeoutMs,
    result,
  };
  return result.ok && entityCardContract.ok
    ? row('green', 'first-session, real browser chat, source-bound entity-card, and chat path matrix passed', evidence)
    : row('red', result.ok ? 'browser entity-card product proof contract failed' : 'first-session, real browser chat, or chat path matrix failed', evidence);
}

function browserEntityCardContractEvidence() {
  const specPath = join(REPO_ROOT, BROWSER_ENTITY_CARD_PROOF.spec);
  let source = '';
  try {
    source = readFileSync(specPath, 'utf8');
  } catch (err) {
    return {
      ...BROWSER_ENTITY_CARD_PROOF,
      ok: false,
      spec_path: specPath,
      error: err?.message || String(err),
      markers: {},
    };
  }
  const markers = {
    test_name: source.includes(BROWSER_ENTITY_CARD_PROOF.test_name),
    seed_marker: source.includes(BROWSER_ENTITY_CARD_PROOF.seed_marker),
    network_question: source.includes(BROWSER_ENTITY_CARD_PROOF.network_question),
    direct_find_question: source.includes(BROWSER_ENTITY_CARD_PROOF.direct_find_question),
    negative_premise_question: source.includes(BROWSER_ENTITY_CARD_PROOF.negative_premise_question),
    expected_answer: source.includes(BROWSER_ENTITY_CARD_PROOF.expected_answer),
  };
  return {
    ...BROWSER_ENTITY_CARD_PROOF,
    ok: Object.values(markers).every(Boolean),
    spec_path: specPath,
    markers,
  };
}

const ROWS = {
  local_readiness: localReadiness,
  login_session: () => loginSession(localBase),
  private_chat: () => privateChat(localBase),
  chat_stall_recovery: chatStallRecovery,
  retrieval_sentinel: retrievalSentinel,
  browser_product_proof: browserProductProof,
  foreground_activity_signal: foregroundActivitySignal,
  session_log_nonblocking: sessionLogNonblocking,
  foreground_under_background: foregroundUnderBackground,
  installer_processes: installerProcesses,
  relay_login_chat: relayLoginChat,
  chat_open_daemon_quiet: chatOpenDaemonQuiet,
  embed_writer_exclusivity: embedWriterExclusivity,
  embedding_drain_progress: personalDrainProgress,
  personal_drain_progress: personalDrainProgress,
  embed_proof_freeze_handshake: embedProofFreezeHandshake,
  data_pipeline_invariants: dataPipelineInvariants,
  demo_private_routing: demoPrivateRouting,
};

const PREREQS = {
  login_session: ['local_readiness'],
  private_chat: ['local_readiness', 'login_session'],
  foreground_activity_signal: ['local_readiness'],
  session_log_nonblocking: ['local_readiness'],
  foreground_under_background: [],
  relay_login_chat: ['installer_processes'],
  chat_open_daemon_quiet: ['local_readiness', 'login_session'],
  data_pipeline_invariants: ['local_readiness', 'foreground_activity_signal'],
  retrieval_sentinel: ['data_pipeline_invariants'],
  browser_product_proof: ['local_readiness', 'login_session'],
};

function selectedRows() {
  if (opts.rows.length) {
    const set = new Set();
    const visiting = new Set();
    const visited = new Set();
    const add = (id, stack = []) => {
      if (!ROW_IDS.includes(id)) throw new Error(`unknown row: ${id}`);
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`row dependency cycle: ${[...stack, id].join(' -> ')}`);
      }
      visiting.add(id);
      for (const prereq of PREREQS[id] || []) add(prereq, [...stack, id]);
      visiting.delete(id);
      visited.add(id);
      set.add(id);
    };
    for (const id of opts.rows) {
      add(id);
    }
    return [...set];
  }
  const rows = new Set([
    'local_readiness',
    'login_session',
    'private_chat',
    'foreground_activity_signal',
    'session_log_nonblocking',
    'foreground_under_background',
    'installer_processes',
    'chat_open_daemon_quiet',
    'chat_stall_recovery',
    'embed_writer_exclusivity',
    'retrieval_sentinel',
    'data_pipeline_invariants',
    'demo_private_routing',
  ]);
  if (opts.relay) rows.add('relay_login_chat');
  return ROW_IDS.filter((id) => rows.has(id));
}

function reportTimestamp(iso) {
  return String(iso || new Date().toISOString())
    .replace(/[-:]/g, '')
    .replace(/\.(\d+)Z$/, '$1Z');
}

function reportNamePart(value) {
  return String(value || 'run')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'run';
}

function snapshotReportPath(payload) {
  const rows = Array.isArray(payload?.rows) && payload.rows.length
    ? payload.rows.map((r) => r?.id).filter(Boolean).join('+')
    : 'fatal';
  const nonce = crypto.randomUUID().slice(0, 8);
  return join(reportSnapshotDir, `${reportTimestamp(payload?.checked_at)}-${reportNamePart(rows)}-${nonce}.json`);
}

function atomicWriteFile(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw err;
  }
}

function writeStdout(text) {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function writeReportPayload(payload) {
  const snapshotPath = snapshotReportPath(payload);
  const withPaths = {
    ...payload,
    report_path: reportPath,
    snapshot_path: snapshotPath,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  mkdirSync(reportSnapshotDir, { recursive: true });
  const text = JSON.stringify(withPaths, null, 2);
  atomicWriteFile(snapshotPath, text);
  atomicWriteFile(reportPath, text);
  return withPaths;
}

let activeRunLock = null;

function releaseActiveRunLock() {
  try { activeRunLock?.release?.(); } catch {}
  activeRunLock = null;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    releaseActiveRunLock();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

async function restartServices() {
  const labels = ['com.robotdojo.server', 'com.robotdojo.chunk-embed-daemon', 'com.robotdojo.tunnel'];
  const services = labels.map((label) => {
    const result = spawnSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 15_000,
    });
    return {
      label,
      ok: result.status === 0,
      status: result.status,
      stderr: String(result.stderr || '').trim(),
    };
  });
  const local = await waitForOk(localFetchReadiness, { timeoutMs: restartLocalTimeoutMs, intervalMs: 1500 });
  const relay = opts.relay && relayBase ? { ok: false } : { ok: true, skipped: true };
  if (opts.relay && relayBase) {
    Object.assign(relay, await waitForOk(async () => {
      const res = await fetch(`${relayBase}/api/auth/probe`, {
        method: 'GET',
        signal: timeoutSignal(3000),
        redirect: 'manual',
      });
      return { ok: res.status === 200, status: res.status };
    }, { timeoutMs: 25_000, intervalMs: 1500 }));

    if (!relay.ok && existsSync(join(REPO_ROOT, 'scripts/update-nlb-target.sh'))) {
      const nlb = runCommand('bash', ['scripts/update-nlb-target.sh'], { timeout: 60_000 });
      relay.nlb_repair = nlb;
      Object.assign(relay, await waitForOk(async () => {
        const res = await fetch(`${relayBase}/api/auth/probe`, {
          method: 'GET',
          signal: timeoutSignal(3000),
          redirect: 'manual',
        });
        return { ok: res.status === 200, status: res.status };
      }, { timeoutMs: 45_000, intervalMs: 2000 }));
    }
  }
  return { services, local, relay };
}

async function main(runLock = null) {
  const checks = [];
  const resultsById = new Map();
  const restart = opts.restartServices ? await restartServices() : null;
  for (const id of selectedRows()) {
    const started = Date.now();
    let result;
    const failedPrereqs = (PREREQS[id] || [])
      .map((prereqId) => {
        const prereq = resultsById.get(prereqId);
        return {
          id: prereqId,
          status: prereq?.status || 'missing',
          detail: prereq?.detail || 'prerequisite row did not run',
        };
      })
      .filter((prereq) => prereq.status !== 'green');
    if (failedPrereqs.length) {
      result = row('red', 'row dependency blocked: prerequisite row(s) are not green', {
        dependency_blocked: true,
        failed_prereqs: failedPrereqs,
      });
    } else {
      try {
        result = await ROWS[id]();
      } catch (err) {
        result = row('red', 'row threw before completion', { error: err?.stack || err?.message || String(err) });
      }
    }
    const check = { id, ...result, duration_ms: Date.now() - started };
    checks.push(check);
    resultsById.set(id, check);
  }

  const ok = checks.every((r) => r.status === 'green');
  const payload = {
    ok,
    checked_at: new Date().toISOString(),
    options: opts,
    run_lock: runLock ? {
      path: runLock.path,
      attempts: runLock.attempts,
      waited_ms: runLock.waited_ms,
    } : null,
    restart,
    rows: checks,
  };
  const written = writeReportPayload(payload);
  await writeStdout(JSON.stringify(written, null, 2) + '\n');
  return ok ? 0 : 1;
}

async function run() {
  const runLock = await acquireRunLock();
  activeRunLock = runLock;
  try {
    return await main(runLock);
  } finally {
    releaseActiveRunLock();
  }
}

run().then((code) => process.exit(code)).catch((err) => {
  const payload = {
    ok: false,
    checked_at: new Date().toISOString(),
    options: opts,
    run_lock: null,
    rows: [{ id: 'fatal', status: 'red', detail: err?.message || String(err), evidence: {} }],
  };
  try {
    writeReportPayload(payload);
  } catch {}
  process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});
