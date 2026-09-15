#!/usr/bin/env node
/**
 * scripts/build-global-hnsw.js — st_cc25425e
 *
 * Builds the unified 1024-dim Snowflake HNSW index that the
 * Phase 4 query path (lib/ann/usearch-adapter.js → annSearch) reads. The
 * build is intentionally offline — buildGlobalIndex's inner loops yield
 * to the event loop every 1000 vectors so the script remains responsive
 * (Ctrl-C works) and a server reload that re-runs the script doesn't
 * stall application startup.
 *
 * Why a separate script vs the boot path: the 1.2M-vector rebuild on
 * Apple Silicon is 10–30 min of synchronous usearch.add work even with
 * yields. Putting that in boot warmup (Phase 4 original plan) blocks
 * app.listen — chat is unreachable for the entire build. Running it
 * offline produces the same artifact at ~/.robotdojo-ann/{hot,full}.usearch
 * + sidecar.json; the server's runBootWarmup() then loads it via
 * loadGlobalIndex() in milliseconds.
 *
 * Usage:
 *   node scripts/build-global-hnsw.js              # full rebuild
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/build-global-hnsw.js
 *
 * The script prints progress every 10K vectors so you can see it's
 * making forward motion. The build is idempotent — re-running on a
 * fresh DB produces the same artifact (modulo HNSW's randomized graph
 * construction).
 *
 * Run cadence (operational):
 *   - One-time after every major data import / re-embed
 *   - The runtime query path falls back to per-topic sqlite-vec MATCH
 *     if the global index is missing or stale, so a missed rebuild
 *     degrades to "old st_566ad80b speed" — never to broken chat.
 *
 * INTELLIGENCE_TIER: extraction (no LLM calls — deterministic vector
 * algebra + index construction).
 */

export const INTELLIGENCE_TIER = 'extraction';

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import db from '../lib/db.js';
import {
  buildGlobalIndex,
  getGlobalAnnReadiness,
  QUALITY_VERSION,
} from '../lib/ann/usearch-adapter.js';
import { HNSW_DIMS } from '../lib/ann/ann-config.js';
import { EMBED_MODEL } from '../lib/rag.js';
import {
  activityPauseDecision,
  chatAppActiveDecision,
  getActivitySignal,
  waitWhileChatAppActive,
} from '../lib/request-observer.js';
import { readEmbedPauseHold } from '../lib/embed-pause-hold.js';
import { getIdleSeconds } from '../lib/idle-gate.js';

// st_fd14cdd4 — chat-yield abort. This detached rebuild cannot be SIGTERM'd by
// the server's chat-app-active path, so it self-yields at each ~1000-vector slice
// boundary via waitWhileChatAppActive. The AbortController lets a real SIGTERM
// break that pause-poll wait immediately (instead of waiting out a poll), and the
// existing clearLock handlers below still drop the .building lock on exit.
const ac = new AbortController();

