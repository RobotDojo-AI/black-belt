/**
 * Drop-folder watcher.
 *
 * Watches `~/robotdojo/user/inbox/` with `fs.watch` (recursive on macOS
 * via native FSEvents binding). For each new file:
 *   1. debounce 500 ms to ride out partial writes
 *   2. stat guard — skip directories, bail on ENOENT races
 *   3. compute SHA-256 → short-circuit if duplicate (delete from Inbox)
 *   4. classify → pick a router
 *   5. router returns metadata + extracted content
 *   6. upsert row in `drop_folder_files` with status=upload_pending
 *   7. async GCS upload → on success: delete local, set status=processed
 *   8. emit lifecycle event for chat notifications
 *
 * On any error: file stays in Inbox, DB flagged status=needs_user, event emitted.
 * No Processing/, no Errors/, no local Archive/. GCS is the permanent archive.
 *
 * Upload is fire-and-forget — the pipeline never blocks on network I/O.
 * If upload fails: file stays in user/inbox/ as status=upload_pending.
 * On server start: any upload_pending files are retried before the watcher arms.
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { UNKNOWN_TOPIC_PAIR } from '../topic-routing-policy.js';
import { createReadStream } from 'node:fs';
import { mkdir, stat, watch as fsWatch, readdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { spawn } from 'node:child_process';
import {
  INBOX, INDEX_DIR,
  ontologyPath, gcsKey,
} from './paths.js';
import { classifyFile } from './classifier.js';
import { upsertFile, getByHash, getByPath, updateStatus } from './index-db.js';
import { routePdf } from './route-pdf.js';
import { routeCsv } from './route-csv.js';
import { routeImage } from './route-image.js';
import { routeArchive } from './route-archive.js';
import { routeEmail } from './route-email.js';
import { routeCredentials } from './route-credentials.js';
import { routeGeneric } from './route-generic.js';
import { routeLlmExport } from './route-llm-export.js';
import { routeXlsx } from './route-xlsx.js';
import { routeHealth } from './route-health.js';
import config from '../config.js';
import {
  drainPassiveJobs,
  enqueuePassiveJob,
  passiveJobUniqueKey,
} from '../passive-jobs.js';
import { enqueuePipelinesOnDataArrival } from '../data-arrival-pipelines.js';

const DEBOUNCE_MS = 500;
const DROP_FOLDER_JOB_TYPE = 'drop_folder_import';
const DROP_FOLDER_WORKER = 'drop-folder-watcher';
const DROP_FOLDER_DRAIN_LIMIT = Math.max(1, Number(process.env.ROBOTDOJO_DROP_FOLDER_DRAIN_LIMIT || 3));

// --- Event bus --------------------------------------------------------------

export const events = new EventEmitter();

function emit(type, payload) {
  events.emit('event', { type, ...payload, at: new Date().toISOString() });
}

// --- Filesystem helpers -----------------------------------------------------

async function ensureDir(path) { await mkdir(path, { recursive: true }); }

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const rs = createReadStream(filePath);
    rs.on('data', (b) => h.update(b));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

async function settled(filePath) {
  // Wait until two successive size probes match AND the file is not empty.
  let last = -1;
  for (let i = 0; i < 20; i++) {
    let s;
    try { s = await stat(filePath); }
    catch { return false; }
    if (s.size > 0 && s.size === last) return true;
    last = s.size;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

// --- GCS upload helpers -----------------------------------------------------

/**
 * Returns true if the filename should be skipped for GCS upload.
 * WHY: archivePath() date-prefixes names, so '.DS_Store' becomes
 * '2026-04-27-.DS_Store' — startsWith('.') misses it.
 */
export function shouldSkipUpload(name) {
  return (
    name.startsWith('.')        ||
    name.endsWith('.DS_Store')  ||
    name.endsWith('.localized')
  );
}

/**
 * Upload a single local file to GCS via gsutil.
 * Returns Promise<{ ok: boolean }>.
 * Fire-and-forget safe: caller does not need to await.
 */
function uploadArchive(localPath, gcsTarget) {
  return new Promise((resolve) => {
    const child = spawn('gsutil', ['-q', 'cp', localPath, gcsTarget], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (d) => console.warn(`[drop-folder:gcs] ${d.toString().trim()}`));
    child.on('error', (err) => {
      console.warn(`[drop-folder:gcs] spawn error (gsutil not on PATH?): ${err.message}`);
      resolve({ ok: false });
    });
    child.on('close', (code) => resolve({ ok: code === 0 }));
    child.unref();
  });
}

/**
 * Upload a file to GCS and delete the local copy on success.
 * Updates DB status to 'processed' on success; leaves 'upload_pending' on failure.
 *
 * _upload is injectable for tests — pass async () => ({ ok: true/false }).
 */
