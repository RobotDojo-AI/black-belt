/**
 * Drop-folder index — CRUD over the `drop_folder_files` table.
 *
 * Uses the shared SQLite connection from `lib/db.js` (robotdojo.db).
 * Migration: lib/migrations/006_files.sql.
 *
 * Name collision: the legacy upstream dojo DB (miyagi.db) has an unrelated
 * `files` table (SHA-256-of-disk file index). Ours is namespaced to
 * `drop_folder_files`.
 */

import db from '../db.js';
import { topicFromPath } from './paths.js';

// Keep FTS in sync with the row. Called by upsert/move/delete helpers so
// callers never have to think about it.
function syncFts({ path, original_name, extracted_json }) {
  db.prepare('DELETE FROM drop_folder_files_fts WHERE path = ?').run(path);
  db.prepare(
    'INSERT INTO drop_folder_files_fts (path, original_name, extracted_json) VALUES (?, ?, ?)',
  ).run(path, original_name || '', extracted_json || '');
}

const upsertStmt = db.prepare(`
  INSERT INTO drop_folder_files (
    path, original_name, topic_t1, topic_t2, topic_t3, doc_type,
    extracted_json, entity_refs, hash_sha256, size_bytes, mime_type,
    processed_at, source, status, error_message, classify_confidence
  ) VALUES (
    @path, @original_name, @topic_t1, @topic_t2, @topic_t3, @doc_type,
    @extracted_json, @entity_refs, @hash_sha256, @size_bytes, @mime_type,
    @processed_at, @source, @status, @error_message, @classify_confidence
  )
  ON CONFLICT(path) DO UPDATE SET
    original_name = excluded.original_name,
    topic_t1      = excluded.topic_t1,
    topic_t2      = excluded.topic_t2,
    topic_t3      = excluded.topic_t3,
    doc_type      = excluded.doc_type,
    extracted_json = excluded.extracted_json,
    entity_refs   = excluded.entity_refs,
    hash_sha256   = excluded.hash_sha256,
    size_bytes    = excluded.size_bytes,
    mime_type     = excluded.mime_type,
    processed_at  = excluded.processed_at,
    source        = excluded.source,
    status        = excluded.status,
    error_message = excluded.error_message,
    classify_confidence = excluded.classify_confidence
`);

const getByHashStmt = db.prepare('SELECT * FROM drop_folder_files WHERE hash_sha256 = ?');
const getByPathStmt = db.prepare('SELECT * FROM drop_folder_files WHERE path = ?');

const updatePathStmt = db.prepare('UPDATE drop_folder_files SET path = ? WHERE path = ?');

const deleteStmt = db.prepare('DELETE FROM drop_folder_files WHERE path = ?');

const searchStmt = db.prepare(`
  SELECT f.*
    FROM drop_folder_files_fts fts
    JOIN drop_folder_files f ON f.path = fts.path
   WHERE drop_folder_files_fts MATCH ?
   ORDER BY f.processed_at DESC
   LIMIT ?
`);

/**
 * Insert or update a row. Keeps FTS in sync. Returns the stored row.
 */
export function upsertFile(row) {
  const payload = {
    path: row.path,
    original_name: row.original_name || null,
    topic_t1: row.topic_t1 || null,
    topic_t2: row.topic_t2 || null,
    topic_t3: row.topic_t3 || null,
    doc_type: row.doc_type || null,
    extracted_json: row.extracted_json || null,
    entity_refs: row.entity_refs || null,
    hash_sha256: row.hash_sha256,
    size_bytes: row.size_bytes ?? null,
    mime_type: row.mime_type || null,
    processed_at: row.processed_at || new Date().toISOString(),
    source: row.source || 'drop_folder',
    status: row.status || 'processed',
    error_message: row.error_message || null,
    classify_confidence: row.classify_confidence ?? null,
  };
  upsertStmt.run(payload);
  syncFts(payload);
  return getByPathStmt.get(payload.path);
}

export function getByHash(hash) { return getByHashStmt.get(hash); }
export function getByPath(path) { return getByPathStmt.get(path); }

export function updateStatus(path, status, errorMessage = null) {
  db.prepare('UPDATE drop_folder_files SET status = ?, error_message = COALESCE(?, error_message) WHERE path = ?')
    .run(status, errorMessage, path);
}

/**
 * Move an existing row from oldPath → newPath. Used by reclassify.
 */
export function relocate(oldPath, newPath) {
  updatePathStmt.run(newPath, oldPath);
  const existing = getByPathStmt.get(newPath);
  if (existing) syncFts(existing);
  return existing;
}

export function deleteFile(path) {
  db.prepare('DELETE FROM drop_folder_files_fts WHERE path = ?').run(path);
  deleteStmt.run(path);
}

/**
 * List files filtered by topic / doc_type. All filters are optional.
 */
export function listFiles({ topic_t1, topic_t2, topic_t3, doc_type, limit = 100 } = {}) {
  const clauses = [];
  const args = [];
  if (topic_t1) { clauses.push('topic_t1 = ?'); args.push(topic_t1); }
  if (topic_t2) { clauses.push('topic_t2 = ?'); args.push(topic_t2); }
  if (topic_t3) { clauses.push('topic_t3 = ?'); args.push(topic_t3); }
  if (doc_type) { clauses.push('doc_type = ?'); args.push(doc_type); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `SELECT * FROM drop_folder_files ${where} ORDER BY processed_at DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit);
}

export function searchFiles(query, { limit = 25 } = {}) {
  if (!query || !query.trim()) return [];
  return searchStmt.all(query.trim(), limit);
}
