#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/supervisor-maintenance-worker.mjs — st_2cd1af73 AC-1.
//
// Compute tier: orchestration. Coordinates the deterministic passive-job drain
// (maintenance routines via maintenance-phases.js grandchildren,
// email_history_backfill) and the PASSIVE WAL checkpoint + deep-health
// integrity scan. Makes NO LLM call against structured data.
//
// WHY a separate long-lived process and not the server's main thread (the bug
// this fixes): st_27561b77 ran drainPassiveJobs + passiveCheckpoint +
// checkDbHealth({deep:true}) INSIDE the server process's supervisorTick on the
// main thread, every ~15s. The drain's synchronous SQL plus the PASSIVE
// checkpoint's SQLCipher per-page AES decrypt over a 7GB DB starved the Node
// event loop for 12–17s at the tick cadence — during which EVERY request,
// including /api/server-health (zero DB work), hung. This worker is the same
// process-isolation the chunk-embed daemon already uses for embedding: own
// SQLCipher connection, activity-gated yield to chat, KeepAlive-equivalent
// restart owned by the server's supervisor. The server main thread now only
// enqueues routine work + reads this worker's status row; it never executes a
// job handler or a checkpoint again.
//
// WHY NOT a worker_thread: better-sqlite3-multiple-ciphers worker-thread safety
// is not established in this codebase (zero precedent), and a worker thread
// still shares the V8 process GC + uv thread pool. A separate process is the
// proven, zero-shared-memory isolation. WHY NOT a standalone launchd agent: the
// maintenance-phase grandchildren acquire the external-db-writer.lock
// themselves; a launchd peer draining the same types would contend that lock
// against com.robotdojo.sync. A child supervised by the server is
// lifecycle-coupled (single-drainer invariant, crash-restart) and uses a
// DEDICATED singleton lock that never touches the writer lock.
//
// Single-drainer invariant: this worker drains ONLY MAINTENANCE_JOB_TYPES
// (the routine set in lib/maintenance-routines.js + email_history_backfill).
// The launchd sync.js / chunk-embed-daemon own their own job types; no
// double-drain. A pidfile singleton guard ensures exactly one worker runs.
// ─────────────────────────────────────────────────────────────────────────────

export const INTELLIGENCE_TIER = 'orchestration';

// IDLE_GATED is read by check-idle-gated.js (pre-commit) + the registry check.
// false: like the embed daemon, this worker is ACTIVITY-gated (server request
// signal), not HID-idle-gated — it must yield to chat, not to keypresses.
export const IDLE_GATED = false;

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync, appendFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const HOME = process.env.HOME || homedir();
const ROOT = process.env.ROBOTDOJO_HOME || resolve(HOME, 'robotdojo');
const STATE_DIR = process.env.ROBOTDOJO_STATE_DIR || resolve(HOME, '.robotdojo');

// Absolute imports — ESM does not resolve relative reliably when launchd/the
// server spawns this from an arbitrary CWD.
const db = (await import(resolve(ROOT, 'lib/db.js'))).default;
const { openPassiveCheckpointConnection } = await import(resolve(ROOT, 'lib/db.js'));
const {
  drainPassiveJobs,
  enqueuePassiveJob,
  getPassiveJobSummary,
  passiveJobUniqueKey,
} = await import(resolve(ROOT, 'lib/passive-jobs.js'));
const { SESSION_LOG_JOB_TYPES } = await import(resolve(ROOT, 'lib/session-log-queue.js'));
const { checkDbHealth, flattenDbHealth } = await import(resolve(ROOT, 'lib/db-health.js'));
const { getIdleSeconds, idleGateDecision } = await import(resolve(ROOT, 'lib/idle-gate.js'));
const {
  getActivitySignal,
  activityPauseDecision,
  chatAppActiveDecision,
  ACTIVITY_PAUSE_MS,
  ACTIVITY_STALE_TTL_MS,
  CHAT_APP_ACTIVE_WINDOW_MS,
} = await import(resolve(ROOT, 'lib/request-observer.js'));
const { readEmbedPauseHold } = await import(resolve(ROOT, 'lib/embed-pause-hold.js'));
const {
  buildMaintenanceHandlers,
  MAINTENANCE_JOB_TYPES,
} = await import(resolve(ROOT, 'lib/passive-maintenance-handlers.js'));
const {
  LAUNCH_CRITICAL_ROUTINE_JOB_TYPES,
  ROUTINES,
} = await import(resolve(ROOT, 'lib/maintenance-routines.js'));
const {
  writeSupervisorCheckpoint,
  writeSupervisorDeepHealth,
  writeSupervisorHeartbeat,
  writeSupervisorSummaries,
  writeSupervisorApiHealth,
} = await import(resolve(ROOT, 'lib/supervisor-status.js'));
// st_db4b3118 — the value_rank recompute expression (single source of truth in
// lib/db.js) for the VALUE-RANK REFRESH tick: re-ranks chunks whose entity links
// appeared after insert, and old high-signal rows whose source tier predates the
// first-use fast lane, keeping the value-first drain honest over time.
const { VALUE_RANK_SQL_EXPR } = await import(resolve(ROOT, 'lib/db.js'));
// st_db4b3118 — the brief reader's path + freshness markers, reused by the BRIEF
// FRESHNESS tick so it never re-implements where the brief lives or what "current"
// means. BRIEF_PATH is the canonical file; the tick reads its header markers.
const { BRIEF_PATH } = await import(resolve(ROOT, 'lib/chat/brief.js'));
// st_2cd1af73 AC-1 (final layer): keep the global HNSW index fresh as the embed
// daemon backfills. The helper is lock-gated + spawns a detached rebuild; this
// worker only calls it on a throttled cadence (see annRefreshTick below).
const { maybeRefreshGlobalIndex } = await import(resolve(ROOT, 'lib/ann/usearch-adapter.js'));