async function uploadAndClean(localPath, originalName, _upload = uploadArchive) {
  const bucket = config.gcsBucket;
  if (!bucket) return; // GCS not configured — skip silently

  const key = gcsKey(originalName);
  const gcsTarget = `${bucket}/imports/${key}`;

  let ok = false;
  try {
    ({ ok } = await _upload(localPath, gcsTarget));
  } catch (err) {
    console.warn(`[drop-folder] GCS upload threw — keeping ${basename(localPath)} for retry on next start: ${err.message}`);
    return;
  }
  if (ok) {
    await unlink(localPath).catch(() => {});
    updateStatus(localPath, 'processed');
    emit('file_uploaded', { name: originalName, gcs: gcsTarget });
  } else {
    console.warn(`[drop-folder] GCS upload failed — keeping ${basename(localPath)} for retry on next start`);
  }
}

// --- Router dispatch --------------------------------------------------------

async function runRouter(router, args) {
  switch (router) {
    case 'pdf':         return routePdf(args);
    case 'csv':         return routeCsv(args);
    case 'image':       return routeImage(args);
    case 'archive':     return routeArchive(args);
    case 'email':       return routeEmail(args);
    case 'credentials': return routeCredentials(args);
    // WHY xlsx gets its own router: XLSX ingestion is slow (entity matching,
    // embedding, scoring) — it runs as a detached subprocess rather than inline.
    case 'xlsx':        return routeXlsx(args);
    case 'llm_export':  return routeLlmExport(args);
    case 'health':      return routeHealth(args);
    default:            return routeGeneric(args);
  }
}

// --- Error handler ----------------------------------------------------------

/**
 * Flag a file as needing user attention. File stays in Inbox so it's
 * retried on server restart (boot scan picks it up again), but the
 * needs_user status means the boot scan will skip it — only explicit
 * user action (remove/replace the file) clears it.
 */
async function flagNeedsUser(inboxPath, originalName, hash, reason) {
  upsertFile({
    path: inboxPath,
    original_name: originalName,
    topic_t1: null, topic_t2: null,
    doc_type: 'error',
    extracted_json: null,
    entity_refs: null,
    hash_sha256: hash || await sha256(inboxPath).catch(() => 'unknown-' + Date.now()),
    size_bytes: null,
    mime_type: null,
    processed_at: new Date().toISOString(),
    source: 'drop_folder',
    status: 'needs_user',
    error_message: reason,
  });
  emit('file_errored', { name: originalName, reason, path: inboxPath });
}

// --- Core pipeline ----------------------------------------------------------

/**
 * Process a single file through the full pipeline.
 * Accepts optional dependency injection overrides for testing.
 *
 * WHY DI: tests need to pass mock classifiers/routers/upload functions without
 * touching the real filesystem, LLM calls, or GCS. Overrides are only used in
 * tests — the default production path calls the real functions.
 */
