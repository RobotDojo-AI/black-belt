#!/usr/bin/env node
/**
 * Backs up private/local recoverability roots to GCS using gcloud storage rsync.
 *
 * Why rsync: user/, docs/, pipeline/, config/, code/, and local support dirs change incrementally —
 * rsync sends only the changed objects (CRC32C comparison). --no-delete-unmatched
 * ensures GCS retains files even if they're removed locally.
 *
 * DB backup: copies ~/.robotdojo/robotdojo.db and the split vector store
 * ~/.robotdojo/embeddings.db plus WAL/SHM files to ${GCS_BUCKET}/databases/.
 * Cadence is owned by the dedicated
 * com.robotdojo.backup LaunchAgent.
 *
 * CLI:
 *   node scripts/backup-to-gcp.js              # full backup
 *   node scripts/backup-to-gcp.js --dry-run    # verify paths, pass -n to rsync
 *   node scripts/backup-to-gcp.js --db-only    # copy only robotdojo.db + embeddings.db boundary
 *   node scripts/backup-to-gcp.js --snapshot-db # upload consistent SQLite snapshots for DB files
 *   node scripts/backup-to-gcp.js --strict     # strict evidence mode; defaults to SQLite snapshots
 *   node scripts/backup-to-gcp.js --force      # bypass idle/RAM gates (scheduled backup only)
 *   node scripts/backup-to-gcp.js --mock-lock  # simulate a held lock (for testing)
 *   node scripts/backup-to-gcp.js --mock-free-pct=N  # override RAM reading (for testing)
 *   node scripts/backup-to-gcp.js --no-evidence      # do not touch the attempt marker
 *   node scripts/backup-to-gcp.js --no-worktree      # skip the AC7 working-tree copy
 *   node scripts/backup-to-gcp.js --trigger=NAME     # label the attempt (scheduled/catchup/manual)
 *
 * Configuration:
 *   GCS_BUCKET env var, Keychain entry 'GCS_BUCKET', or config/private.json
 *   infrastructure.gcs_bucket (e.g. gs://robotdojo-files).
 *
 * st_f6315f0b: IDLE_GATED=true. gcloud storage rsync spawns ~17 Python
 * multiprocessing-fork workers (research finding) — the dominant CPU/RAM
 * pressure source observed in the original defect repro. Idle-gating
 * confines backup runs to user-away windows.
 */
export const IDLE_GATED = true;