const WORKER_NAME = 'supervisor-maintenance-worker';
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} [${WORKER_NAME}] ${m}`);
const WORKER_STARTED_AT = Date.now();

// ─── Tunables (env-overridable; defaults mirror st_27561b77's supervisor) ────
const DRAIN_TICK_MS = Number(process.env.ROBOTDOJO_MAINT_TICK_MS || 15_000);
// Max jobs per drain pass. Launch foreground wins over catch-up throughput:
// default to one job per genuinely-idle pass, and let operators raise this for
// overnight/backfill windows.
const DRAIN_LIMIT = Number(process.env.ROBOTDOJO_MAINT_DRAIN_LIMIT || 1);
const DEEP_HEALTH_MS = Number(process.env.ROBOTDOJO_DEEP_HEALTH_INTERVAL_MS || 30 * 60_000);
// st_2cd1af73 AC-1 — the deep-health integrity scan (quick_check +
// foreign_key_check) costs 6–7 MINUTES of synchronous PRAGMA on the 7GB
// SQLCipher DB and, run inline in the worker loop, STARVES the checkpoint +
// summary-publish cadence (the WAL balloons to 100MB+ and the worker stops
// heartbeating, triggering a respawn storm). It is also pre-existing and
// currently returns ok=false. So it is OPT-IN: default OFF. When a real
// integrity audit is wanted, set ROBOTDOJO_MAINT_DEEP_HEALTH=1 — but it should
// run from a dedicated short-lived process, not this hot maintenance loop.
const DEEP_HEALTH_ENABLED = process.env.ROBOTDOJO_MAINT_DEEP_HEALTH === '1';
// F5 safety valve: force a second PASSIVE pass when the WAL exceeds this many
// frames even outside an idle window (each frame ≈ 4KB; 10000 ≈ 40MB).
const FORCED_PASSIVE_FRAMES = Number(process.env.ROBOTDOJO_FORCED_PASSIVE_FRAMES || 10_000);
// st_2cd1af73 AC-1 (residual): a TRUNCATE checkpoint takes an EXCLUSIVE lock and
// — measured on the live 7.7GB SQLCipher DB with the embed daemon writing — runs
// for ~5s while it holds that lock. The plain activityPauseDecision window
// (ACTIVITY_PAUSE_MS≈1500ms) is far too narrow to protect a 5s hold: a chat turn
// arriving 1.6s after the previous one finished would see the server "quiet",
// the worker would start a TRUNCATE, and the turn's write (or any reader) would
// then block for the full ~5s. So TRUNCATE gets a DEDICATED, much wider quiet
// gate: it may run only when the server has been quiet for at least
// TRUNCATE_QUIET_MS, and at most once per TRUNCATE_MIN_INTERVAL_MS so a daemon
// that refills the WAL every tick cannot trigger a TRUNCATE storm. PASSIVE
// (which never blocks writers) still runs every tick to keep frames migrating
// into the DB; only the file-shrinking TRUNCATE is held back to genuine idle.
//
// st_2cd1af73 AC-1 (universal caching residual, 2026-06-11): the prior default
// was 12s. That is NARROWER than the real active-chat rhythm — a user (or a QA
// run) sends turns ~15–17s apart, and a 15s inter-turn gap SATISFIES a 12s quiet
// gate. So the gentle TRUNCATE could fire IN THE GAP between two turns of an
// active session, and its ~5s exclusive lock then landed on the next turn,
// inflating that turn's TTFT (the chaotic no-topic outliers this story chased).
// 12s "wider than any inter-turn gap" was simply wrong about the gap. Raised to
// 120s so the gentle path fires only in GENUINE idle (two minutes with no
// request — far beyond any active-session pause), never mid-conversation. The
// WAL is still bounded: the force-ceiling bypass (TRUNCATE_FORCE_FRAMES) below
// still TRUNCATEs regardless of the quiet gate when the WAL file is genuinely
// large, so "bound it, don't kill it" holds — only the collision-prone gentle
// path is pushed out to real idle. Env-overridable.
const TRUNCATE_QUIET_MS = Number(process.env.ROBOTDOJO_TRUNCATE_QUIET_MS || 120_000);
const TRUNCATE_MIN_INTERVAL_MS = Number(process.env.ROBOTDOJO_TRUNCATE_MIN_INTERVAL_MS || 5 * 60_000);
// Hard ceiling: if the WAL FILE grows past this many frames the TRUNCATE quiet
// gate is bypassed so the WAL can never grow truly unbounded (the brief's
// "bound it, don't kill it"). 250000 frames ≈ ~1GB at 4KB/frame — far above the
// steady-state the daemon produces, so this only fires if the box was never idle
// for a long stretch. Env-overridable.
const TRUNCATE_FORCE_FRAMES = Number(process.env.ROBOTDOJO_TRUNCATE_FORCE_FRAMES || 250_000);
// How long to sleep when paused for activity before re-polling. Short enough to
// resume within ~ACTIVITY_PAUSE_MS of the user going quiet.
const PAUSE_POLL_MS = Number(process.env.ROBOTDOJO_MAINT_PAUSE_POLL_MS) || 500;
const POST_DRAIN_HOLD_SLEEP_MS = Number(process.env.ROBOTDOJO_MAINT_POST_DRAIN_HOLD_SLEEP_MS || 60_000);

// FOREGROUND GATE — heavy maintenance must not run just because the generic
// 1.5s request-yield window elapsed. Login, install, topic edits, and chat turns
// can be spaced by many seconds while still being one foreground session. So
// drain/checkpoint/value-rank wait for a real launch-safe idle window: boot grace,
// no recent requests/app-open signal, and HID idle.
const FOREGROUND_BOOT_GRACE_MS = Number(process.env.ROBOTDOJO_MAINT_FOREGROUND_BOOT_GRACE_MS || 15 * 60_000);
const FOREGROUND_QUIET_MS = Number(process.env.ROBOTDOJO_MAINT_FOREGROUND_QUIET_MS || 15 * 60_000);
const FOREGROUND_HID_IDLE_SECONDS = Number(process.env.ROBOTDOJO_MAINT_FOREGROUND_HID_IDLE_SECONDS || 15 * 60);
const LAUNCH_CATCHUP_BOOT_GRACE_MS = Number(process.env.ROBOTDOJO_MAINT_LAUNCH_CATCHUP_BOOT_GRACE_MS || 15 * 60_000);
const LAUNCH_CATCHUP_MAX_DUE_MS = Number(process.env.ROBOTDOJO_MAINT_LAUNCH_CATCHUP_MAX_DUE_MS || 2 * 60_000);
const LAUNCH_CATCHUP_TICK_MS = Number(process.env.ROBOTDOJO_MAINT_LAUNCH_CATCHUP_TICK_MS || 30_000);
const LAUNCH_CATCHUP_LIMIT = Number(process.env.ROBOTDOJO_MAINT_LAUNCH_CATCHUP_LIMIT || 1);

// st_fd14cdd4 AC9 — how often, while a heavy phase grandchild runs, the handler
// re-checks the CHAT-APP-ACTIVE signal and SIGTERMs the child. The HID-idle gate
// already re-checks at CHILD_IDLE_RECHECK_MS (5s in lib/passive-maintenance-
// handlers.js); 5s is FAR too slow for the ≤1s writer-release the brief requires
// — a chat turn landing while a phase holds the writer would wait up to 5s for
// the SIGTERM. This dedicated fast recheck mirrors the embedder's ACTIVITY_WATCH_MS
// (250ms): the instant the chat app opens, the in-flight phase is SIGTERM'd and
// stops acquiring the writer, so the writer is free well within ~1s. Env-tunable.
const APP_ACTIVE_RECHECK_MS = Number(process.env.ROBOTDOJO_MAINT_APP_ACTIVE_RECHECK_MS) || 500;
const SUMMARY_PUBLISH_MS = Number(process.env.ROBOTDOJO_SUPERVISOR_SUMMARY_PUBLISH_MS || 60_000);
// st_2cd1af73 AC-1 (final layer): how often to re-check global-HNSW freshness.
// WHY 5 min (not every 15s tick): the check is a cheap COUNT, but spawning the
// rebuild is 10–30 min on a large corpus — re-checking every tick would just
// hit the .building lock repeatedly. 5 min keeps the index tracking the
// continuously-growing embedded corpus without churn. Env-overridable.
const ANN_REFRESH_MS = Number(process.env.ROBOTDOJO_ANN_REFRESH_MS || 5 * 60_000);

// ─── st_db4b3118 SELF-HEALING TICK tunables (env-overridable) ────────────────
// The Anthropic warmup ping log the API-HEALTH tick parses (the 4-min warmup
// LaunchAgent writes `[anthropic-warmup] ok t=<ms>ms warmed=1` here). Reading the
// tail is cheap; the worker republishes the derived signal every tick.
const WARMUP_LOG_PATH = process.env.ROBOTDOJO_WARMUP_LOG
  || resolve(STATE_DIR, 'logs', 'robotdojo-warmup.out.log');
// The cert-watch log the legacy session nohup watcher wrote. The API-HEALTH tick
// replaces that watcher: it kills the watcher pid (once) and appends the same
// go-line here on the healthy transition so the AM cert flow still sees its signal.
const CERT_WATCH_LOG_PATH = process.env.ROBOTDOJO_CERT_WATCH_LOG
  || resolve(STATE_DIR, 'logs', 'cert-watch.log');
// "healthy" = this many consecutive warmup pings under the latency ceiling.
const API_HEALTH_OK_STREAK = Number(process.env.ROBOTDOJO_API_HEALTH_OK_STREAK || 3);
const API_HEALTH_LATENCY_MS = Number(process.env.ROBOTDOJO_API_HEALTH_LATENCY_MS || 1500);
// How many tail lines of the warmup log to scan for the streak (a few × the streak).
const API_HEALTH_TAIL_LINES = Number(process.env.ROBOTDOJO_API_HEALTH_TAIL_LINES || 12);

// BRIEF FRESHNESS — throttle the freshness check so a not-current brief is only
// re-attempted on a sane cadence (the check itself is a tiny header read; the
// throttle bounds how often a FAILED synthesis is retried). 10 min between checks,
// 1h back-off after a spawn failure. Brief synthesis gets a 90s API timeout.
const BRIEF_CHECK_MS = Number(process.env.ROBOTDOJO_BRIEF_CHECK_MS || 10 * 60_000);
const BRIEF_FAIL_BACKOFF_MS = Number(process.env.ROBOTDOJO_BRIEF_FAIL_BACKOFF_MS || 60 * 60_000);
const BRIEF_ANTHROPIC_TIMEOUT_MS = Number(process.env.ROBOTDOJO_BRIEF_TIMEOUT_MS || 90_000);

// RECLASSIFY SLICES — run a bounded chunk-reclassify slice when chat is quiet and
// the last slice was long enough ago, so sorting continuously follows the drain
// instead of waiting for 21:00. The slice is hard-bounded to MAX_SECONDS; never
// runs concurrently with itself.
const RECLASSIFY_MIN_GAP_MS = Number(process.env.ROBOTDOJO_RECLASSIFY_TICK_GAP_MS || 60 * 60_000);
const RECLASSIFY_MAX_SECONDS = Number(process.env.ROBOTDOJO_RECLASSIFY_TICK_MAX_SECONDS || 30);
const RECLASSIFY_BOOT_GRACE_MS = Number(process.env.ROBOTDOJO_RECLASSIFY_BOOT_GRACE_MS || 30 * 60_000);
const RECLASSIFY_QUIET_MS = Number(process.env.ROBOTDOJO_RECLASSIFY_QUIET_MS || 15 * 60_000);
const RECLASSIFY_HID_IDLE_SECONDS = Number(process.env.ROBOTDOJO_RECLASSIFY_HID_IDLE_SECONDS || 30 * 60);

// VALUE-RANK REFRESH — recompute value_rank for chunks whose entity links appeared
// AFTER insert (so a chunk inserted at the recency tier gets promoted to the entity
// tier once linked). Hourly-class throttle; bounded per pass; runs in short
// transactions so it never holds the writer.
const VALUE_RANK_REFRESH_MS = Number(process.env.ROBOTDOJO_VALUE_RANK_REFRESH_MS || 60 * 60_000);
const VALUE_RANK_REFRESH_LIMIT = Number(process.env.ROBOTDOJO_VALUE_RANK_REFRESH_LIMIT || 5000);

// A short busy_timeout on THIS connection (server keeps 30000): the worker is a
// separate process and should YIELD to chat, not block. A contended write
// surfaces as SQLITE_BUSY quickly; the loop backs off and re-checks activity.
db.pragma('busy_timeout = 2000');

// ─── Singleton guard (dedicated lock, NOT the external-db-writer.lock) ───────
// WHY a dedicated lock: the phase grandchildren this worker spawns acquire the
// external-db-writer.lock themselves via withLaunchDbWriterGuard. Holding that
// lock here would deadlock every maintenance phase. This lock only ensures one
// maintenance worker runs at a time. Same wx+PID-liveness primitive as
// lib/db-writer-policy.js.
const SINGLETON_LOCK = process.env.ROBOTDOJO_MAINT_LOCK
  || resolve(STATE_DIR, 'supervisor-maintenance.lock');

function processAlive(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function acquireSingleton() {
  mkdirSync(STATE_DIR, { recursive: true });
  try {
    const fd = openSync(SINGLETON_LOCK, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    closeSync(fd);
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') { log(`singleton lock error: ${err.message}`); return false; }
    // Stale-lock recovery: if the holder is dead, steal the lock.
    let existing = null;
    try { existing = JSON.parse(readFileSync(SINGLETON_LOCK, 'utf8')); } catch { /* corrupt */ }
    if (existing && !processAlive(existing.pid)) {
      try { unlinkSync(SINGLETON_LOCK); } catch { /* lost a race */ }
      return acquireSingleton();
    }
    log(`another maintenance worker is alive (pid=${existing?.pid}); exiting 0`);
    return false;
  }
}

function releaseSingleton() {
  try {
    const existing = JSON.parse(readFileSync(SINGLETON_LOCK, 'utf8'));
    if (existing?.pid === process.pid) unlinkSync(SINGLETON_LOCK);
  } catch { /* already gone */ }
}

// st_2cd1af73 AC-1 — the lock is acquired ONCE at start but ownership must be
// re-verified every loop iteration. WHY: a `kickstart -k` SIGKILLs the old
// server but its child worker can be reparented to launchd (PPID=1) and keep
// running — a second drainer. If a fresh worker later steals the lock (during a
// brief stale window), the orphan would otherwise keep draining without the
// lock, violating the single-drainer invariant. Re-checking ownership each tick
// makes the orphan exit the moment it no longer owns the lock. Returns false if
// the lock is gone or owned by another pid.
function ownsSingleton() {
  try {
    const existing = JSON.parse(readFileSync(SINGLETON_LOCK, 'utf8'));
    return existing?.pid === process.pid;
  } catch {
    return false; // lock vanished — we no longer own it
  }
}

// ─── Lifecycle / crash-safety ────────────────────────────────────────────────
const ac = new AbortController();
let shuttingDown = false;
function onSignal(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig} received — aborting drain and closing DB`);
  try { ac.abort(); } catch { /* already aborted */ }
  releaseSingleton();
  try { db.close(); } catch { /* may already be closed */ }
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGHUP', () => onSignal('SIGHUP'));
process.on('uncaughtException', (err) => {
  log(`FATAL uncaughtException: ${err?.stack || err?.message || err}`);
  releaseSingleton();
  try { db.close(); } catch { /* ignore */ }
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log(`FATAL unhandledRejection: ${reason?.stack || reason?.message || reason}`);
  releaseSingleton();
  try { db.close(); } catch { /* ignore */ }
  process.exit(1);
});
process.on('exit', () => { releaseSingleton(); });