// st_d142f701 AC14: cooperate with the auto-rebuild lock in usearch-adapter.js.
// On exit (success, failure, or unhandled crash) we drop the .building lock so
// the next stale detection can spawn a fresh rebuild.
const ANN_DIR = process.env.ROBOTDOJO_ANN_DIR || path.join(homedir(), '.robotdojo-ann');
const LOCK_PATH = path.join(ANN_DIR, 'sidecar.json.building');
const BACKUP_DIR = `${ANN_DIR}.bak`;
const LOCK_STALE_MS = (() => {
  const raw = Number(process.env.ROBOTDOJO_ANN_REBUILD_LOCK_STALE_MS || '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60 * 60_000;
})();
const PENDING_LOCK_STALE_MS = (() => {
  const raw = Number(process.env.ROBOTDOJO_ANN_REBUILD_PENDING_LOCK_STALE_MS || '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2 * 60_000;
})();
const INHERITED_LOCK_TOKEN = process.env.ROBOTDOJO_ANN_REBUILD_LOCK_TOKEN || '';
const LOCK_ID = INHERITED_LOCK_TOKEN ? INHERITED_LOCK_TOKEN.split(':').at(-1) : randomUUID();
let LOCK_TOKEN = `child:${process.pid}:${Date.now()}:${LOCK_ID}`;
const AUTO_REBUILD_CHILD = !!INHERITED_LOCK_TOKEN;
const AUTO_DEFER_ON_FOREGROUND = AUTO_REBUILD_CHILD
  && process.env.ROBOTDOJO_ANN_REBUILD_WAIT_ON_FOREGROUND !== '1';
const POST_DRAIN_HOLD_REASON = 'post_drain_pipeline_sole_writer';
const REQUIRE_FOREGROUND_IDLE = process.env.ROBOTDOJO_ANN_REBUILD_REQUIRE_FOREGROUND_IDLE !== '0';
const FORCE_REBUILD = process.env.ROBOTDOJO_GLOBAL_HNSW_FORCE_REBUILD === '1'
  || process.argv.includes('--force');
const FOREGROUND_QUIET_MS = Number(process.env.ROBOTDOJO_ANN_REBUILD_FOREGROUND_QUIET_MS || 15 * 60_000);
const FOREGROUND_HID_IDLE_SECONDS = Number(process.env.ROBOTDOJO_ANN_REBUILD_HID_IDLE_SECONDS || 15 * 60);
const FOREGROUND_POLL_MS = Number(process.env.ROBOTDOJO_ANN_REBUILD_FOREGROUND_POLL_MS || 5000);
const FOREGROUND_LOG_MS = Number(process.env.ROBOTDOJO_ANN_REBUILD_FOREGROUND_LOG_MS || 60_000);
const RESULT_FILE = (() => {
  const arg = process.argv.slice(2).find((value) => value.startsWith('--result-file='));
  if (arg) return arg.split('=').slice(1).join('=');
  const idx = process.argv.indexOf('--result-file');
  if (idx >= 0) return process.argv[idx + 1] || '';
  return process.env.ROBOTDOJO_GLOBAL_HNSW_RESULT_FILE || '';
})();

function atomicWriteJson(file, payload) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function writeResult(payload) {
  atomicWriteJson(RESULT_FILE, {
    action: 'global_hnsw_rebuild',
    checked_at: new Date().toISOString(),
    ann_dir: ANN_DIR,
    pid: process.pid,
    ...payload,
  });
}

function readLock() {
  try { return fs.readFileSync(LOCK_PATH, 'utf8').trim(); } catch { return null; }
}

function writeLockToken() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, LOCK_TOKEN);
    return true;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function claimInheritedLock(current) {
  if (!INHERITED_LOCK_TOKEN) return false;
  if (current === INHERITED_LOCK_TOKEN) {
    fs.writeFileSync(LOCK_PATH, LOCK_TOKEN);
    return true;
  }
  if (lockIdFromToken(current) === LOCK_ID && lockOwnerPid(current) === process.pid) {
    LOCK_TOKEN = current;
    return true;
  }
  return false;
}

function lockOwnerPid(token) {
  const parts = String(token || '').split(':');
  const raw = parts[0] === 'pending' || parts[0] === 'child' ? parts[1] : parts[0];
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function lockIdFromToken(token) {
  const parts = String(token || '').split(':');
  return parts.length >= 3 ? parts.at(-1) : '';
}

function lockOwnerAlive(token) {
  const pid = lockOwnerPid(token);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function lockOwnerCommand(token) {
  const pid = lockOwnerPid(token);
  if (!pid) return '';
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1000,
    });
    return String(result.stdout || '').trim();
  } catch {
    return '';
  }
}

function lockReclaimable(token) {
  if (!token) return true;
  let ageMs = Infinity;
  try { ageMs = Date.now() - fs.statSync(LOCK_PATH).mtimeMs; } catch {}
  const pending = String(token).startsWith('pending:');
  const ownerAlive = lockOwnerAlive(token);
  if (pending) return !ownerAlive || ageMs >= PENDING_LOCK_STALE_MS;
  if (!ownerAlive) return true;
  const ownerCommand = lockOwnerCommand(token);
  if (ownerCommand.includes('build-global-hnsw')) return false;
  return ageMs >= LOCK_STALE_MS;
}

function acquireLock() {
  const current = readLock();
  if (current === LOCK_TOKEN) return true;
  if (claimInheritedLock(current)) return true;
  if (INHERITED_LOCK_TOKEN && current && current !== LOCK_TOKEN) {
    console.info('[build-global-hnsw] another rebuild owns the lock — exiting');
    process.exit(0);
  }
  if (!current) {
    try {
      return writeLockToken();
    } catch (err) {
      if (err.code === 'EEXIST') {
        console.info('[build-global-hnsw] another rebuild acquired the lock — exiting');
        process.exit(0);
      }
      throw err;
    }
  }

  if (!lockReclaimable(current)) {
    console.info('[build-global-hnsw] rebuild already in flight — exiting');
    process.exit(0);
  }

  try { fs.unlinkSync(LOCK_PATH); } catch {}
  return writeLockToken();
}