export async function processOne(inboxPath, {
  _classifyFile  = classifyFile,
  _runRouter     = runRouter,
  _uploadArchive = uploadArchive,
  _shouldSkipUpload = shouldSkipUpload,
  _importLab     = async (file) => (await import('../../scripts/import-pdf-labs.js')).importPdfLabs({ file }),
} = {}) {
  const originalName = basename(inboxPath);
  emit('file_arrived', { name: originalName, path: inboxPath });

  // Stat guard — FSEvents fires for directories too; directories crash sha256
  // via EISDIR. Also handles ENOENT races (file disappeared).
  let fileStat;
  try { fileStat = await stat(inboxPath); }
  catch {
    return; // ENOENT race — not an error
  }
  if (fileStat.isDirectory()) {
    await flagNeedsUser(inboxPath, originalName, null,
      'directories cannot be imported — drop the files inside it instead');
    return;
  }

  // 1. Stability probe — ride out partial writes.
  if (!(await settled(inboxPath))) {
    await flagNeedsUser(inboxPath, originalName, null, 'file not stable after 5 s — retry later');
    return;
  }

  // 2. Hash + dedupe.
  const hash = await sha256(inboxPath);
  const dup = getByHash(hash);
  if (dup) {
    if (dup.status === 'processed' || dup.status === 'credentials') {
      // True duplicate — clean up the new copy.
      emit('file_skipped_duplicate', { name: originalName, of: dup.path });
      await unlink(inboxPath).catch(() => {});
      return;
    }
    if (dup.status === 'upload_pending') {
      // Already processed, upload in-flight or failed. Don't reprocess.
      // Delete the new copy if it's a different path (re-drop of same content).
      if (inboxPath !== dup.path) await unlink(inboxPath).catch(() => {});
      return;
    }
  }

  // 3. Classify.
  let classification;
  try { classification = await _classifyFile(inboxPath); }
  catch (err) {
    await flagNeedsUser(inboxPath, originalName, hash, `classify: ${err.message}`);
    return;
  }
  emit('file_classified', {
    name: originalName,
    router: classification.router,
    doc_type: classification.doc_type,
  });

  // 4. Run the router (file still at inboxPath).
  let result;
  try { result = await _runRouter(classification.router, { path: inboxPath, originalName }); }
  catch (err) {
    await flagNeedsUser(inboxPath, originalName, hash, `route: ${err.message}`);
    return;
  }

  // 5. Decide final status.
  const t1 = result.topic_t1 || classification.topic_t1;
  const t2 = result.topic_t2 || classification.topic_t2;
  let status = result.status || 'processed';

  if (status === 'credentials' && result.deleted) {
    // Credentials router already removed the file. Record only.
    upsertFile({
      path: join(INDEX_DIR, 'credentials', `${hash}.meta`),
      original_name: originalName,
      topic_t1: null, topic_t2: null,
      doc_type: 'credentials',
      extracted_json: result.extracted_json,
      entity_refs: null,
      hash_sha256: hash,
      size_bytes: null,
      mime_type: null,
      processed_at: new Date().toISOString(),
      source: 'drop_folder',
      status: 'credentials',
      error_message: null,
    });
    emit('file_processed', { name: originalName, topic: 'credentials' });
    return;
  }

  // 6. Index. Normal files start as upload_pending until GCS confirms.
  // Router-blocked files keep their returned status so the user can fix/retry;
  // they must not be uploaded and deleted out from under the importer.
  let size = null;
  try { size = (await stat(inboxPath)).size; } catch {}
  upsertFile({
    path: inboxPath,
    original_name: originalName,
    topic_t1: t1, topic_t2: t2,
    doc_type: result.doc_type || classification.doc_type,
    extracted_json: result.extracted_json,
    entity_refs: result.entity_refs,
    hash_sha256: hash,
    size_bytes: size,
    mime_type: null,
    processed_at: new Date().toISOString(),
    source: 'drop_folder',
    status: status === 'needs_user' ? 'needs_user' : 'upload_pending',
    error_message: result.error || null,
  });

  emit('file_processed', {
    name: originalName,
    path: inboxPath,
    topic: [t1, t2].filter(Boolean).join('/') || UNKNOWN_TOPIC_PAIR.t1,
    doc_type: result.doc_type || classification.doc_type,
    summary: summarize(result.extracted_json),
  });

  // 7. Health lab ingestion — st_fcdbe84f AC7. Import IN-PROCESS (the controlled
  // write path: same server/worker process, same db connection) instead of a
  // detached subprocess the db-writer-policy blocks for launch. On success the
  // normal archive path still runs below, so clinical source PDFs are preserved
  // both in the health vault and in the generic import archive.
  const docType = result.doc_type || classification.doc_type;
  if (docType === 'lab_report') {
    emit('lab_import_started', { name: originalName, path: inboxPath });
    try {
      const r = await _importLab(inboxPath);
      if (r?.ok === false) {
        updateStatus(inboxPath, 'needs_user', `lab import: ${r.error}`);
        emit('file_errored', { name: originalName, reason: r.error, path: inboxPath });
        return;
      } else {
        console.info(`[drop-folder:lab-import] ${originalName}: +${r?.inserted ?? 0} data points`);
        emit('lab_import_done', { name: originalName, inserted: r?.inserted ?? 0 });
      }
    } catch (err) {
      updateStatus(inboxPath, 'needs_user', `lab import failed: ${err.message}`);
      emit('file_errored', { name: originalName, reason: err.message, path: inboxPath });
      return;
    }
  }

  // 8. Async GCS upload — fire and forget. Does not block pipeline.
  if (status !== 'needs_user' && !_shouldSkipUpload(originalName)) {
    uploadAndClean(inboxPath, originalName, _uploadArchive);
  }
}

function summarize(extractedJson) {
  if (!extractedJson) return null;
  try {
    const obj = JSON.parse(extractedJson);
    const keys = Object.keys(obj).slice(0, 5);
    return keys.length ? `${keys.join(', ')}` : null;
  } catch { return null; }
}

// --- Sequential queue -------------------------------------------------------

let working = false;