// ─── Checkpoint (the heavy SQLCipher term, now off the server's main thread) ──
// Holds a dedicated checkpoint connection open for the worker's life (re-opening
// costs 50–100ms of SQLCipher key derive). Writes the {busy,log,checkpointed}
// result to the supervisor_status row so the server's /api/server-health reads
// WAL state without ever running a foreground PRAGMA wal_checkpoint.
let checkpointConn = null;
function passiveCheckpoint() {
  if (!checkpointConn) {
    try { checkpointConn = openPassiveCheckpointConnection(); }
    catch (err) { log(`checkpoint open failed: ${err.message}`); return null; }
  }
  if (!checkpointConn) return null;
  try {
    const row = checkpointConn.pragma('wal_checkpoint(PASSIVE)');
    const r = Array.isArray(row) ? row[0] : row;
    const busy = Number(r?.busy ?? 0);
    const logFrames = Number(r?.log ?? 0);
    const checkpointed = Number(r?.checkpointed ?? 0);
    // Pinned log marker — AC3/AC4 criteria grep this exact prefix with grep -F.
    console.info(`wal_checkpoint(PASSIVE) result=${busy} ${logFrames} ${checkpointed}`);
    writeSupervisorCheckpoint(db, { busy, log: logFrames, checkpointed });
    return { busy, log: logFrames, checkpointed };
  } catch (err) {
    log(`wal_checkpoint(PASSIVE) failed: ${err.message}`);
    try { checkpointConn?.close(); } catch { /* ignore */ }
    checkpointConn = null;
    return null;
  }
}