function clearLock() {
  try {
    if (readLock() === LOCK_TOKEN) fs.unlinkSync(LOCK_PATH);
  } catch { /* not present is fine */ }
}

function artifactComplete(dir = ANN_DIR) {
  return ['hot.usearch', 'full.usearch', 'sidecar.json'].every((name) => {
    try { return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; }
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function liveEmbeddedCount() {
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1').get()?.n || 0;
  } catch {
    return 0;
  }
}

async function usearchIndexSize(file) {
  const { Index } = await import('usearch');
  const index = new Index({ metric: 'cos', dimensions: HNSW_DIMS });
  index.view(file);
  return Number(index.size());
}

async function repairMissingSidecarFromArtifacts() {
  const sidecarFile = path.join(ANN_DIR, 'sidecar.json');
  const hotFile = path.join(ANN_DIR, 'hot.usearch');
  const fullFile = path.join(ANN_DIR, 'full.usearch');
  if (fs.existsSync(sidecarFile)) return null;
  if (!fs.existsSync(hotFile) || !fs.existsSync(fullFile)) return null;

  const live = liveEmbeddedCount();
  if (live <= 0) return null;

  let hotSize = 0;
  let fullSize = 0;
  try {
    hotSize = await usearchIndexSize(hotFile);
    fullSize = await usearchIndexSize(fullFile);
  } catch (err) {
    return {
      ok: false,
      reason: 'existing_artifact_size_read_failed',
      error: err?.message || String(err),
      live_embedded: live,
    };
  }

  if (fullSize !== live) {
    return {
      ok: false,
      reason: 'existing_full_index_size_mismatch',
      live_embedded: live,
      full_size: fullSize,
      hot_size: hotSize,
    };
  }
  if (hotSize < 0 || hotSize > fullSize) {
    return {
      ok: false,
      reason: 'existing_hot_index_size_invalid',
      live_embedded: live,
      full_size: fullSize,
      hot_size: hotSize,
    };
  }

  const meta = {
    hot_size: hotSize,
    full_size: fullSize,
    dim: HNSW_DIMS,
    embedding_model_id: EMBED_MODEL,
    built_from_count: fullSize,
    source_embedded_count: fullSize,
    built_from_quality_version: QUALITY_VERSION,
    built_at: Date.now(),
    repaired_sidecar_from_existing_artifacts: true,
  };
  atomicWriteJson(sidecarFile, meta);
  return { ok: true, reason: 'sidecar_repaired_from_existing_artifacts', meta };
}

function rebuildGrowthThreshold(builtFrom) {
  return Math.max(64, Math.ceil(Math.max(builtFrom, 1) * 0.005));
}

function backupSnapshotUsable(dir = BACKUP_DIR) {
  if (!artifactComplete(dir)) return false;
  const sidecar = readJson(path.join(dir, 'sidecar.json'));
  const builtFrom = Number(sidecar?.built_from_count) || 0;
  const fullSize = Number(sidecar?.full_size) || 0;
  const sourceCount = Number(sidecar?.source_embedded_count || builtFrom) || 0;
  if (Number(sidecar?.dim) !== HNSW_DIMS) return false;
  if (builtFrom <= 0 || fullSize !== builtFrom || sourceCount !== builtFrom) return false;
  const liveCount = liveEmbeddedCount();
  if (liveCount <= 0) return false;
  const newChunks = Math.max(0, liveCount - builtFrom);
  return newChunks < rebuildGrowthThreshold(builtFrom);
}

function restoreSnapshotIfArtifactsMissing(reason) {
  if (artifactComplete(ANN_DIR) || !fs.existsSync(BACKUP_DIR)) return false;
  if (!backupSnapshotUsable(BACKUP_DIR)) {
    console.warn(`[build-global-hnsw] backup snapshot not restored after ${reason}: stale or incompatible`);
    return false;
  }
  let restored = 0;
  fs.mkdirSync(ANN_DIR, { recursive: true });
  for (const name of ['hot.usearch', 'full.usearch', 'sidecar.json']) {
    const from = path.join(BACKUP_DIR, name);
    const to = path.join(ANN_DIR, name);
    try {
      if (!fs.existsSync(to) && fs.existsSync(from)) {
        fs.copyFileSync(from, to);
        restored++;
      }
    } catch (err) {
      console.warn(`[build-global-hnsw] restore ${name} failed after ${reason}: ${err.message}`);
    }
  }
  if (restored > 0) {
    console.warn(`[build-global-hnsw] restored ${restored} ANN serving artifact(s) from backup after ${reason}`);
  }
  return artifactComplete(ANN_DIR);
}
process.on('exit', clearLock);
process.on('SIGINT', () => { ac.abort(); restoreSnapshotIfArtifactsMissing('SIGINT'); clearLock(); process.exit(130); });
process.on('SIGTERM', () => { ac.abort(); restoreSnapshotIfArtifactsMissing('SIGTERM'); clearLock(); process.exit(143); });
process.on('uncaughtException', (err) => {
  console.error('[build-global-hnsw] uncaught:', err?.message || err);
  restoreSnapshotIfArtifactsMissing('uncaught exception');
  clearLock();
  process.exit(1);
});

function foregroundDecision() {
  if (!REQUIRE_FOREGROUND_IDLE) return { ok: true, reason: 'disabled' };
  const hold = readEmbedPauseHold();
  if (hold.active && hold.reason !== POST_DRAIN_HOLD_REASON) {
    return { ok: false, reason: hold.reason || 'embed-pause-hold' };
  }
  const signal = getActivitySignal(db);
  if (chatAppActiveDecision(signal)) return { ok: false, reason: 'chat-app-open' };
  const requestGate = activityPauseDecision(signal, {
    pauseMs: FOREGROUND_QUIET_MS,
  });
  if (requestGate.pause) return { ok: false, reason: requestGate.reason };
  const idleSeconds = getIdleSeconds();
  if (idleSeconds < FOREGROUND_HID_IDLE_SECONDS) {
    return {
      ok: false,
      reason: `user-active idle=${idleSeconds}s<threshold=${FOREGROUND_HID_IDLE_SECONDS}s`,
    };
  }
  return { ok: true, reason: 'foreground-idle' };
}

let lastForegroundLogAt = 0;
async function waitForForegroundIdle(phase) {
  if (!REQUIRE_FOREGROUND_IDLE) return true;
  let paused = false;
  while (!ac.signal.aborted) {
    const decision = foregroundDecision();
    if (decision.ok) {
      if (paused) console.info(`[build-global-hnsw] foreground idle — resuming rebuild at ${phase} slice`);
      return true;
    }
    const now = Date.now();
    if (!paused || now - lastForegroundLogAt >= FOREGROUND_LOG_MS) {
      paused = true;
      lastForegroundLogAt = now;
      const verb = AUTO_DEFER_ON_FOREGROUND ? 'deferring auto rebuild' : 'pausing rebuild';
      console.info(`[build-global-hnsw] foreground active — ${verb} at ${phase} slice (${decision.reason})`);
    }
    if (AUTO_DEFER_ON_FOREGROUND) return false;
    await new Promise((r) => setTimeout(r, FOREGROUND_POLL_MS));
  }
  return false;
}

async function main() {
  const readiness = getGlobalAnnReadiness(db);
  if (!FORCE_REBUILD && !readiness.ready) {
    const repair = await repairMissingSidecarFromArtifacts();
    if (repair?.ok) {
      console.info(`[build-global-hnsw] repaired missing sidecar from existing artifacts (corpus=${repair.meta.built_from_count})`);
      writeResult({
        ok: true,
        repaired: true,
        reason: repair.reason,
        duration_ms: 0,
        artifact_complete: artifactComplete(ANN_DIR),
        meta: repair.meta,
      });
      process.exit(0);
    }
    if (repair && !repair.ok) {
      console.warn(`[build-global-hnsw] sidecar repair skipped: ${repair.reason}${repair.error ? ` (${repair.error})` : ''}`);
    }
  }
  if (!FORCE_REBUILD && readiness.ready) {
    const disk = readiness.disk || {};
    console.info(`[build-global-hnsw] fresh artifact already ready — skipping rebuild (corpus=${disk.built_from_count || readiness.live_embedded || 0})`);
    writeResult({
      ok: true,
      skipped: true,
      reason: readiness.reason || 'global_index_artifact_ready',
      duration_ms: 0,
      artifact_complete: artifactComplete(ANN_DIR),
      meta: {
        hot_size: disk.hot_size ?? null,
        full_size: disk.full_size ?? null,
        dim: disk.dim ?? HNSW_DIMS,
        built_from_count: disk.built_from_count ?? null,
        source_embedded_count: disk.source_embedded_count ?? disk.built_from_count ?? null,
      },
    });
    process.exit(0);
  }

  if (!(await waitForForegroundIdle('start'))) {
    throw new DOMException('ANN rebuild aborted before foreground idle', 'AbortError');
  }
  acquireLock();
  console.info('[build-global-hnsw] start');
  const startTs = Date.now();

  let lastReport = startTs;
  let lastN = 0;

  const onProgress = ({ phase, n }) => {
    // Throttle output to once per 10K vectors so the log stays scannable
    // even on a 1.2M-vector build (would otherwise emit 1200 lines).
    if (n - lastN < 10_000) return;
    lastN = n;
    const now = Date.now();
    const elapsedSec = Math.round((now - startTs) / 1000);
    const dt = now - lastReport;
    const rate = dt > 0 ? Math.round(10_000 / (dt / 1000)) : 0;
    console.info(`[build-global-hnsw] ${phase}=${n} (${rate} vec/s; t+${elapsedSec}s)`);
    lastReport = now;
  };

  // st_fd14cdd4 — pause the rebuild at the next slice boundary whenever the chat
  // app is open, resuming the instant it closes. A pause once per slice keeps the
  // longest uninterruptible unit at one ~1000-vector slice (~0.5s on the live
  // corpus); the index still builds fully when chat is idle. Logged once per
  // pause/resume transition so a long build's yielding is visible in the log.
  let yieldLogged = false;
  const chatYield = async (phase) => {
    if (AUTO_DEFER_ON_FOREGROUND && chatAppActiveDecision(getActivitySignal(db))) {
      console.info(`[build-global-hnsw] chat app open — deferring auto rebuild at ${phase} slice`);
      throw new DOMException('ANN auto rebuild deferred while chat app is open', 'AbortError');
    }
    const chatClosed = await waitWhileChatAppActive(db, {
      signal: ac.signal,
      onPause: () => { if (!yieldLogged) { console.info(`[build-global-hnsw] chat app open — pausing rebuild at ${phase} slice (yielding CPU to chat)`); yieldLogged = true; } },
      onResume: () => { console.info('[build-global-hnsw] chat app closed — resuming rebuild'); yieldLogged = false; },
      ignoreEmbedPauseHoldReasons: [POST_DRAIN_HOLD_REASON],
    });
    if (!chatClosed) throw new DOMException('ANN rebuild aborted while waiting for chat to close', 'AbortError');
    const foregroundIdle = await waitForForegroundIdle(phase);
    if (!foregroundIdle) throw new DOMException('ANN rebuild aborted while waiting for foreground idle', 'AbortError');
  };

  const meta = await buildGlobalIndex(db, {
    yieldEveryN: 1000,
    onProgress,
    chatYield,
  });

  const totalSec = Math.round((Date.now() - startTs) / 1000);
  if (!meta) {
    console.warn(`[build-global-hnsw] build returned null after ${totalSec}s — no embedded chunks?`);
    writeResult({
      ok: false,
      reason: 'no_embedded_chunks',
      duration_ms: Date.now() - startTs,
      artifact_complete: artifactComplete(ANN_DIR),
    });
    process.exit(2);
  }

  const sourceSuffix = meta.source_embedded_count && meta.source_embedded_count !== meta.built_from_count
    ? ` source_embedded=${meta.source_embedded_count}`
    : '';
  console.info(`[build-global-hnsw] done in ${totalSec}s — hot=${meta.hot_size} full=${meta.full_size} dim=${meta.dim} corpus=${meta.built_from_count}${sourceSuffix}`);
  writeResult({
    ok: true,
    duration_ms: Date.now() - startTs,
    artifact_complete: artifactComplete(ANN_DIR),
    meta: {
      hot_size: meta.hot_size,
      full_size: meta.full_size,
      dim: meta.dim,
      built_from_count: meta.built_from_count,
      source_embedded_count: meta.source_embedded_count || meta.built_from_count,
    },
  });
  process.exit(0);
}

main().catch(err => {
  if (AUTO_DEFER_ON_FOREGROUND && err?.name === 'AbortError') {
    console.info(`[build-global-hnsw] deferred: ${err.message}`);
    restoreSnapshotIfArtifactsMissing('auto foreground defer');
    clearLock();
    writeResult({
      ok: false,
      deferred: true,
      reason: err.message,
      artifact_complete: artifactComplete(ANN_DIR),
    });
    process.exit(0);
  }
  console.error('[build-global-hnsw] fatal:', err.message);
  console.error(err.stack);
  restoreSnapshotIfArtifactsMissing('fatal error');
  writeResult({
    ok: false,
    reason: err?.message || String(err),
    artifact_complete: artifactComplete(ANN_DIR),
  });
  process.exit(1);
});