async function drain() {
  if (working) return;
  working = true;
  let results = [];
  try {
    results = await drainPassiveJobs({
      worker: DROP_FOLDER_WORKER,
      jobTypes: [DROP_FOLDER_JOB_TYPE],
      limit: DROP_FOLDER_DRAIN_LIMIT,
      handlers: {
        [DROP_FOLDER_JOB_TYPE]: async (job) => {
          const next = job.payload.path || job.target_id;
          try {
            await processOne(next);
          } catch (err) {
            console.error(`[drop-folder] processOne crashed for ${next}:`, err);
            emit('file_errored', { name: basename(next), reason: err.message });
            throw err;
          }

          const row = getByPath(next);
          if (row?.status === 'needs_user') {
            const err = new Error(row.error_message || 'drop-folder file needs user attention');
            err.quarantine = true;
            throw err;
          }
          return {
            path: next,
            status: row?.status || 'processed',
            doc_type: row?.doc_type || null,
          };
        },
      },
    });
    if (results.some((r) => r?.ok)) {
      try {
        enqueuePipelinesOnDataArrival(undefined, { source: 'drop-folder-data-arrival' });
      } catch (err) {
        // Import success should not become a user-visible failure; the
        // scheduled maintenance floor still catches a missed accelerator.
        console.warn('[drop-folder] data-arrival pipeline enqueue failed:', err.message);
      }
    }
  } finally {
    working = false;
    if (results.length >= DROP_FOLDER_DRAIN_LIMIT) scheduleDrainIfPending();
  }
}

function enqueue(path, payload = {}) {
  enqueuePassiveJob({
    jobType: DROP_FOLDER_JOB_TYPE,
    uniqueKey: passiveJobUniqueKey({
      jobType: DROP_FOLDER_JOB_TYPE,
      targetType: 'file',
      targetId: path,
    }),
    targetType: 'file',
    targetId: path,
    payload: { path, ...payload },
    priority: 90,
    maxAttempts: 5,
    timeoutMs: 60_000,
    metadata: { source: 'drop-folder-watcher' },
    requeueQuarantined: payload.replaced === true,
  });
  scheduleDrainIfPending();
}

function scheduleDrainIfPending() {
  if (working) return;
  setImmediate(() => {
    drain().catch((err) => {
      working = false;
      console.error('[drop-folder] durable drain failed:', err);
    });
  });
}

// --- Debounce per path ------------------------------------------------------

const pending = new Map();

function scheduleDebounced(path) {
  const prior = pending.get(path);
  if (prior) clearTimeout(prior);
  pending.set(path, setTimeout(() => {
    pending.delete(path);
    enqueue(path);
  }, DEBOUNCE_MS));
}

// --- Public lifecycle -------------------------------------------------------

let ac = null;

/**
 * Start watching the inbox. Idempotent — calling start() twice is a no-op.
 */
export async function start() {
  if (ac) return;

  await ensureDir(INBOX);

  ac = new AbortController();

  // Boot scan — catch files sitting in the inbox at startup.
  // upload_pending: already processed, retry upload instead of reprocessing.
  // needs_user: user owns these, skip.
  try {
    const entries = await readdir(INBOX, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const absPath = join(INBOX, e.name);
      const existing = getByPath(absPath);
      if (existing?.status === 'needs_user') {
        const currentHash = await sha256(absPath).catch(() => null);
        if (!currentHash || currentHash === existing.hash_sha256) continue;
        enqueue(absPath, { replaced: true, previous_status: 'needs_user' });
        continue;
      }
      if (existing?.status === 'upload_pending') {
        // Already processed — retry GCS upload, don't reprocess.
        if (!shouldSkipUpload(e.name)) {
          uploadAndClean(absPath, existing.original_name || e.name);
        }
        continue;
      }
      scheduleDebounced(absPath);
    }
  } catch { /* inbox may not exist yet — ensureDir above handles it */ }

  (async () => {
    try {
      for await (const evt of fsWatch(INBOX, { recursive: true, signal: ac.signal })) {
        if (!evt.filename) continue;
        const abs = join(INBOX, evt.filename);
        // Ignore hidden / partial-download markers.
        if (/\.crdownload$|\.part$|\.download$|^\._/.test(basename(abs))) continue;
        // Stat guard moved into processOne — handles EISDIR and ENOENT races.
        scheduleDebounced(abs);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.error('[drop-folder] watcher error:', err);
      }
    }
  })();

  console.info(`[drop-folder] watching ${INBOX}`);
}

/**
 * Stop the watcher. Useful for tests or graceful shutdown.
 */
export async function stop() {
  if (!ac) return;
  ac.abort();
  ac = null;
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}

/**
 * Process a single file through the full pipeline without the watcher running.
 * Used by batch ingestion scripts (e.g. scripts/ingest-source-files.js).
 */
export async function processFile(inboxPath) { return processOne(inboxPath); }