// TRUNCATE checkpoint — reclaims the -wal FILE to zero (PASSIVE only moves
// frames into the DB without shrinking the file). Runs on the same dedicated
// connection. Only called from the quiet window when the WAL is large.
function truncateCheckpoint() {
  if (!checkpointConn) return null;
  try {
    const row = checkpointConn.pragma('wal_checkpoint(TRUNCATE)');
    const r = Array.isArray(row) ? row[0] : row;
    const busy = Number(r?.busy ?? 0);
    const logFrames = Number(r?.log ?? 0);
    const checkpointed = Number(r?.checkpointed ?? 0);
    console.info(`wal_checkpoint(TRUNCATE) result=${busy} ${logFrames} ${checkpointed}`);
    writeSupervisorCheckpoint(db, { busy, log: logFrames, checkpointed });
    return { busy, log: logFrames, checkpointed };
  } catch (err) {
    log(`wal_checkpoint(TRUNCATE) failed: ${err.message}`);
    return null;
  }
}

// ─── Deep health (the OTHER heavy main-thread term — quick_check + FK check) ──
// Runs the 30-269s integrity PRAGMAs on the worker's connection, writes the
// flattened result to supervisor_status. The server's /api/server-health?deep=1
// reads that row instead of running the scan inline.
// ─── Global-HNSW freshness (st_2cd1af73 AC-1 final layer) ────────────────────
// Throttled to ANN_REFRESH_MS. maybeRefreshGlobalIndex is lock-gated and only
// spawns a detached rebuild when the index is missing or has drifted past the
// drift threshold vs the live embedded corpus — so chat's HNSW fast path tracks
// the growing corpus instead of freezing at its boot-time slice. Never blocks:
// the rebuild is a child process; this call is one COUNT + a lock stat.
let lastAnnRefreshAt = 0;
function annRefreshTick() {
  if (Date.now() - lastAnnRefreshAt < ANN_REFRESH_MS - 1000) return;
  lastAnnRefreshAt = Date.now();
  if (!foregroundMaintenanceAllowed('ann-refresh')) return;
  try {
    const r = maybeRefreshGlobalIndex(db);
    if (r.spawned) log(`ann index rebuild spawned — ${r.reason}`);
  } catch (err) {
    log(`ann refresh failed: ${err.message}`);
  }
}

// ─── st_db4b3118 (2a) API-HEALTH SIGNAL ──────────────────────────────────────
//
// Parse the tail of the Anthropic warmup ping log and derive a single boolean +
// latency. PURE so it is unit-testable from a fixture string: the daemon's
// activity gates taught us to keep the decision separate from the IO. A line is
// `[anthropic-warmup] ok t=<ms>ms warmed=1`; healthy = the last
// API_HEALTH_OK_STREAK pings (in order) are all `ok` AND under the latency ceiling.
// A non-ok line (or a gap) breaks the streak. last_ok_latency_ms is the most
// recent ok ping's latency regardless of the streak.
//
// @param {string} logTail the last N lines of the warmup log
// @param {object} [opts]
// @returns {{healthy:boolean, lastOkLatencyMs:number, streak:number}}
export function deriveApiHealth(logTail, { streakNeeded = API_HEALTH_OK_STREAK, latencyCeilingMs = API_HEALTH_LATENCY_MS } = {}) {
  const lines = String(logTail || '').split('\n').map((l) => l.trim()).filter(Boolean);
  // Parse every warmup line in order → { ok, ms }. A line that does not match is
  // ignored (other log noise), not treated as a failure.
  const pings = [];
  for (const line of lines) {
    const m = line.match(/\[anthropic-warmup\]\s+ok\s+t=(\d+)ms/);
    if (m) { pings.push({ ok: true, ms: Number(m[1]) }); continue; }
    // An explicit non-ok warmup line (error/timeout) breaks a streak.
    if (/\[anthropic-warmup\]/.test(line) && !/\bok\b/.test(line)) pings.push({ ok: false, ms: 0 });
  }
  let lastOkLatencyMs = 0;
  for (let i = pings.length - 1; i >= 0; i--) {
    if (pings[i].ok) { lastOkLatencyMs = pings[i].ms; break; }
  }
  // Count the trailing streak of ok-and-fast pings.
  let streak = 0;
  for (let i = pings.length - 1; i >= 0; i--) {
    if (pings[i].ok && pings[i].ms < latencyCeilingMs) streak++;
    else break;
  }
  return { healthy: streak >= streakNeeded, lastOkLatencyMs, streak };
}

// Read the last N lines of a file cheaply (read the whole file — the warmup log is
// rotated/small; if it ever grows, the tail slice still bounds what we parse).
function readTailLines(path, n) {
  try {
    const all = readFileSync(path, 'utf8').split('\n');
    return all.slice(Math.max(0, all.length - n)).join('\n');
  } catch {
    return '';
  }
}

// Read the FIRST N lines of a file (the brief's header markers live at the top).
function readHeadLines(path, n) {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(0, n).join('\n');
  } catch {
    return '';
  }
}

// One-shot: kill the legacy session nohup cert-watcher (its pid file or a pgrep),
// since the tick now publishes the api_healthy signal it produced. Idempotent and
// guarded — a missing watcher is the normal post-replacement state.
let certWatcherKilled = false;
function killLegacyCertWatcher() {
  if (certWatcherKilled) return;
  certWatcherKilled = true; // attempt once; a failure is logged but never retried-storms
  try {
    // The watcher is a `cert-watch` shell/node loop writing CERT_WATCH_LOG_PATH.
    // pgrep its command line; SIGTERM any match that is not this process.
    const r = spawnSync('pgrep', ['-f', 'cert-watch'], { encoding: 'utf8' });
    const pids = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
      .map(Number).filter((p) => Number.isInteger(p) && p !== process.pid);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); log(`killed legacy cert-watcher pid=${pid} (tick replaces it)`); }
      catch { /* already gone / not ours */ }
    }
  } catch { /* pgrep missing — nothing to kill */ }
}

let apiHealthyLast = false;
function apiHealthTick() {
  // Replace the legacy watcher on the first tick.
  killLegacyCertWatcher();
  const tail = readTailLines(WARMUP_LOG_PATH, API_HEALTH_TAIL_LINES);
  const { healthy, lastOkLatencyMs, streak } = deriveApiHealth(tail);
  writeSupervisorApiHealth(db, { healthy, lastOkLatencyMs });
  // On the unhealthy→healthy transition, append the go-line to cert-watch.log so
  // the AM cert flow that still tails that file sees its signal (the watcher used
  // to write it; the tick now does). Logged so the transition is visible.
  if (healthy && !apiHealthyLast) {
    try {
      mkdirSync(resolve(CERT_WATCH_LOG_PATH, '..'), { recursive: true });
      appendFileSync(CERT_WATCH_LOG_PATH, `${new Date().toISOString()} GO api_healthy streak=${streak} last_ok=${lastOkLatencyMs}ms\n`);
    } catch (err) { log(`cert-watch go-line append failed: ${err.message}`); }
    log(`api-health → HEALTHY (streak=${streak}, last_ok=${lastOkLatencyMs}ms) — published + cert-watch go-line`);
  } else if (!healthy && apiHealthyLast) {
    log(`api-health → degraded (streak=${streak}, last_ok=${lastOkLatencyMs}ms)`);
  }
  apiHealthyLast = healthy;
}