import { spawnSync, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync, mkdtempSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import EncryptedDatabase from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import config from '../lib/config.js';
import { applyKeyPragma, loadOrGenerateLocalKey } from '../lib/db-encryption.js';
import { enforceIdleGate } from '../lib/idle-gate.js';
import { privateBackupDirs, privateBackupFiles, dotdirExcludePattern } from '../lib/private-data-roots.js';
import { discoverPrivateConfigFiles } from '../lib/backup-coverage.js';
import { worktreeUploadPlan } from '../lib/backup-worktree.js';
import { loadProtectedRepos } from '../lib/protected-repos.js';
import {
  writeAttemptMarker,
  writeTerminalRecord,
  currentBootSeconds,
} from '../lib/backup-evidence.js';

const isMain = fileURLToPath(import.meta.url) === process.argv[1];

// Skip the idle gate when invoked with --force. The dedicated 02:30 backup
// job is the canonical owner and must make a real attempt on schedule.
if (isMain && !process.argv.includes('--force')) {
  await enforceIdleGate('backup-to-gcp');
}

const HOME = homedir();
const DEFAULT_DB_PATH = process.env.ROBOTDOJO_DB || join(HOME, '.robotdojo/robotdojo.db');
const LOCKFILE = process.env.ROBOTDOJO_BACKUP_LOCK_FILE || '/tmp/robotdojo-backup.pid';
const RAM_GATE_PCT = 25; // skip if free RAM below this percent (daytime runs only)
const GCLOUD_CP_TIMEOUT_MS = (() => {
  const raw = Number(process.env.ROBOTDOJO_GCS_CP_TIMEOUT_MS || '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 45 * 60_000;
})();

function gcloudTransferEnv() {
  return {
    ...process.env,
    CLOUDSDK_CORE_DISABLE_PROMPTS: process.env.CLOUDSDK_CORE_DISABLE_PROMPTS || '1',
    // gcloud storage cp can leave multiprocessing children idle on large DB files.
    // DB backup favors bounded reliability over max parallel upload speed.
    CLOUDSDK_STORAGE_PROCESS_COUNT: process.env.CLOUDSDK_STORAGE_PROCESS_COUNT || '1',
    CLOUDSDK_STORAGE_THREAD_COUNT: process.env.CLOUDSDK_STORAGE_THREAD_COUNT || '1',
  };
}

function atomicWriteJson(path, payload) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
}

function backupResultPayload(stats, { dry, force, dbOnly, snapshotDbs, strict }) {
  const strictFailed = strict && (stats?.skipped || stats?.strict_failed || stats?.strict_ok !== true);
  return {
    action: 'backup_to_gcp',
    ok: stats?.reason === 'no-bucket' ? false : !strictFailed,
    checked_at: new Date().toISOString(),
    dry_run: dry,
    force,
    db_only: dbOnly,
    snapshot_dbs: Boolean(snapshotDbs),
    strict,
    ...stats,
  };
}

function isConfigDbPath(path) {
  try {
    const configPrefix = `${resolve(config.configDir)}/`;
    return resolve(path).startsWith(configPrefix);
  } catch {
    return false;
  }
}

function keyForDbPath(path) {
  if (!isConfigDbPath(path)) return null;
  return loadOrGenerateLocalKey({ allowGenerate: false });
}

export function recordBackupSuccessHeartbeat({ dbPath = DEFAULT_DB_PATH, checkedAt = new Date().toISOString(), stats = {} } = {}) {
  if (!isConfigDbPath(dbPath)) {
    return { ok: false, skipped: true, reason: 'non-config-db' };
  }
  if (stats?.strict_ok !== true) {
    return { ok: false, skipped: true, reason: 'not-strict-ok' };
  }

  let conn = null;
  try {
    const key = keyForDbPath(dbPath);
    conn = new EncryptedDatabase(dbPath);
    if (key) applyKeyPragma(conn, key);
    conn.pragma('busy_timeout = 5000');
    conn.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    const detail = JSON.stringify({
      checked_at: checkedAt,
      strict_ok: true,
      snapshot_dbs: Boolean(stats.db_snapshot_enabled),
      snapshot_method: stats.db_snapshot_method || null,
      db_synced: Boolean(stats.db_synced),
      db_files_verified: stats.db_files_verified || [],
      db_snapshots_created: Array.isArray(stats.db_snapshots_created) ? stats.db_snapshots_created.length : 0,
    });

    const write = conn.transaction(() => {
      conn.prepare(`
        INSERT INTO kv_store (key, value, updated_at)
        VALUES ('backup:last_success', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(checkedAt);
      conn.prepare(`
        INSERT INTO kv_store (key, value, updated_at)
        VALUES ('backup:last_success_detail', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(detail);
    });
    write();
    return { ok: true, last_success: checkedAt };
  } catch (error) {
    console.warn(`[backup] heartbeat write failed: ${error?.message || error}`);
    return { ok: false, error: error?.message || String(error) };
  } finally {
    try { conn?.close?.(); } catch {}
  }
}

function openSnapshotSource(path, key = null) {
  const conn = new EncryptedDatabase(path, { readonly: true });
  if (key) applyKeyPragma(conn, key);
  conn.pragma('busy_timeout = 15000');
  sqliteVec.load(conn);
  return conn;
}

function verifySnapshotDatabase(path, key = null) {
  let conn = null;
  try {
    conn = openSnapshotSource(path, key);
    const schemaCount = Number(conn.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get()?.n || 0);
    let pageCount = null;
    try { pageCount = Number(conn.pragma('page_count', { simple: true }) || 0); } catch {}
    return {
      ok: true,
      mode: 'open_schema',
      schema_objects: schemaCount,
      page_count: pageCount,
      verified_at: new Date().toISOString(),
    };
  } finally {
    try { conn?.close?.(); } catch {}
  }
}

function createVacuumSnapshot(sourcePath, snapshotPath) {
  const key = keyForDbPath(sourcePath);
  let source = null;
  try {
    rmSync(snapshotPath, { force: true });
    source = openSnapshotSource(sourcePath, key);
    source.prepare('VACUUM INTO ?').run(snapshotPath);
    const verification = verifySnapshotDatabase(snapshotPath, key);
    const stat = statSync(snapshotPath);
    return {
      source: sourcePath,
      snapshot: snapshotPath,
      method: 'vacuum',
      size_bytes: stat.size,
      encrypted: Boolean(key),
      verification,
    };
  } finally {
    try { source?.close?.(); } catch {}
  }
}

function createCloneBundle(primaryPath, snapshotDir) {
  const key = keyForDbPath(primaryPath);
  const candidates = [
    primaryPath,
    `${primaryPath}-wal`,
    `${primaryPath}-shm`,
  ].filter((file) => existsSync(file));
  const files = [];
  for (const source of candidates) {
    const snapshot = join(snapshotDir, basename(source));
    const clone = spawnSync('/bin/cp', ['-c', source, snapshot], { encoding: 'utf8' });
    if (clone.status !== 0) {
      throw new Error(`copy-on-write clone failed for ${basename(source)}: ${String(clone.stderr || '').trim() || `exit ${clone.status}`}`);
    }
    const stat = statSync(snapshot);
    files.push({
      source,
      snapshot,
      size_bytes: stat.size,
    });
  }

  const verification = verifySnapshotDatabase(join(snapshotDir, basename(primaryPath)), key);

  return {
    source: primaryPath,
    method: 'clone',
    encrypted: Boolean(key),
    verification,
    files,
  };
}

function writeBackupResult(resultFile, stats, opts) {
  const payload = backupResultPayload(stats, opts);
  if (payload.ok && payload.strict && !payload.dry_run && payload.strict_ok === true) {
    payload.heartbeat = recordBackupSuccessHeartbeat({
      dbPath: opts.dbPath,
      checkedAt: payload.checked_at,
      stats,
    });
  }
  atomicWriteJson(resultFile, payload);
  return payload;
}

/**
 * Terminal record for the attempt (df_3df1f108 AC5). Written unconditionally on
 * every exit path so that a marker WITHOUT one of these means exactly one
 * thing: the process died without running an error path. That inference is the
 * whole reason the marker is written before the work starts, and it is the only
 * way a SIGKILL from the RAM watchdog is distinguishable from a run that never
 * started. Never throws — evidence bookkeeping must not break a backup.
 */
function recordTerminal(attemptId, stats, { dry }) {
  if (!attemptId) return;
  let outcome = 'success';
  let reason = null;
  let error = null;
  if (stats?.skipped) {
    outcome = 'skipped';
    reason = stats.reason || 'skipped';
  } else if (stats?.strict_ok !== true) {
    outcome = 'failure';
    reason = stats?.db_failed ? 'db_failed' : (stats?.failed?.length ? 'rsync_failed' : 'strict_not_ok');
    error = [
      ...(stats?.failed || []).map((p) => `dir:${p}`),
      ...(stats?.files_failed || []).map((p) => `file:${p}`),
      ...(stats?.db_files_failed || []).map((p) => `db:${p}`),
    ].join(', ') || null;
  } else if (dry) {
    outcome = 'skipped';
    reason = 'dry-run';
  }
  try {
    writeTerminalRecord({ attemptId, outcome, reason, error, detail: { strict_ok: Boolean(stats?.strict_ok), db_synced: Boolean(stats?.db_synced) } });
  } catch { /* see above */ }
}

// ── Lockfile helpers ──────────────────────────────────────────────────────────

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock() {
  if (existsSync(LOCKFILE)) {
    const raw = readFileSync(LOCKFILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (pid && isProcessAlive(pid)) {
      return { locked: true, pid };
    }
    // Stale lockfile from a crashed prior run — clean it up
    try { rmSync(LOCKFILE, { force: true }); } catch {}
  }
  writeFileSync(LOCKFILE, String(process.pid), 'utf8');
  return { locked: false };
}

function releaseLock() {
  try { rmSync(LOCKFILE, { force: true }); } catch {}
}

function cleanupGcloudChildren(result, execFn) {
  if (!result?.pid) return;
  try { execFn(`pkill -TERM -P ${result.pid} 2>/dev/null || true`); } catch {}
  try { execFn(`pkill -9 -P ${result.pid} 2>/dev/null || true`); } catch {}
}

function gcloudCopyFailed(result) {
  return Boolean(result?.error) || result?.status !== 0 || Boolean(result?.signal);
}

function runGcloudCopy(source, remote, { spawnFn, execFn, label }) {
  const opts = {
    stdio: 'inherit',
    encoding: 'utf8',
    timeout: GCLOUD_CP_TIMEOUT_MS,
    env: gcloudTransferEnv(),
  };
  const result = spawnFn('gcloud', ['storage', 'cp', source, remote], opts);
  cleanupGcloudChildren(result, execFn);
  if (gcloudCopyFailed(result)) {
    const reason = result?.error?.code === 'ETIMEDOUT'
      ? `timeout after ${GCLOUD_CP_TIMEOUT_MS}ms`
      : (result?.error?.message || result?.signal || `exit ${result?.status}`);
    console.warn(`[backup] ${label} copy failed (${source} → ${remote}): ${reason}`);
  }
  return result;
}

// ── RAM check ─────────────────────────────────────────────────────────────────

function checkRamFreePct(spawnFn) {
  const result = spawnFn('/usr/bin/memory_pressure', [], { encoding: 'utf8' });
  const match = (result.stdout || '').match(/System-wide memory free percentage:\s+(\d+)%/);
  return match ? parseInt(match[1], 10) : null;
}

// ── Backup dirs ────────────────────────────────────────────────────────────────

/**
 * Returns the default backup directory list.
 * Exported so tests can verify coverage without running a backup.
 */
export function getBackupDirs(home = HOME, bucket = '') {
  const dirs = [
    ...privateBackupDirs(home, bucket),
    // ~/.robotdojo/ — the WHOLE config dir, opt-out (df_3df1f108). Before this
    // the backup reached only tls/, the key, and the databases, so every other
    // file there was silently uncovered until someone named it. Now a new file
    // is covered by default and DOTDIR_EXCLUSIONS carries the justified drops.
    { local: join(home, '.robotdojo'),                      remote: `${bucket}/dotdir/`,
      exclude: dotdirExcludePattern() },
    // ~/.claude/ — Claude memory, projects, sessions (1.1GB)
    // repo-owned Agent OS sources are covered by GitHub; cache/telemetry/ are ephemeral
    { local: join(home, '.claude'),                         remote: `${bucket}/dotclaude/`,
      exclude: 'agents/skills/|cache/|telemetry/' },
  ];
  // Exclude the Black Belt build key from the code/ mirror. code/black-belt/CLAUDE.md
  // states the key is regenerated via scripts/key-gen.js and CI uses an env var —
  // it's a local dev convenience, not an irreplaceable secret, and raw private keys
  // don't belong in a bulk-synced folder. Owner's recorded call, st_e0776b46.
  //
  // white-belt is a symlink to `../..` — i.e. the entire home directory — sitting
  // INSIDE a backup root. The current sync evidently does not follow it (a run
  // that recursed all of $HOME could not finish in the observed 43 minutes), but
  // that is an accident we were relying on. Declared here so the behaviour is
  // stated rather than assumed (df_3df1f108 Q1).
  const codeDir = dirs.find((d) => d.key === 'code');
  if (codeDir) codeDir.exclude = String.raw`black-belt/\.build-key|white-belt(/.*|$)`;
  return dirs;
}

/**
 * Files backed up individually because they sit outside every whole-directory
 * root. The static PRIVATE_DATA_FILES list is merged with every gitignored file
 * directly under `config/` — a derived class, not an enumeration, so a secret
 * written there tomorrow is covered without an edit (df_3df1f108 AC3(a)).
 */
export function getBackupFiles(home = HOME, bucket = '') {
  const repoRoot = join(home, 'robotdojo');
  const discovered = discoverPrivateConfigFiles(repoRoot).map((file) => ({
    key: file.key,
    local: join(repoRoot, file.local),
    remote: `${bucket}/${file.remote}`,
  }));
  return [...privateBackupFiles(home, bucket), ...discovered];
}

export function backupExcludePattern(extra = '') {
  const base = String.raw`.*\.git(/.*|$)|.*node_modules(/.*|$)`;
  return extra ? `${base}|${extra}` : base;
}

// ── Single rsync with subprocess cleanup + retry ──────────────────────────────

function runRsync(local, remote, rsyncArgs, { spawnFn, execFn, dry }) {
  console.info(`[backup] GCS: ${remote}${dry ? ' (dry-run)' : ''}`);

  let result = spawnFn('gcloud', rsyncArgs, { stdio: 'inherit', encoding: 'utf8' });
  // Kill any surviving gcloud worker processes (Python multiprocessing-fork orphans)
  cleanupGcloudChildren(result, execFn);

  if (result.status !== 0) {
    console.warn(`[backup] rsync failed for ${local} — retrying once`);
    result = spawnFn('gcloud', rsyncArgs, { stdio: 'inherit', encoding: 'utf8' });
    cleanupGcloudChildren(result, execFn);
    if (result.status !== 0) {
      console.warn(`[backup] WARN: ${local} failed after retry — continuing`);
      return { local, remote, failed: true };
    }
  }

  console.info(`[backup] ok: ${remote}`);
  return { local, remote, failed: false };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {boolean}  [opts.dry=false]         - Pass --dry-run to rsync, skip DB upload
 * @param {Function} [opts.spawn=spawnSync]   - Injectable for tests
 * @param {Function} [opts.exec=execSync]     - Injectable for tests
 * @param {Array}    [opts.dirs]              - Dir list override (for tests)
 * @param {string}   [opts.dbPath]            - DB path override (for tests)
 * @param {string}   [opts.embeddingsDbPath]  - Split vector DB path override (for tests)
 * @param {string}   [opts.keyPath]           - Key file path override (for tests)
 * @param {boolean}  [opts.force=false]       - Bypass RAM gate (used by scheduled backup)
 * @param {boolean}  [opts.dbOnly=false]      - Back up only DB/vector files and key
 * @param {boolean}  [opts.snapshotDbs=false] - Stage consistent SQLite snapshots before uploading DB files
 * @param {string}   [opts.snapshotMethod]    - clone or vacuum; clone is copy-on-write and disk-safe for large DBs
 * @param {string}   [opts.resultFile]        - Atomic JSON result file for orchestration gates
 * @param {boolean}  [opts.mockLock=false]    - Simulate a held lock (for tests)
 * @param {number}   [opts.mockFreePct]       - Override RAM reading (for tests)
 */
export function runBackup({
  dry          = false,
  spawn        = spawnSync,
  exec         = execSync,
  dirs,
  files,
  dbPath       = DEFAULT_DB_PATH,
  embeddingsDbPath = process.env.ROBOTDOJO_EMBEDDINGS_DB || '',
  keyPath      = join(HOME, '.robotdojo/key'),
  force        = false,
  dbOnly       = false,
  snapshotDbs  = false,
  snapshotMethod = process.env.ROBOTDOJO_BACKUP_SNAPSHOT_METHOD || 'clone',
  resultFile,
  mockLock     = false,
  mockFreePct,
  strict       = false,
  recordEvidence = false,
  trigger      = 'manual',
  worktree     = false,
} = {}) {
  // ── Attempt marker (df_3df1f108 AC5) ────────────────────────────────────────
  // Written BEFORE any work — before the lock, before the RAM gate, before the
  // 28 GB database is opened. A marker with no terminal record is the evidence
  // of a run that died reporting nothing; that inference only holds if the
  // marker predates everything that could kill the process.
  let attemptId = null;
  if (recordEvidence) {
    attemptId = writeAttemptMarker({ trigger, bootSec: currentBootSeconds() }).attempt_id;
  }

  // ── Lockfile guard ──────────────────────────────────────────────────────────
  if (mockLock) {
    console.warn('[backup] backup already running (pid: mock) — skipping');
    const stats = {
      skipped: true,
      reason: 'locked',
      db_snapshot_enabled: Boolean(snapshotDbs),
      db_snapshot_method: snapshotDbs ? snapshotMethod : null,
    };
    writeBackupResult(resultFile, stats, { dry, force, dbOnly, snapshotDbs, strict, dbPath });
    recordTerminal(attemptId, stats, { dry });
    return stats;
  }
  const lock = acquireLock();
  if (lock.locked) {
    console.warn(`[backup] backup already running (pid: ${lock.pid}) — skipping`);
    const stats = {
      skipped: true,
      reason: 'locked',
      pid: lock.pid,
      db_snapshot_enabled: Boolean(snapshotDbs),
      db_snapshot_method: snapshotDbs ? snapshotMethod : null,
    };
    writeBackupResult(resultFile, stats, { dry, force, dbOnly, snapshotDbs, strict, dbPath });
    recordTerminal(attemptId, stats, { dry });
    return stats;
  }

  try {
    const stats = _runBackupInner({ dry, spawn, exec, dirs, files, dbPath, embeddingsDbPath, keyPath, force, dbOnly, snapshotDbs, snapshotMethod, mockFreePct, strict, worktree });
    writeBackupResult(resultFile, stats, { dry, force, dbOnly, snapshotDbs, strict, dbPath });
    recordTerminal(attemptId, stats, { dry });
    return stats;
  } catch (error) {
    // An exception is a failure, not an absence. Without this the crash would
    // leave an orphaned marker and be reported as `killed` — a wrong diagnosis
    // that sends the owner looking at memory pressure instead of the stack.
    if (attemptId) {
      try {
        writeTerminalRecord({ attemptId, outcome: 'failure', reason: 'exception', error: error?.message || String(error) });
      } catch { /* bookkeeping must never mask the original error */ }
    }
    throw error;
  } finally {
    releaseLock();
  }
}

function _runBackupInner({ dry, spawn, exec, dirs, files, dbPath, embeddingsDbPath, keyPath, force, dbOnly, snapshotDbs, snapshotMethod, mockFreePct, strict, worktree }) {
  // ── RAM gate ────────────────────────────────────────────────────────────────
  if (!force) {
    const freePct = mockFreePct !== undefined ? mockFreePct : checkRamFreePct(spawn);
    if (freePct !== null && freePct < RAM_GATE_PCT) {
      console.warn(`[backup] deferred: low RAM (${freePct}% free, threshold ${RAM_GATE_PCT}%) — pass --force to override`);
      return { skipped: true, reason: 'low-ram', freePct };
    }
  }

  const bucket = config.gcsBucket;
  if (!bucket && !dirs) {
    console.error('[backup] GCS_BUCKET not configured — set env var or Keychain entry');
    return { skipped: true, reason: 'no-bucket' };
  }

  const callerProvidedDirs = Boolean(dirs);
  dirs ??= getBackupDirs(HOME, bucket);
  files ??= callerProvidedDirs ? [] : getBackupFiles(HOME, bucket);

  // Guard: gcloud must be on PATH.
  const which = spawn('which', ['gcloud'], { encoding: 'utf8' });
  if (which.status !== 0) {
    console.warn('[backup] gcloud not on PATH — backup skipped');
    return { skipped: true, reason: 'missing-gcloud' };
  }

  const stats = {
    rsynced: [],
    failed: [],
    files_uploaded: [],
    files_failed: [],
    db_files_uploaded: [],
    db_files_failed: [],
    db_files_verified: [],
    db_files_verify_failed: [],
    db_required_files: [],
    db_missing_required: [],
    db_snapshot_enabled: Boolean(snapshotDbs),
    db_snapshot_method: snapshotDbs ? snapshotMethod : null,
    db_snapshots_created: [],
    db_snapshots_failed: [],
    db_synced: false,
    worktree_uploaded: [],
    worktree_failed: [],
    worktree_planned: 0,
    strict_ok: false,
  };

  // ── Incremental rsync for each dir ────────────────────────────────────────
  for (const dir of (dbOnly ? [] : dirs)) {
    const { local, remote, exclude } = dir;
    if (!existsSync(local)) {
      console.warn(`[backup] ${local} does not exist — skipping`);
      continue;
    }

    const excludePattern = backupExcludePattern(exclude);
    const rsyncArgs = [
      'storage', 'rsync', '-r',
      '--exclude', excludePattern,
      '--no-delete-unmatched-destination-objects',
    ];
    if (dry) rsyncArgs.push('--dry-run');
    rsyncArgs.push(local, remote);

    const outcome = runRsync(local, remote, rsyncArgs, { spawnFn: spawn, execFn: exec, dry });
    if (outcome.failed) {
      stats.failed.push(local);
    } else {
      stats.rsynced.push(local);
    }
  }

  // ── Local-only files outside private dirs ────────────────────────────────
  for (const file of (dbOnly ? [] : files)) {
    const { local, remote } = file;
    if (!existsSync(local)) continue;
    if (dry) {
      console.info(`[backup] file sync skipped (dry-run) — would copy ${local} → ${remote}`);
      continue;
    }
    console.info(`[backup] FILE: ${local} → ${remote}`);
    const result = runGcloudCopy(local, remote, { spawnFn: spawn, execFn: exec, label: 'file' });
    if (gcloudCopyFailed(result)) {
      console.warn(`[backup] file sync failed (${local})`);
      stats.files_failed.push(local);
    } else {
      stats.files_uploaded.push(local);
    }
  }

  // ── Working-tree content no remote holds (df_3df1f108 AC7) ───────────────
  // Modified tracked files and untracked-not-ignored files are copied WHOLE.
  // A clean tracked file is not copied — GitHub holds it. A file already under
  // an existing bucket root is not copied either, which is AC7(a)'s
  // no-duplication rule generalised rather than special-cased.
  if (worktree && !dbOnly) {
    const repos = loadProtectedRepos();
    const plan = worktreeUploadPlan(repos, bucket, { mainRepoRoot: join(HOME, 'robotdojo') });
    stats.worktree_planned = plan.length;
    for (const item of plan) {
      if (!existsSync(item.local)) continue;
      if (dry) {
        console.info(`[backup] worktree sync skipped (dry-run) — would copy ${item.local} → ${item.remote}`);
        continue;
      }
      const result = runGcloudCopy(item.local, item.remote, { spawnFn: spawn, execFn: exec, label: 'worktree' });
      if (gcloudCopyFailed(result)) {
        console.warn(`[backup] worktree sync failed (${item.local})`);
        stats.worktree_failed.push(item.rel);
      } else {
        stats.worktree_uploaded.push(item.rel);
      }
    }
    console.info(`[backup] worktree: ${stats.worktree_uploaded.length} uploaded, ${stats.worktree_failed.length} failed, ${plan.length} planned`);
  }

  // ── Encryption key — tiny file, critical ────────────────────────────────
  if (existsSync(keyPath)) {
    if (!dry) {
      const result = runGcloudCopy(keyPath, `${bucket}/dotdir/key`, { spawnFn: spawn, execFn: exec, label: 'key' });
      if (!gcloudCopyFailed(result)) {
        console.info(`[backup] key → ${bucket}/dotdir/key`);
        stats.key_uploaded = true;
      } else {
        console.warn('[backup] key upload failed');
        stats.key_failed = true;
      }
    }
  }

  // ── Canonical DB files → configured GCS bucket ────────────────────────────
  // Syncs ~/.robotdojo/robotdojo.db and the split vector store embeddings.db
  // plus WAL/SHM if present. The database moved out of ~/robotdojo/databases so
  // code pulls and repo resets cannot split the user data plane from the running
  // service; the split vector DB is part of that same recoverability boundary.
  const splitDbPath = embeddingsDbPath || join(dirname(dbPath), 'embeddings.db');
  const requiredDbFiles = [...new Set([dbPath, splitDbPath])];
  const dbCandidates = [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    splitDbPath,
    `${splitDbPath}-wal`,
    `${splitDbPath}-shm`,
  ];
  const dbFiles = [...new Set(dbCandidates)].filter((p) => existsSync(p));
  stats.db_required_files = requiredDbFiles;
  stats.db_missing_required = requiredDbFiles.filter((p) => !existsSync(p));
  if (!dry && dbFiles.length > 0) {
    // Passive WAL checkpoint — integrates committed pages before upload.
    // Non-fatal: encrypted DBs (SQLCipher) reject the sqlite3 CLI with SQLITE_NOTADB;
    // server auto-checkpoints on connection close anyway.
    if (!snapshotDbs && existsSync(dbPath)) {
      try {
        exec(`sqlite3 "${dbPath}" "PRAGMA wal_checkpoint(PASSIVE);"`, { stdio: 'ignore' });
      } catch (e) {
        console.warn('[backup] WAL checkpoint failed (non-fatal):', e.message);
      }
    }

    const dbBucket = `${bucket}/databases`;
    let failed = false;
    let snapshotDir = null;
    try {
      let uploadEntries = dbFiles.map((file) => ({ source: file, uploadPath: file }));
      if (snapshotDbs) {
        snapshotDir = mkdtempSync(join(tmpdir(), 'robotdojo-db-backup-'));
        uploadEntries = [];
        if (snapshotMethod === 'vacuum') {
          for (const file of requiredDbFiles.filter((p) => existsSync(p))) {
            const uploadPath = join(snapshotDir, basename(file));
            try {
              const snapshot = createVacuumSnapshot(file, uploadPath);
              stats.db_snapshots_created.push(snapshot);
              uploadEntries.push({ source: file, uploadPath });
            } catch (error) {
              console.warn(`[backup] DB snapshot failed (${file}): ${error?.message || error}`);
              stats.db_snapshots_failed.push({ source: file, error: error?.message || String(error) });
              stats.db_files_failed.push(file);
              failed = true;
            }
          }
        } else if (snapshotMethod === 'clone') {
          for (const primary of requiredDbFiles.filter((p) => existsSync(p))) {
            const bundleDir = join(snapshotDir, basename(primary));
            mkdirSync(bundleDir, { recursive: true });
            try {
              const bundle = createCloneBundle(primary, bundleDir);
              stats.db_snapshots_created.push(bundle);
              for (const file of bundle.files) {
                uploadEntries.push({ source: file.source, uploadPath: file.snapshot });
              }
            } catch (error) {
              console.warn(`[backup] DB snapshot failed (${primary}): ${error?.message || error}`);
              stats.db_snapshots_failed.push({ source: primary, error: error?.message || String(error) });
              stats.db_files_failed.push(primary);
              failed = true;
            }
          }
        } else {
          throw new Error(`unknown DB snapshot method: ${snapshotMethod}`);
        }
      }

      for (const { source: file, uploadPath } of uploadEntries) {
        if (!existsSync(uploadPath)) {
          stats.db_files_failed.push(file);
          failed = true;
          continue;
        }
        const dest = `${dbBucket}/${basename(file)}`;
        console.info(`[backup] DB: ${file}${snapshotDbs ? ` (snapshot ${uploadPath})` : ''} → ${dest}`);
        const result = runGcloudCopy(uploadPath, dest, { spawnFn: spawn, execFn: exec, label: 'DB file' });
        if (gcloudCopyFailed(result)) {
          console.warn(`[backup] DB file sync failed (${file})`);
          stats.db_files_failed.push(file);
          failed = true;
        } else {
          stats.db_files_uploaded.push(file);
        }
      }
    } finally {
      if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
    }

    if (!failed) {
      for (const file of dbFiles) {
        const dbBucketFile = `${dbBucket}/${basename(file)}`;
        const verify = spawn('gcloud', ['storage', 'ls', dbBucketFile], { encoding: 'utf8' });
        if (verify.status !== 0) {
          console.warn(`[backup] WARN: GCS DB verification failed — ${dbBucketFile} may not be in bucket`);
          stats.db_verify_failed = true;
          stats.db_files_verify_failed.push(file);
        } else {
          stats.db_files_verified.push(file);
          console.info(`[backup] verified: ${dbBucketFile}`);
        }
      }
      stats.db_synced = stats.db_missing_required.length === 0 && !stats.db_verify_failed;
    } else {
      stats.db_failed = true;
    }
  } else if (dry) {
    console.info(`[backup] DB sync skipped (dry-run) — would copy ${dbPath} and ${splitDbPath}${snapshotDbs ? ` via SQLite ${snapshotMethod} snapshots` : ' plus WAL/SHM'} → ${bucket}/databases/`);
  }

  stats.db_files_uploaded = [...new Set(stats.db_files_uploaded)];
  stats.db_files_failed = [...new Set(stats.db_files_failed)];
  stats.db_files_verified = [...new Set(stats.db_files_verified)];
  stats.db_files_verify_failed = [...new Set(stats.db_files_verify_failed)];

  stats.strict_ok = !stats.skipped
    && stats.failed.length === 0
    && stats.files_failed.length === 0
    && stats.worktree_failed.length === 0
    && !stats.key_failed
    && (dry || stats.db_synced)
    && !stats.db_failed
    && !stats.db_verify_failed
    && (dry || stats.db_missing_required.length === 0)
    && (!snapshotDbs || stats.db_snapshots_failed.length === 0);
  if (strict && !stats.strict_ok) stats.strict_failed = true;
  return stats;
}

// ── Main entry (not imported by tests) ────────────────────────────────────────
if (isMain) {
  const args = process.argv.slice(2);
  const dry       = args.includes('--dry-run');
  const force     = args.includes('--force');
  const strict    = args.includes('--strict');
  const dbOnly    = args.includes('--db-only');
  const noSnapshotDbs = args.includes('--no-snapshot-db') || process.env.ROBOTDOJO_BACKUP_SNAPSHOT_DB === '0';
  const snapshotDbs = !noSnapshotDbs && (strict || args.includes('--snapshot-db') || process.env.ROBOTDOJO_BACKUP_SNAPSHOT_DB === '1');
  const snapshotMethodArg = args.find(a => a.startsWith('--snapshot-method='));
  const snapshotMethod = snapshotMethodArg
    ? snapshotMethodArg.split('=').slice(1).join('=')
    : (args.includes('--snapshot-method') ? args[args.indexOf('--snapshot-method') + 1] : process.env.ROBOTDOJO_BACKUP_SNAPSHOT_METHOD || 'clone');
  const mockLock  = args.includes('--mock-lock');
  const resultFileArg = args.find(a => a.startsWith('--result-file='));
  const resultFile = resultFileArg
    ? resultFileArg.split('=').slice(1).join('=')
    : (args.includes('--result-file') ? args[args.indexOf('--result-file') + 1] : process.env.ROBOTDOJO_BACKUP_RESULT_FILE);
  const mockFreePctArg = args.find(a => a.startsWith('--mock-free-pct='));
  const mockFreePct = mockFreePctArg ? parseInt(mockFreePctArg.split('=')[1], 10) : undefined;
  // Evidence and the working-tree copy default ON for a real run and OFF for a
  // dry run. `--no-evidence` exists so a diagnostic invocation cannot overwrite
  // the marker the guardian is reading.
  const recordEvidence = !args.includes('--no-evidence') && !dry;
  const worktree = !args.includes('--no-worktree');
  const triggerArg = args.find(a => a.startsWith('--trigger='));
  const trigger = triggerArg ? triggerArg.split('=').slice(1).join('=') : (force ? 'scheduled' : 'manual');

  const stats = runBackup({ dry, force, dbOnly, snapshotDbs, snapshotMethod, resultFile, mockLock, mockFreePct, strict, recordEvidence, trigger, worktree });
  if (stats.reason === 'no-bucket' || (strict && (stats.skipped || stats.strict_failed))) process.exit(1);
  if (!stats.skipped) {
    console.info(`[backup] Done — rsynced:${stats.rsynced.length} failed:${stats.failed?.length ?? 0} db:${stats.db_synced}`);
  }
}
