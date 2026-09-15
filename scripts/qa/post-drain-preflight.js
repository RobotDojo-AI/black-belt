#!/usr/bin/env node
/**
 * Read-only readiness check for the post-embedding-drain handoff.
 *
 * This intentionally does not upload backups or mutate routing data. It proves
 * the expensive handoff will not immediately fail on local prerequisites.
 */

export const READ_ONLY_PREFLIGHT = true;

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EncryptedDatabase from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import config from '../../lib/config.js';
import { applyKeyPragma, loadOrGenerateLocalKey } from '../../lib/db-encryption.js';
import { getBackupOptions } from '../../lib/backup-options.js';
import { HNSW_DIMS } from '../../lib/ann/matryoshka.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..', '..');
const HOME = homedir();
const CONFIG_DIR = resolve(process.env.ROBOTDOJO_CONFIG || config.configDir || join(HOME, '.robotdojo'));
const DEFAULT_RESULT_FILE = resolve(CONFIG_DIR, 'runtime', 'post-drain-preflight.json');
const DEFAULT_DB_PATH = process.env.ROBOTDOJO_DB || join(HOME, '.robotdojo/robotdojo.db');
const DEFAULT_VECTOR_DB_PATH = process.env.ROBOTDOJO_EMBEDDINGS_DB || join(dirname(DEFAULT_DB_PATH), 'embeddings.db');
const REQUIRED_POST_DRAIN_COMMANDS = Object.freeze([
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
const REQUIRED_POST_DRAIN_DEPENDENCIES = Object.freeze([
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
const MEMORY_REFOCUS_PROJECTION_MAX_AFTER = nonnegativeNumber(
  process.env.ROBOTDOJO_POST_DRAIN_MAX_NEEDS_ROUTING_MEMORY,
  500,
);
const MEMORY_REFOCUS_PROJECTION_SECONDS = positiveNumber(
  process.env.ROBOTDOJO_POST_DRAIN_PREFLIGHT_MEMORY_REFOCUS_SECONDS,
  300,
);
const RECLASSIFY_PROJECTION_SECONDS = positiveNumber(
  process.env.ROBOTDOJO_POST_DRAIN_PREFLIGHT_RECLASSIFY_SECONDS,
  60,
);
const TOPIC_CONTEXT_SLICE_LIMIT = positiveNumber(
  process.env.ROBOTDOJO_MAINT_TOPICS_SLICE_LIMIT,
  50,
);
const TOPIC_CONTEXT_MAX_SLICES = positiveNumber(
  process.env.ROBOTDOJO_POST_DRAIN_MAX_TOPIC_SLICES,
  20,
);

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

function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function atomicWriteJson(path, payload) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function tail(value, max = 800) {
  return String(value || '').trim().slice(-max);
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

function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function commandCheck(command, args = [], { allowOutput = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    error: result.error?.message || null,
    ...(allowOutput ? { stdout_tail: tail(result.stdout), stderr_tail: tail(result.stderr) } : {}),
  };
}

function preflightChildEnv() {
  return {
    ...process.env,
    ROBOTDOJO_SUPPRESS_DB_BOOT_NOTICES: '1',
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

function verifyClonedDb(path, snapshotRoot) {
  const files = [path, `${path}-wal`, `${path}-shm`].filter((file) => existsSync(file));
  const bundleDir = join(snapshotRoot, basename(path));
  mkdirSync(bundleDir, { recursive: true });
  for (const source of files) {
    const clone = spawnSync('/bin/cp', ['-c', source, join(bundleDir, basename(source))], { encoding: 'utf8' });
    if (clone.status !== 0) {
      throw new Error(`copy-on-write clone failed for ${basename(source)}: ${tail(clone.stderr) || `exit ${clone.status}`}`);
    }
  }

  const key = keyForDbPath(path);
  const clonedPath = join(bundleDir, basename(path));
  const conn = new EncryptedDatabase(clonedPath, { readonly: true });
  try {
    if (key) applyKeyPragma(conn, key);
    sqliteVec.load(conn);
    const schemaObjects = Number(conn.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get()?.n || 0);
    const pageCount = Number(conn.pragma('page_count', { simple: true }) || 0);
    return {
      ok: true,
      basename: basename(path),
      exists: true,
      size_bytes: statSync(path).size,
      wal_present: existsSync(`${path}-wal`),
      shm_present: existsSync(`${path}-shm`),
      snapshot_method: 'clone',
      verification: {
        ok: true,
        mode: 'open_schema',
        schema_objects: schemaObjects,
        page_count: pageCount,
      },
    };
  } finally {
    conn.close();
  }
}

function dbCloneChecks(paths) {
  const snapshotRoot = join(tmpdir(), `robotdojo-post-drain-preflight-${process.pid}`);
  mkdirSync(snapshotRoot, { recursive: true });
  try {
    return paths.map((path) => {
      if (!existsSync(path)) {
        return {
          ok: false,
          basename: basename(path),
          exists: false,
          path,
          error: 'missing required DB file',
        };
      }
      try {
        return verifyClonedDb(path, snapshotRoot);
      } catch (err) {
        return {
          ok: false,
          basename: basename(path),
          exists: true,
          path,
          error: err?.message || String(err),
        };
      }
    });
  } finally {
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

function postDrainCommandChecks(root = ROOT) {
  return REQUIRED_POST_DRAIN_COMMANDS.map((rel) => {
    const path = resolve(root, rel);
    const exists = existsSync(path);
    return {
      rel,
      exists,
      sha256: exists ? sha256File(path) : null,
    };
  });
}

function postDrainDependencyChecks(root = ROOT) {
  return REQUIRED_POST_DRAIN_DEPENDENCIES.map((rel) => {
    const path = resolve(root, rel);
    const exists = existsSync(path);
    return {
      rel,
      exists,
      sha256: exists ? sha256File(path) : null,
    };
  });
}

function parseJsonPayload(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function openReadOnlyDb(path) {
  const conn = new EncryptedDatabase(path, { readonly: true });
  const key = keyForDbPath(path);
  if (key) applyKeyPragma(conn, key);
  sqliteVec.load(conn);
  return conn;
}

function safeVecTableName(topic) {
  return `chunk_vec_${String(topic || '').replace(/[^a-z0-9_]/gi, '_')}`;
}

function vecTableExists(conn, tableName) {
  try {
    return !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  } catch {
    return false;
  }
}

function globalAnnSourceProjection(dbPath = DEFAULT_DB_PATH, vectorDbPath = DEFAULT_VECTOR_DB_PATH) {
  let conn = null;
  let vectorConn = null;
  try {
    conn = openReadOnlyDb(dbPath);
    if (existsSync(vectorDbPath)) vectorConn = openReadOnlyDb(vectorDbPath);
    const topicRows = conn.prepare(`
      SELECT topic, COUNT(*) AS n
      FROM chunks
      WHERE embedded = 1
        AND topic IS NOT NULL
      GROUP BY topic
      ORDER BY topic
    `).all();
    let embeddedTotal = 0;
    let readableVectors = 0;
    let missingVectors = 0;
    let malformedRows = 0;
    let splitTablesUsed = 0;
    let legacyTablesUsed = 0;
    const byTopic = [];
    const expectedBytes = HNSW_DIMS * 4;
    for (const row of topicRows) {
      const topic = row.topic;
      const tableName = safeVecTableName(topic);
      const ids = conn.prepare('SELECT id FROM chunks WHERE topic = ? AND embedded = 1')
        .all(topic)
        .map((entry) => String(entry.id));
      embeddedTotal += ids.length;
      const remaining = new Set(ids);
      const sources = [];
      if (vectorConn && vecTableExists(vectorConn, tableName)) {
        sources.push({ conn: vectorConn, kind: 'split' });
        splitTablesUsed += 1;
      }
      if (vecTableExists(conn, tableName)) {
        sources.push({ conn, kind: 'legacy' });
        legacyTablesUsed += 1;
      }
      let topicReadable = 0;
      let topicMalformed = 0;
      for (const source of sources) {
        if (remaining.size === 0) break;
        let rows = [];
        try {
          rows = source.conn.prepare(`SELECT chunk_id, embedding FROM ${tableName}`).all();
        } catch {
          continue;
        }
        for (const vecRow of rows) {
          const chunkId = String(vecRow.chunk_id);
          if (!remaining.has(chunkId)) continue;
          const embedding = vecRow.embedding;
          const bytes = embedding?.byteLength || 0;
          if (bytes < expectedBytes) {
            topicMalformed += 1;
            malformedRows += 1;
            continue;
          }
          remaining.delete(chunkId);
          topicReadable += 1;
          readableVectors += 1;
        }
      }
      missingVectors += remaining.size;
      byTopic.push({
        topic,
        embedded: ids.length,
        readable_vectors: topicReadable,
        missing_vectors: remaining.size,
        malformed_rows: topicMalformed,
        table: tableName,
      });
    }
    return {
      ok: embeddedTotal > 0 && missingVectors === 0,
      read_only: true,
      hnsw_dims: HNSW_DIMS,
      expected_vector_bytes: expectedBytes,
      embedded_total: embeddedTotal,
      readable_vectors: readableVectors,
      missing_vectors: missingVectors,
      malformed_rows: malformedRows,
      topics_checked: topicRows.length,
      split_embeddings_open: Boolean(vectorConn),
      split_tables_used: splitTablesUsed,
      legacy_tables_used: legacyTablesUsed,
      by_topic: byTopic,
    };
  } catch (err) {
    return {
      ok: false,
      read_only: true,
      hnsw_dims: HNSW_DIMS,
      error: err?.message || String(err),
    };
  } finally {
    try { vectorConn?.close(); } catch {}
    try { conn?.close(); } catch {}
  }
}

function topicContextProjection(dbPath = DEFAULT_DB_PATH) {
  let conn = null;
  try {
    conn = openReadOnlyDb(dbPath);
    const hasTopics = !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_topics'").get();
    if (!hasTopics) {
      return {
        ok: false,
        read_only: true,
        reason: 'missing_user_topics_table',
        total_topics: 0,
        pending_now: 0,
        slice_limit: TOPIC_CONTEXT_SLICE_LIMIT,
        max_slices: TOPIC_CONTEXT_MAX_SLICES,
        capacity: TOPIC_CONTEXT_SLICE_LIMIT * TOPIC_CONTEXT_MAX_SLICES,
      };
    }
    const total = Number(conn.prepare('SELECT COUNT(*) AS n FROM user_topics').get()?.n || 0);
    const pending = Number(conn.prepare(`
      SELECT COUNT(*) AS n
      FROM user_topics
      WHERE COALESCE(needs_regen, 0) = 1
         OR context_md IS NULL
    `).get()?.n || 0);
    const noDescription = Number(conn.prepare(`
      SELECT COUNT(*) AS n
      FROM user_topics
      WHERE description IS NULL
         OR TRIM(description) = ''
    `).get()?.n || 0);
    const capacity = TOPIC_CONTEXT_SLICE_LIMIT * TOPIC_CONTEXT_MAX_SLICES;
    return {
      ok: capacity >= total,
      read_only: true,
      total_topics: total,
      pending_now: pending,
      no_description_topics: noDescription,
      slice_limit: TOPIC_CONTEXT_SLICE_LIMIT,
      max_slices: TOPIC_CONTEXT_MAX_SLICES,
      capacity,
    };
  } catch (err) {
    return {
      ok: false,
      read_only: true,
      error: err?.message || String(err),
      total_topics: null,
      pending_now: null,
      slice_limit: TOPIC_CONTEXT_SLICE_LIMIT,
      max_slices: TOPIC_CONTEXT_MAX_SLICES,
      capacity: TOPIC_CONTEXT_SLICE_LIMIT * TOPIC_CONTEXT_MAX_SLICES,
    };
  } finally {
    try { conn?.close(); } catch {}
  }
}

function backupDispatcherProjection(root = ROOT) {
  const resultFile = join(tmpdir(), `robotdojo-backup-dispatcher-preflight-${process.pid}-${Date.now()}.json`);
  try {
    const result = spawnSync(process.execPath, [
      'scripts/backup-dispatcher.js',
      '--strict',
      '--force-scheduled',
      '--db-only',
      '--snapshot-db',
      '--snapshot-method',
      'clone',
      '--dry-run',
      '--result-file',
      resultFile,
    ], {
      cwd: root,
      env: preflightChildEnv(),
      encoding: 'utf8',
      timeout: 5 * 60_000,
    });
    const projection = readJsonFile(resultFile) || parseJsonPayload(result.stdout);
    const locked = projection?.reason === 'locked';
    const lockPid = Number(projection?.pid);
    const lockProcessAlive = Number.isFinite(lockPid) && lockPid > 0 && processAlive(lockPid);
    const lockedButCompatible = locked
      && lockProcessAlive
      && projection?.dry_run === true
      && projection?.force === true
      && projection?.db_only === true
      && projection?.snapshot_dbs === true
      && projection?.strict === true
      && projection?.db_snapshot_enabled === true
      && projection?.db_snapshot_method === 'clone';
    const ok = (result.status === 0
      && projection?.ok === true
      && projection?.action === 'backup_to_gcp'
      && projection?.dry_run === true
      && projection?.force === true
      && projection?.db_only === true
      && projection?.snapshot_dbs === true
      && projection?.strict === true
      && projection?.strict_ok === true
      && projection?.db_snapshot_enabled === true
      && projection?.db_snapshot_method === 'clone'
      && Array.isArray(projection?.db_missing_required)
      && projection.db_missing_required.length === 0)
      || lockedButCompatible;
    return {
      ok,
      read_only: projection?.dry_run === true,
      locked,
      lock_compatible: lockedButCompatible,
      lock_pid: Number.isFinite(lockPid) ? lockPid : null,
      lock_process_alive: lockProcessAlive,
      status: result.status,
      signal: result.signal || null,
      error: result.error?.message || null,
      projection,
      stdout_tail: projection ? undefined : tail(result.stdout),
      stderr_tail: tail(result.stderr),
    };
  } finally {
    rmSync(resultFile, { force: true });
  }
}

function reclassifyProjection(root = ROOT) {
  const resultFile = join(tmpdir(), `robotdojo-reclassify-preflight-${process.pid}-${Date.now()}.json`);
  try {
    const result = spawnSync(process.execPath, [
      'scripts/ingest/05-reclassify-chunks.js',
      '--dry-run',
      '--no-regen',
      '--max-seconds',
      String(RECLASSIFY_PROJECTION_SECONDS),
      '--result-file',
      resultFile,
    ], {
      cwd: root,
      env: preflightChildEnv(),
      encoding: 'utf8',
      timeout: (RECLASSIFY_PROJECTION_SECONDS + 120) * 1000,
    });
    const projection = readJsonFile(resultFile) || parseJsonPayload(result.stdout);
    const passes = Array.isArray(projection?.passes) ? projection.passes : [];
    const projectedChanged = passes.reduce((sum, pass) => (
      sum + Number(pass?.moved || 0) + Number(pass?.deduped || 0)
    ), 0);
    const status = String(projection?.status || '');
    const ok = result.status === 0
      && projection?.ok === true
      && projection?.dry_run === true
      && projection?.skip_regen === true
      && (status === 'partial_slice' || status === 'complete')
      && passes.length > 0;
    return {
      ok,
      read_only: projection?.dry_run === true,
      status: result.status,
      signal: result.signal || null,
      error: result.error?.message || null,
      max_seconds: RECLASSIFY_PROJECTION_SECONDS,
      projected_changed: projectedChanged,
      projection,
      stdout_tail: projection ? undefined : tail(result.stdout),
      stderr_tail: tail(result.stderr),
    };
  } finally {
    rmSync(resultFile, { force: true });
  }
}

function memoryRefocusProjection(root = ROOT) {
  const result = spawnSync(process.execPath, [
    'scripts/refocus-memory-routing.js',
    '--json',
    '--max-seconds',
    String(MEMORY_REFOCUS_PROJECTION_SECONDS),
  ], {
    cwd: root,
    env: preflightChildEnv(),
    encoding: 'utf8',
    timeout: (MEMORY_REFOCUS_PROJECTION_SECONDS + 60) * 1000,
  });
  const projection = parseJsonPayload(result.stdout);
  const after = Number(projection?.after_current_needs_routing_links);
  const ok = result.status === 0
    && projection?.ok === true
    && projection?.applied === false
    && projection?.partial === false
    && Number.isFinite(after)
    && after <= MEMORY_REFOCUS_PROJECTION_MAX_AFTER;
  return {
    ok,
    read_only: projection?.applied === false,
    status: result.status,
    signal: result.signal || null,
    error: result.error?.message || null,
    threshold: MEMORY_REFOCUS_PROJECTION_MAX_AFTER,
    max_seconds: MEMORY_REFOCUS_PROJECTION_SECONDS,
    projection,
    stdout_tail: projection ? undefined : tail(result.stdout),
    stderr_tail: tail(result.stderr),
  };
}

function collectFailures(report) {
  const failures = [];
  if (report.backup.provider !== 'gcp') failures.push(`backup provider is ${report.backup.provider}`);
  if (report.backup.configured !== true) failures.push('GCP backup is not configured');
  if (report.backup.skipped === true) failures.push('backup is configured to skip');
  if (report.gcloud.installed !== true) failures.push('gcloud is not installed');
  if (report.gcloud.active_account_present !== true) failures.push('gcloud has no active account');
  if (report.gcloud.bucket_access !== true) failures.push('configured GCS bucket is not reachable');
  for (const db of report.db_snapshots) {
    if (db.ok !== true) failures.push(`${db.basename} clone/open-schema check failed${db.error ? `: ${db.error}` : ''}`);
  }
  const missing = report.post_drain_commands.filter((item) => item.exists !== true).map((item) => item.rel);
  if (missing.length > 0) failures.push(`post-drain command files missing: ${missing.join(', ')}`);
  const unhashed = report.post_drain_commands.filter((item) => item.exists === true && !item.sha256).map((item) => item.rel);
  if (unhashed.length > 0) failures.push(`post-drain command hashes missing: ${unhashed.join(', ')}`);
  const missingDeps = report.post_drain_dependencies.filter((item) => item.exists !== true).map((item) => item.rel);
  if (missingDeps.length > 0) failures.push(`post-drain dependency files missing: ${missingDeps.join(', ')}`);
  const unhashedDeps = report.post_drain_dependencies.filter((item) => item.exists === true && !item.sha256).map((item) => item.rel);
  if (unhashedDeps.length > 0) failures.push(`post-drain dependency hashes missing: ${unhashedDeps.join(', ')}`);
  const globalAnn = report.global_ann_source_projection;
  if (globalAnn?.ok !== true) {
    if (Number(globalAnn?.embedded_total || 0) <= 0) {
      failures.push('global ANN source projection found no embedded chunks');
    } else if (Number(globalAnn?.missing_vectors || 0) > 0) {
      failures.push(`global ANN source projection is missing ${globalAnn.missing_vectors} vectors`);
    } else {
      failures.push(`global ANN source projection failed${globalAnn?.error ? `: ${globalAnn.error}` : ''}`);
    }
  }
  const topicProjection = report.topic_context_projection;
  if (topicProjection?.ok !== true) {
    if (topicProjection?.reason === 'missing_user_topics_table') {
      failures.push('topic context projection cannot find user_topics');
    } else if (Number.isFinite(Number(topicProjection?.total_topics)) && Number.isFinite(Number(topicProjection?.capacity))) {
      failures.push(`topic context projection capacity ${topicProjection.capacity} is below total topics ${topicProjection.total_topics}`);
    } else {
      failures.push(`topic context projection failed${topicProjection?.error ? `: ${topicProjection.error}` : ''}`);
    }
  }
  const backupProjection = report.backup_dispatcher_projection;
  if (backupProjection?.ok !== true) {
    const projection = backupProjection?.projection || {};
    if (projection.dry_run !== true) {
      failures.push('backup dispatcher projection was not read-only');
    } else if (projection.reason === 'locked') {
      failures.push('backup dispatcher projection is blocked by a backup lock');
    } else if (projection.db_snapshot_method !== 'clone' || projection.db_snapshot_enabled !== true) {
      failures.push('backup dispatcher projection did not request clone DB snapshots');
    } else if (Array.isArray(projection.db_missing_required) && projection.db_missing_required.length > 0) {
      failures.push(`backup dispatcher projection is missing required DBs: ${projection.db_missing_required.join(', ')}`);
    } else {
      failures.push(`backup dispatcher projection failed${backupProjection?.error ? `: ${backupProjection.error}` : ''}`);
    }
  }
  const reclassify = report.reclassify_projection;
  if (reclassify?.ok !== true) {
    const projection = reclassify?.projection || {};
    if (projection.dry_run !== true) {
      failures.push('reclassify projection was not read-only');
    } else if (!Array.isArray(projection.passes) || projection.passes.length === 0) {
      failures.push('reclassify projection did not report pass evidence');
    } else {
      failures.push(`reclassify projection failed${reclassify?.error ? `: ${reclassify.error}` : ''}`);
    }
  }
  const memoryProjection = report.memory_refocus_projection;
  if (memoryProjection?.ok !== true) {
    const projection = memoryProjection?.projection || {};
    const after = Number(projection.after_current_needs_routing_links);
    if (Number.isFinite(after) && after > memoryProjection.threshold) {
      failures.push(`memory refocus projection leaves ${after} unresolved links above threshold ${memoryProjection.threshold}`);
    } else if (projection.partial === true) {
      failures.push('memory refocus projection did not complete within the preflight slice');
    } else if (projection.applied !== false) {
      failures.push('memory refocus projection was not read-only');
    } else {
      failures.push(`memory refocus projection failed${memoryProjection?.error ? `: ${memoryProjection.error}` : ''}`);
    }
  }
  return failures;
}

export function runPostDrainPreflight({
  dbPath = DEFAULT_DB_PATH,
  vectorDbPath = DEFAULT_VECTOR_DB_PATH,
  root = ROOT,
} = {}) {
  const backup = getBackupOptions();
  const whichGcloud = commandCheck('which', ['gcloud']);
  const activeAccount = whichGcloud.ok
    ? commandCheck('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], { allowOutput: true })
    : { ok: false, stdout_tail: '', stderr_tail: '' };
  const bucket = config.gcsBucket || null;
  const bucketProbe = whichGcloud.ok && bucket
    ? commandCheck('gcloud', ['storage', 'ls', bucket])
    : { ok: false, status: null, signal: null, error: bucket ? 'gcloud missing' : 'GCS bucket missing' };

  const report = {
    action: 'post_drain_preflight',
    ok: false,
    read_only: true,
    checked_at: new Date().toISOString(),
    script: {
      path: SCRIPT_PATH,
      sha256: sha256File(SCRIPT_PATH),
    },
    backup: {
      provider: backup.provider,
      configured: backup.configured,
      skipped: backup.skipped,
      has_bucket: Boolean(bucket),
    },
    gcloud: {
      installed: whichGcloud.ok,
      active_account_present: activeAccount.ok && Boolean(String(activeAccount.stdout_tail || '').trim()),
      bucket_access: bucketProbe.ok,
      bucket_probe_status: bucketProbe.status,
      bucket_probe_error: bucketProbe.ok ? null : bucketProbe.error || tail(bucketProbe.stderr_tail),
    },
    db_snapshots: dbCloneChecks([dbPath, vectorDbPath]),
    post_drain_commands: postDrainCommandChecks(root),
    post_drain_dependencies: postDrainDependencyChecks(root),
    global_ann_source_projection: globalAnnSourceProjection(dbPath, vectorDbPath),
    topic_context_projection: topicContextProjection(dbPath),
    backup_dispatcher_projection: backupDispatcherProjection(root),
    reclassify_projection: reclassifyProjection(root),
    memory_refocus_projection: memoryRefocusProjection(root),
    failures: [],
  };
  report.failures = collectFailures(report);
  report.ok = report.failures.length === 0;
  return report;
}

function printHelp() {
  console.log([
    'Usage: node scripts/qa/post-drain-preflight.js [--strict] [--result-file <path>] [--help]',
    '',
    'Read-only readiness gate for the post-embedding-drain handoff. It projects',
    'the expensive handoff steps (global ANN source, topic context, backup',
    'dispatcher, reclassify, memory refocus) and proves they will not immediately',
    'fail on local prerequisites — without uploading backups or mutating routing.',
    '',
    'Options:',
    '  --strict              Exit non-zero when any readiness projection fails.',
    '  --result-file <path>  Write the durable JSON proof to <path>.',
    '  --help                Print this help without running projections or',
    '                        writing durable proof.',
  ].join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // --help is a pure documentation path: it must NOT run projections and must
  // NOT write the durable result file (a fresh operator reading the help must
  // not clobber or fabricate readiness proof). Print and exit 0.
  if (args.help) {
    printHelp();
    return;
  }
  const resultFile = args.resultFile || process.env.ROBOTDOJO_POST_DRAIN_PREFLIGHT_RESULT_FILE || DEFAULT_RESULT_FILE;
  const report = runPostDrainPreflight();
  atomicWriteJson(resultFile, report);
  console.log(JSON.stringify(report, null, 2));
  if (args.strict && !report.ok) process.exit(1);
}

if (process.argv[1] === SCRIPT_PATH) {
  main().catch((err) => {
    let resultFile = DEFAULT_RESULT_FILE;
    try {
      const args = parseArgs(process.argv.slice(2));
      resultFile = args.resultFile || process.env.ROBOTDOJO_POST_DRAIN_PREFLIGHT_RESULT_FILE || DEFAULT_RESULT_FILE;
    } catch {}
    const payload = {
      action: 'post_drain_preflight',
      ok: false,
      read_only: true,
      checked_at: new Date().toISOString(),
      script: {
        path: SCRIPT_PATH,
        sha256: sha256File(SCRIPT_PATH),
      },
      failures: [err?.message || String(err)],
    };
    atomicWriteJson(resultFile, payload);
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  });
}