// ─── st_db4b3118 (2b) BRIEF FRESHNESS ────────────────────────────────────────
//
// PURE decision: does the brief need a (re)synthesis? True when the file is absent,
// its synthesized_at is not today, OR it carries only the deterministic-fallback
// marker (so a prose edition is still owed). Separated from the IO + spawn so it is
// unit-testable from a header string.
//
// @param {string|null} header the brief file's leading bytes (or null if absent)
// @param {object} [opts]
// @param {string} [opts.todayYmd] YYYY-MM-DD (test hook)
// @returns {{stale:boolean, reason:string}}
export function briefNeedsSynthesis(header, { todayYmd = new Date().toISOString().slice(0, 10) } = {}) {
  if (header == null) return { stale: true, reason: 'absent' };
  const h = String(header);
  // synthesize-brief.js writes `<!-- synthesized_at: <ISO> -->`.
  const m = h.match(/synthesized_at:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  const day = m ? m[1] : null;
  if (day !== todayYmd) return { stale: true, reason: day ? `dated ${day}` : 'no synthesized_at' };
  // A brief carrying only the deterministic fallback still owes a prose edition.
  if (/brief_mode:\s*deterministic-fallback/.test(h)) return { stale: true, reason: 'deterministic-fallback marker' };
  return { stale: false, reason: 'current' };
}

// Canonical non-blocking detached spawn of a node script (build-conventions.md):
// process.execPath, absolute path, detached + stdio ignore + unref. Extra env is
// merged. Returns the child or null on spawn failure.
function spawnDetachedNode(scriptPath, args = [], extraEnv = {}) {
  try {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...extraEnv },
    });
    child.unref();
    return child;
  } catch (err) {
    log(`detached spawn failed (${scriptPath}): ${err.message}`);
    return null;
  }
}

let lastBriefCheckAt = 0;
let briefSpawnInFlight = false;
function briefFreshnessTick() {
  if (Date.now() - lastBriefCheckAt < BRIEF_CHECK_MS - 1000) return;
  lastBriefCheckAt = Date.now();
  if (briefSpawnInFlight) return; // never two brief syntheses at once
  // Gate: only spawn when the API is healthy (a synthesis on a degraded API just
  // burns the 90s timeout and writes a fallback) AND the server is quiet-ish (the
  // synthesis is a Sonnet call + DB read; don't compete with a live chat turn).
  const health = deriveApiHealth(readTailLines(WARMUP_LOG_PATH, API_HEALTH_TAIL_LINES));
  if (!health.healthy) return;
  // st_fd14cdd4 AC9 — fold chat-app-open into the quiet gate so a Sonnet synthesis
  // never starts while the app is open, not just while a request is mid-flight.
  if (maintenanceShouldPause().pause) return;
  // Cheap freshness read — the markers are at the top of the file.
  const header = existsSync(BRIEF_PATH) ? readHeadLines(BRIEF_PATH, 6) : null;
  const need = briefNeedsSynthesis(header);
  if (!need.stale) return; // today's prose edition already landed — stop attempting
  const child = spawnDetachedNode(
    resolve(ROOT, 'scripts', 'synthesize-brief.js'), [],
    { ANTHROPIC_TIMEOUT_MS: String(BRIEF_ANTHROPIC_TIMEOUT_MS) },
  );
  if (!child) {
    // Spawn failure → back off 1h before the next attempt.
    lastBriefCheckAt = Date.now() + (BRIEF_FAIL_BACKOFF_MS - BRIEF_CHECK_MS);
    return;
  }
  briefSpawnInFlight = true;
  log(`brief freshness: ${need.reason} + API healthy + quiet — spawned synthesize-brief (timeout ${BRIEF_ANTHROPIC_TIMEOUT_MS}ms)`);
  child.on('exit', (code) => {
    briefSpawnInFlight = false;
    if (code !== 0) {
      // Failed synthesis → back off 1h before retrying so a persistently-degraded
      // API does not respawn it every check.
      lastBriefCheckAt = Date.now() + (BRIEF_FAIL_BACKOFF_MS - BRIEF_CHECK_MS);
      log(`brief synthesis exited ${code} — backing off ${(BRIEF_FAIL_BACKOFF_MS / 60000).toFixed(0)}m`);
    } else {
      log('brief synthesis completed');
    }
  });
}

// ─── st_db4b3118 (2c) RECLASSIFY SLICES ──────────────────────────────────────
//
// Move the bounded chunk-reclassify from nightly-only to tick-based: when chat is
// quiet and the last slice was >RECLASSIFY_MIN_GAP_MS ago, run one bounded slice
// of 05-reclassify-chunks.js --no-regen --max-seconds N so sorting follows the
// drain continuously instead of waiting for 21:00. Never concurrent with itself;
// the nightly phase remains as a backstop.
let lastReclassifyAt = 0;
let lastReclassifyHoldLogAt = 0;
let reclassifyInFlight = false;
function reclassifySliceTick() {
  if (reclassifyInFlight) return; // single-flight
  if (Date.now() - WORKER_STARTED_AT < RECLASSIFY_BOOT_GRACE_MS) return;
  if (Date.now() - lastReclassifyAt < RECLASSIFY_MIN_GAP_MS) return;
  const hold = readEmbedPauseHold({ maxCacheMs: 0 });
  if (hold?.active) {
    if (Date.now() - lastReclassifyHoldLogAt > 5 * 60_000) {
      lastReclassifyHoldLogAt = Date.now();
      log(`reclassify slice deferred — ${hold.reason} owns the data-plane writer`);
    }
    return;
  }
  // Chat + HID-idle gate — never compete a heavy cosine pass with launch use.
  // st_fd14cdd4 AC9 — maintenanceShouldPause folds in the chat-app-open signal the
  // embedder yields to, so the slice is deferred the instant the app loads, not only
  // when a turn is mid-flight.
  const reclassifyGate = maintenancePauseDecision(getActivitySignal(db), { pauseMs: RECLASSIFY_QUIET_MS });
  if (reclassifyGate.pause) return;
  const hidIdle = getIdleSeconds();
  if (hidIdle < RECLASSIFY_HID_IDLE_SECONDS) return;
  lastReclassifyAt = Date.now();
  reclassifyInFlight = true;
  const child = spawnDetachedNode(
    resolve(ROOT, 'scripts', 'ingest', '05-reclassify-chunks.js'),
    ['--no-regen', '--max-seconds', String(RECLASSIFY_MAX_SECONDS)],
  );
  if (!child) { reclassifyInFlight = false; return; }
  log(`reclassify slice: server-quiet>${(RECLASSIFY_QUIET_MS / 60000).toFixed(0)}m + hid-idle>${Math.round(RECLASSIFY_HID_IDLE_SECONDS / 60)}m + boot>${(RECLASSIFY_BOOT_GRACE_MS / 60000).toFixed(0)}m + last slice >${(RECLASSIFY_MIN_GAP_MS / 60000).toFixed(0)}m — spawned (--no-regen --max-seconds ${RECLASSIFY_MAX_SECONDS})`);
  child.on('exit', (code) => {
    reclassifyInFlight = false;
    if (code !== 0) log(`reclassify slice exited ${code}`);
    else log('reclassify slice completed');
  });
}

// ─── st_db4b3118 (2d) VALUE-RANK REFRESH ─────────────────────────────────────
//
// Recompute value_rank for rows still sitting at the 0 sentinel, chunks whose
// entity links appeared AFTER insert, and old high-signal chunks whose rank
// predates the source-signal term. The insert path ranks a new chunk WITHOUT its
// entity term (links don't exist yet), so a later-linked person/company row is
// stuck below the entity tier until re-ranked. Separately, legacy/fresh rows from
// older insert paths may still have value_rank=0; they must not wait for a boot
// backfill before the embed daemon can prove value-first ordering. Bounded per
// pass; ONE short set-based UPDATE (not a per-row loop — that held the single WAL
// writer in a long burst and starved the embed daemon); hourly-class throttle.
//
// VALUE_RANK_ENTITY_FLOOR MUST equal lib/db.js VALUE_RANK_ENTITY_TERM (1e12). If it
// drifts above the real composite ceiling (~1.06e12), the delta below matches EVERY
// linked chunk — including those already in the entity tier — and the tick churns
// the whole linked corpus every pass, contending the daemon's writer for nothing.
const VALUE_RANK_ENTITY_FLOOR = 1_000_000_000_000; // == lib/db.js VALUE_RANK_ENTITY_TERM
const VALUE_RANK_SOURCE_SIGNAL_MULT = 100_000_000_000; // == lib/db.js source-signal tier
let lastValueRankRefreshAt = Date.now();
function valueRankRefreshTick() {
  if (Date.now() - lastValueRankRefreshAt < VALUE_RANK_REFRESH_MS - 1000) return;
  lastValueRankRefreshAt = Date.now();
  // Don't grab the writer during a foreground session. This is intentionally
  // wider than the generic request-yield gate: value-rank can lag safely, login
  // and chat cannot.
  if (!foregroundMaintenanceAllowed('value-rank')) return;
  try {
    // Delta + re-rank in ONE bounded set-based UPDATE: re-rank up to LIMIT chunks
    // that are entity-linked but still ranked BELOW the entity floor (ranked before
    // their links landed), or high-signal rows whose current rank no longer equals
    // the canonical formula. A single short transaction over a small id set — the
    // writer-hold is one bounded UPDATE, not 5000 separate writes. A SQLITE_BUSY
    // just means the daemon held the writer; the same delta is retried next pass.
    const res = db.prepare(`
      UPDATE chunks SET value_rank = ${VALUE_RANK_SQL_EXPR}
      WHERE id IN (
        SELECT c.id FROM chunks c
        WHERE
          c.value_rank = 0
          OR (
            c.value_rank > 0
            AND (
            (
              c.value_rank < ${VALUE_RANK_ENTITY_FLOOR}
              AND EXISTS (SELECT 1 FROM chunk_entities ce WHERE ce.chunk_id = c.id)
            )
            OR (
              COALESCE(c.content_rank, 3) < 3
              AND c.value_rank < ((3 - MIN(3, MAX(0, COALESCE(c.content_rank, 3)))) * ${VALUE_RANK_SOURCE_SIGNAL_MULT})
            )
          )
        )
        LIMIT ${VALUE_RANK_REFRESH_LIMIT}
      )
    `).run();
    if (res.changes > 0) log(`value-rank refresh: re-ranked ${res.changes} first-use/entity chunk(s)`);
  } catch (err) {
    if (/SQLITE_BUSY|database is locked/i.test(err?.message || '')) {
      // The daemon held the writer — yield; the same delta retries next throttle.
      // Don't log-spam; this is the expected yield under a live drain.
      return;
    }
    log(`value-rank refresh failed: ${err.message}`);
  }
}

let lastDeepHealthAt = 0;
function deepHealthTick() {
  if (!DEEP_HEALTH_ENABLED) return; // opt-in only — see DEEP_HEALTH_ENABLED note
  if (Date.now() - lastDeepHealthAt < DEEP_HEALTH_MS - 1000) return;
  const idle = idleGateDecision(WORKER_NAME);
  if (!idle.ok) return; // burn 30+s of CPU only when the user is idle
  const t0 = Date.now();
  try {
    const value = flattenDbHealth(checkDbHealth(db, { deep: true }));
    const durationMs = Date.now() - t0;
    lastDeepHealthAt = Date.now();
    writeSupervisorDeepHealth(db, { value, durationMs });
    log(`deep-health complete: ok=${value.ok} duration_ms=${durationMs}`);
  } catch (err) {
    log(`deep-health failed: ${err.message}`);
  }
}

// ─── Activity gate — yield the WAL writer to chat ────────────────────────────
//
// st_fd14cdd4 AC9 — the maintenance worker's pause decision now mirrors the
// embedder's embedPauseDecision: it yields on the SAME two signals the embedder
// reads, not just the narrow recent-request window it used before. Independent
// reasons to pause, fail-safe on a stale/dead-server row (which is never "active",
// so a stopped server can never pin maintenance off forever — the AC-3 wedge
// defense the embedder shares):
//
//   - chat APP is OPEN (chatAppActiveDecision, 75s window) → pause: a human has
//     chat open RIGHT NOW (it pinged /api/chat/active on load / focus / heartbeat).
//     This is the broad, EARLY signal — it fires on app LOAD, before any turn is
//     submitted, so the worker stops starting heavy phase work and the in-flight
//     phase is SIGTERM'd (see the handler's appActiveCheck) BEFORE the user
//     finishes typing. Checked FIRST so the log names the app signal.
//   - in-flight request OR last request < ACTIVITY_PAUSE_MS ago (the generic
//     activityPauseDecision) → pause: the existing instant WAL yield to any live
//     query, unchanged.
//
// WHY the maintenance worker yields to ALL traffic recency (activityPauseDecision)
// and not chat-only like the embedder: the embedder's recency window is chat-scoped
// so constant background /api/* polling doesn't pin its overnight bulk paused (the
// AC-3 fix). The maintenance worker has no such bulk-throughput pressure — its drain
// is small and idempotent — so it keeps the broader "any request just landed" yield
// it already had, and ADDS the chat-app-open signal on top so it also yields the
// instant the app loads. Pure so it is unit-testable in isolation.
//
// @param {{inFlight:number, lastRequestAt:number, lastChatAppActiveAt:number, updatedAt:number}} signal
// @param {object} [opts]
// @returns {{pause:boolean, reason:string}}
export function maintenancePauseDecision(signal, {
  now = Date.now(),
  pauseMs = ACTIVITY_PAUSE_MS,
  staleTtlMs = ACTIVITY_STALE_TTL_MS,
  appWindowMs = CHAT_APP_ACTIVE_WINDOW_MS,
} = {}) {
  // Chat app open → yield the writer the instant it loaded (broad, early signal).
  if (chatAppActiveDecision(signal, { now, windowMs: appWindowMs, staleTtlMs })) {
    return { pause: true, reason: 'chat-app-open' };
  }
  // Fall back to the generic recent-request / in-flight gate (unchanged behavior).
  return activityPauseDecision(signal, { now, pauseMs, staleTtlMs });
}

/** Live wrapper: reads the current server-activity signal + the folded gate. */
function maintenanceShouldPause() {
  return maintenancePauseDecision(getActivitySignal(db));
}

/**
 * Pure foreground-idle decision for heavy work. The normal maintenance pause
 * gate is a writer-yield primitive; this is the launch/product gate.
 */
export function foregroundMaintenanceDecision(signal, {
  now = Date.now(),
  startedAt = WORKER_STARTED_AT,
  bootGraceMs = FOREGROUND_BOOT_GRACE_MS,
  quietMs = FOREGROUND_QUIET_MS,
  hidIdleSeconds = 0,
  hidIdleThresholdSeconds = FOREGROUND_HID_IDLE_SECONDS,
  staleTtlMs = ACTIVITY_STALE_TTL_MS,
  appWindowMs = CHAT_APP_ACTIVE_WINDOW_MS,
} = {}) {
  if (now - startedAt < bootGraceMs) return { ok: false, reason: 'boot-grace' };
  const requestGate = maintenancePauseDecision(signal, {
    now,
    pauseMs: quietMs,
    staleTtlMs,
    appWindowMs,
  });
  if (requestGate.pause) return { ok: false, reason: requestGate.reason };
  if ((Number(hidIdleSeconds) || 0) < hidIdleThresholdSeconds) {
    return { ok: false, reason: 'user-active' };
  }
  return { ok: true, reason: 'foreground-idle' };
}

/**
 * Launch-critical routine catch-up uses the same foreground-idle gate as bulk
 * maintenance. These routines are useful freshness work, but they are not more
 * important than first-use chat on a just-opened app.
 */
export function launchCriticalCatchupDecision(signal, opts = {}) {
  const decision = foregroundMaintenanceDecision(signal, opts);
  if (!decision.ok) return decision;
  return { ok: true, reason: 'launch-critical-catchup-idle' };
}

let lastForegroundPauseLogAt = 0;
function foregroundMaintenanceAllowed(label) {
  const decision = foregroundMaintenanceDecision(getActivitySignal(db), {
    hidIdleSeconds: getIdleSeconds(),
  });
  if (!decision.ok) {
    const now = Date.now();
    if (now - lastForegroundPauseLogAt > 60_000) {
      lastForegroundPauseLogAt = now;
      log(`foreground-pause — ${decision.reason} (${label})`);
    }
    return false;
  }
  return true;
}

function launchCriticalCatchupDecisionLive() {
  return launchCriticalCatchupDecision(getActivitySignal(db), {
    bootGraceMs: LAUNCH_CATCHUP_BOOT_GRACE_MS,
    quietMs: FOREGROUND_QUIET_MS,
    hidIdleSeconds: getIdleSeconds(),
    hidIdleThresholdSeconds: FOREGROUND_HID_IDLE_SECONDS,
  });
}

let lastPostDrainHoldLogAt = 0;
function activePostDrainHold() {
  try {
    const hold = readEmbedPauseHold({ maxCacheMs: 0 });
    return hold?.active && hold.reason === 'post_drain_pipeline_sole_writer' ? hold : null;
  } catch {
    return null;
  }
}

function launchCriticalRoutineKeys() {
  return ROUTINES
    .filter((routine) => LAUNCH_CRITICAL_ROUTINE_JOB_TYPES.includes(routine.jobType))
    .map((routine) => passiveJobUniqueKey({
      jobType: routine.jobType,
      targetType: 'system',
      targetId: routine.targetId || 'maintenance',
    }));
}

function launchCriticalOverdueJobs(now = Date.now()) {
  if (!LAUNCH_CRITICAL_ROUTINE_JOB_TYPES.length) return { jobTypes: [], uniqueKeys: [] };
  const uniqueKeys = launchCriticalRoutineKeys();
  if (!uniqueKeys.length) return { jobTypes: [], uniqueKeys: [] };
  const cutoffIso = new Date(now - LAUNCH_CATCHUP_MAX_DUE_MS).toISOString();
  const placeholders = uniqueKeys.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT job_type, unique_key
      FROM passive_jobs
     WHERE queue = 'default'
       AND status IN ('queued', 'paused')
       AND run_after <= ?
       AND unique_key IN (${placeholders})
     ORDER BY priority DESC, run_after ASC, created_at ASC
  `).all(cutoffIso, ...uniqueKeys);
  return {
    jobTypes: [...new Set(rows.map((row) => row.job_type))],
    uniqueKeys: rows.map((row) => row.unique_key),
  };
}

let lastLaunchCriticalCatchupAt = 0;
async function launchCriticalCatchupTick() {
  const now = Date.now();
  if (now - WORKER_STARTED_AT < LAUNCH_CATCHUP_BOOT_GRACE_MS) return;
  if (now - lastLaunchCriticalCatchupAt < LAUNCH_CATCHUP_TICK_MS) return;

  const overdue = launchCriticalOverdueJobs(now);
  if (!overdue.uniqueKeys?.length) return;

  const decision = launchCriticalCatchupDecisionLive();
  if (!decision.ok) {
    if (now - lastForegroundPauseLogAt > 60_000) {
      lastForegroundPauseLogAt = now;
      log(`foreground-pause — ${decision.reason} (launch-critical-catchup)`);
    }
    return;
  }

  lastLaunchCriticalCatchupAt = now;
  const handlers = buildMaintenanceHandlers({
    database: db,
    enqueuePassiveJob,
    idleDecision: launchCriticalCatchupDecisionLive,
    appActiveCheck: () => chatAppActiveDecision(getActivitySignal(db)),
    signal: ac.signal,
  });
  try {
    const results = await drainPassiveJobs({
      database: db,
      worker: `${WORKER_NAME}:launch-critical-catchup`,
      queue: 'default',
      jobTypes: overdue.jobTypes,
      uniqueKeys: overdue.uniqueKeys,
      handlers,
      limit: Math.max(LAUNCH_CATCHUP_LIMIT, overdue.uniqueKeys.length),
      idleCheck: launchCriticalCatchupDecisionLive,
    });
    const processed = results?.processed ?? 0;
    if (processed > 0) {
      log(`launch-critical catch-up drained ${processed} job(s): ${overdue.jobTypes.join(',')}`);
    } else if (results?.length) {
      const reason = results.find((r) => r?.reason)?.reason || 'no job acquired';
      log(`launch-critical catch-up deferred — ${reason}`);
    }
  } catch (err) {
    log(`launch-critical catch-up failed: ${err.message}`);
  }
}

async function waitForQuiet() {
  let logged = false;
  while (!ac.signal.aborted) {
    const decision = maintenanceShouldPause();
    if (!decision.pause) {
      if (logged) log('resume — server quiet, maintenance continues');
      return true;
    }
    if (!logged) { log(`activity-pause — ${decision.reason} (yielding WAL writer to chat)`); logged = true; }
    await new Promise((r) => setTimeout(r, PAUSE_POLL_MS));
  }
  return false;
}

const idleDecision = () => idleGateDecision(WORKER_NAME);

function sleepInterruptibly(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    ac.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  });
}

// st_2cd1af73 AC-1 (residual) — dedicated wide-quiet gate for the EXCLUSIVE-lock
// TRUNCATE checkpoint. Pure decision so it is unit-testable in isolation (the
// activityPauseDecision pattern). Returns true only when BOTH hold:
//   - the server has been quiet for at least quietMs (no in-flight request and
//     the last request finished that long ago), so a ~5s exclusive hold cannot
//     collide with an active turn, AND
//   - at least minIntervalMs has elapsed since the last TRUNCATE, so a daemon
//     refilling the WAL every tick cannot drive a TRUNCATE storm.
// `force` (caller passes it when the WAL FILE is past the hard ceiling) bypasses
// BOTH so the WAL file is still bounded if the box never goes idle for long.
//
// @param {{inFlight:number, lastRequestAt:number}} signal server-activity signal
// @param {object} opts
// @param {boolean} [opts.force] bypass both gates (hard WAL ceiling)
// @param {number}  opts.lastTruncateAt epoch ms of the previous TRUNCATE (0=never)
// @param {number}  [opts.now]
// @param {number}  [opts.quietMs]
// @param {number}  [opts.minIntervalMs]
// @returns {boolean}
export function truncateAllowedDecision(signal, {
  force = false,
  lastTruncateAt = 0,
  now = Date.now(),
  quietMs = TRUNCATE_QUIET_MS,
  minIntervalMs = TRUNCATE_MIN_INTERVAL_MS,
} = {}) {
  if (force) return true;
  if (now - lastTruncateAt < minIntervalMs) return false;
  // In-flight request → never.
  if ((Number(signal?.inFlight) || 0) > 0) return false;
  const last = Number(signal?.lastRequestAt) || 0;
  // No request ever seen this session → safe to TRUNCATE (truly idle box).
  if (last === 0) return true;
  return (now - last) >= quietMs;
}

// Live wrapper: reads the current server-activity signal + the module's
// last-TRUNCATE timestamp and applies the pure decision above.
let lastTruncateAt = 0;
function truncateAllowed({ force = false, now = Date.now() } = {}) {
  return truncateAllowedDecision(getActivitySignal(db), { force, lastTruncateAt, now });
}

async function drainTick() {
  // Heavy maintenance waits for a real foreground-idle window before touching
  // the queue or checkpointing the SQLCipher WAL.
  if (!foregroundMaintenanceAllowed('drain')) return;

  // Yield to chat again immediately before opening a drain pass.
  if (!(await waitForQuiet())) return;

  const handlers = buildMaintenanceHandlers({
    database: db,
    enqueuePassiveJob,
    idleDecision,
    // st_fd14cdd4 AC9 — the chat-app-active predicate the handler's fast recheck
    // polls to SIGTERM an in-flight phase grandchild the instant chat opens, so a
    // heavy phase releases the SQLite writer within ~1s (the brief's bar), not the
    // 5s the HID-idle recheck alone would take. Reads the same cross-process
    // chat-app-open signal waitForQuiet folds in.
    appActiveCheck: () => chatAppActiveDecision(getActivitySignal(db)),
    signal: ac.signal,
  });
  try {
    const results = await drainPassiveJobs({
      database: db,
      worker: WORKER_NAME,
      queue: 'default',
      jobTypes: MAINTENANCE_JOB_TYPES,
      handlers,
      limit: DRAIN_LIMIT,
      idleCheck: idleDecision,
    });
    const processed = results?.processed ?? 0;
    if (processed > 0) log(`drained ${processed} job(s)`);
  } catch (err) {
    log(`drain failed: ${err.message}`);
  }

  // PASSIVE checkpoint after the drain (PASSIVE never blocks writes). Force a
  // second pass if the WAL is past the frame ceiling so it stays bounded.
  const cp = passiveCheckpoint();
  if (cp && cp.log > FORCED_PASSIVE_FRAMES) passiveCheckpoint();

  // st_2cd1af73 AC-1 — bound the WAL FILE. A PASSIVE checkpoint moves committed
  // frames into the DB but does NOT shrink the -wal file; left alone the WAL
  // grows and EVERY reader pays to walk it. TRUNCATE resets the -wal file to
  // zero — but it takes an EXCLUSIVE lock and was measured at ~5s on this DB
  // while the embed daemon writes, so it must run ONLY in a genuinely-idle
  // window. truncateAllowed() enforces a wide quiet gate (TRUNCATE_QUIET_MS) +
  // a min-interval (no TRUNCATE storm) and bypasses both only when the WAL FILE
  // is past the hard ceiling (TRUNCATE_FORCE_FRAMES) so it stays bounded even on
  // a never-idle box. WHY gate on cp.log > FORCED_PASSIVE_FRAMES first: no point
  // paying TRUNCATE's exclusive lock when the WAL is already small.
  if (cp && cp.log > FORCED_PASSIVE_FRAMES) {
    const force = cp.log > TRUNCATE_FORCE_FRAMES;
    if (truncateAllowed({ force })) {
      if (force) log(`WAL past hard ceiling (${cp.log} frames) — forcing TRUNCATE despite activity`);
      truncateCheckpoint();
      lastTruncateAt = Date.now();
    }
  }

  // Background integrity scan on its own cadence (idle-gated inside).
  deepHealthTick();

  // Keep the global HNSW index fresh as embeddings land (throttled cadence).
  annRefreshTick();

  // st_db4b3118 self-healing ticks (each throttled + gated inside). They run in
  // the quiet window (after waitForQuiet) because each is heavier than the cheap
  // api-health publish: BRIEF FRESHNESS may spawn a Sonnet synthesis, RECLASSIFY
  // spawns a bounded cosine pass, VALUE-RANK REFRESH holds the writer briefly.
  briefFreshnessTick();
  reclassifySliceTick();
  valueRankRefreshTick();
}

// st_2cd1af73 AC-1 (residual) — publish the passive-jobs + session-log summaries
// EVERY tick, INDEPENDENT of the foreground/quiet-gated drain.
//
// WHY this moved out of drainTick (the residual bug it fixes): the publish used
// to run at the END of drainTick, AFTER waitForQuiet(). During an active chat
// burst waitForQuiet() blocks the whole drainTick, so the publish never ran and
// the server's published summary row went stale. precomputeServerHealthBody then
// fell back to getPassiveJobSummaryAsync ON THE SERVER'S MAIN THREAD — the live
// slow-statement logger caught that fallback firing ~once/second at ~1s each
// during chat (the `SELECT job_type, SUM(retry_count)...` aggregate), lifting
// chat TTFT. These summaries are READ-ONLY aggregates — they take a WAL read,
// never the writer — and use getPassiveJobSummary's in-process cache on the worker,
// so they are safe to compute on the worker's connection even while chat is active
// or the launch boot grace is protecting foreground work. Publishing them every
// tick keeps the server's row fresh so the server NEVER runs that scan on its own
// thread, busy window or not. Best-effort: a failure logs and the next tick
// republishes.
let lastSummaryPublishAt = 0;
function publishSummariesTick() {
  if (Date.now() - lastSummaryPublishAt < SUMMARY_PUBLISH_MS) return;
  lastSummaryPublishAt = Date.now();
  try {
    const passiveSummary = getPassiveJobSummary({ database: db });
    const sessionLogSummary = getPassiveJobSummary({ database: db, jobTypes: SESSION_LOG_JOB_TYPES });
    writeSupervisorSummaries(db, { passiveSummary, sessionLogSummary });
  } catch (err) {
    log(`summary publish failed: ${err.message}`);
  }
}

async function main() {
  if (!acquireSingleton()) return;
  log(`start — tick=${DRAIN_TICK_MS}ms drain_limit=${DRAIN_LIMIT} deep_health=${DEEP_HEALTH_MS}ms foreground_boot_grace=${Math.round(FOREGROUND_BOOT_GRACE_MS / 60000)}m foreground_quiet=${Math.round(FOREGROUND_QUIET_MS / 60000)}m`);

  while (!ac.signal.aborted) {
    // Single-drainer guard: if we no longer own the lock (a fresh worker took
    // over after we were orphaned by a server kickstart), exit now so at most
    // one worker ever drains. This is the runtime half of the singleton — the
    // acquire at start is the other half.
    if (!ownsSingleton()) {
      log('lost singleton lock (another worker owns it) — exiting 0');
      break;
    }
    writeSupervisorHeartbeat(db);
    const postDrainHold = activePostDrainHold();
    if (postDrainHold) {
      const now = Date.now();
      if (now - lastPostDrainHoldLogAt > 5 * 60_000) {
        lastPostDrainHoldLogAt = now;
        log(`${postDrainHold.reason} active — maintenance worker idle`);
      }
      await sleepInterruptibly(Math.max(DRAIN_TICK_MS, POST_DRAIN_HOLD_SLEEP_MS));
      continue;
    }
    // Publish the server-health summaries EVERY tick, before the quiet-gated
    // drain, so an active chat burst (which parks drainTick in waitForQuiet)
    // never leaves the server's published row stale and forcing it onto the
    // main-thread fallback scan. Read-only; safe during chat.
    publishSummariesTick();
    // st_db4b3118 (2a) — publish the API-health signal EVERY tick (cheap log tail
    // read + tiny single-row write), independent of the quiet-gated drain, so the
    // signal stays fresh even during an active chat burst. The heavier self-healing
    // ticks (brief / reclassify / value-rank) run inside drainTick's quiet window.
    apiHealthTick();
    try { await launchCriticalCatchupTick(); }
    catch (err) { log(`launch-critical catch-up tick error: ${err.message}`); }
    try { await drainTick(); }
    catch (err) { log(`tick error: ${err.message}`); }
    // Sleep DRAIN_TICK_MS between passes (interruptible by shutdown). The timer
    // is deliberately NOT unref'd: this worker is MEANT to live, and a ref'd
    // pending timer is what keeps the event loop alive across the idle gap (an
    // unref'd timer lets Node empty the loop and exit 13 "unsettled top-level
    // await" — the same always-alive contract the chunk-embed daemon relies on).
    // The abort listener still breaks the sleep immediately on shutdown.
    await sleepInterruptibly(DRAIN_TICK_MS);
  }
  log('shutting down — loop exited');
}

// Only run when invoked as the entrypoint (server-spawned / launchd / CLI).
// Importing for exports (none today, but symmetric with the daemon) must NOT
// start the loop.
function isEntrypoint() {
  const invoked = process.argv[1] || '';
  try {
    return import.meta.url === new URL(`file://${invoked}`).href
      || invoked.endsWith('supervisor-maintenance-worker.mjs');
  } catch {
    return invoked.endsWith('supervisor-maintenance-worker.mjs');
  }
}

if (isEntrypoint()) {
  await main();
  process.exit(0);
}
