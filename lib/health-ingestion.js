/**
 * Health ingestion ledger — tracks which files/sources have been imported
 * to prevent re-importing the same data.
 *
 * Schema is in lib/migrations/022_health_ingestion_log.sql and applied
 * automatically via applySqlMigrations() in lib/db.js on server boot.
 */

import { randomUUID } from 'node:crypto';
import db from './db.js';

let _stmts = null;
let _columns = null;
function columns() {
  if (_columns) return _columns;
  try {
    _columns = new Set(db.prepare('PRAGMA table_info(health_ingestion_log)').all().map(row => row.name));
  } catch {
    _columns = new Set();
  }
  return _columns;
}

function supports(column) {
  return columns().has(column);
}

function normalizeStatus(status) {
  const value = String(status || 'ok').trim().toLowerCase();
  if (['ok', 'no_data', 'failed', 'partial'].includes(value)) return value;
  return 'failed';
}

function serializeMetadata(metadata) {
  if (metadata == null || metadata === '') return null;
  if (typeof metadata === 'string') return metadata;
  try {
    return JSON.stringify(metadata);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function retryableStatus(row) {
  return ['failed', 'error'].includes(String(row?.status || '').toLowerCase());
}

function stmts() {
  if (_stmts) return _stmts;
  const hasStatus = supports('status');
  const hasError = supports('error');
  const hasMetadata = supports('metadata_json');
  const insertColumns = ['id', 'source', 'file_path', 'ingested_date', 'record_count'];
  const insertValues = ['?', '?', '?', '?', '?'];
  if (hasStatus) { insertColumns.push('status'); insertValues.push('?'); }
  if (hasError) { insertColumns.push('error'); insertValues.push('?'); }
  if (hasMetadata) { insertColumns.push('metadata_json'); insertValues.push('?'); }

  const updateParts = [
    'ingested_date = excluded.ingested_date',
    `record_count = CASE
          WHEN excluded.record_count > 0 THEN excluded.record_count
          ELSE health_ingestion_log.record_count
        END`,
    `created_at = CASE
          WHEN excluded.record_count > 0 THEN datetime('now')
          ${hasStatus ? "WHEN excluded.status IN ('failed', 'no_data', 'partial') THEN datetime('now')" : ''}
          ELSE health_ingestion_log.created_at
        END`,
  ];
  if (hasStatus) updateParts.push('status = excluded.status');
  if (hasError) updateParts.push('error = excluded.error');
  if (hasMetadata) updateParts.push('metadata_json = excluded.metadata_json');

  const selectColumns = ['id', 'source', 'file_path', 'ingested_date', 'record_count', 'created_at'];
  if (hasStatus) selectColumns.push('status');
  if (hasError) selectColumns.push('error');
  if (hasMetadata) selectColumns.push('metadata_json');

  _stmts = {
    hasStatus,
    hasError,
    hasMetadata,
    record: db.prepare(`
      INSERT INTO health_ingestion_log (id, source, file_path, ingested_date, record_count)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source, file_path) DO UPDATE SET
        ${updateParts.join(',\n        ')}
    `.replace(
      'health_ingestion_log (id, source, file_path, ingested_date, record_count)',
      `health_ingestion_log (${insertColumns.join(', ')})`
    ).replace(
      'VALUES (?, ?, ?, ?, ?)',
      `VALUES (${insertValues.join(', ')})`
    )),
    check: db.prepare(`
      SELECT ${selectColumns.join(', ')}
      FROM health_ingestion_log
      WHERE source = ? AND (file_path = ? OR (file_path IS NULL AND ? IS NULL))
      ORDER BY created_at DESC LIMIT 1
    `),
    log: db.prepare(`
      SELECT ${selectColumns.join(', ')}
      FROM health_ingestion_log
      ORDER BY created_at DESC LIMIT 100
    `),
  };
  return _stmts;
}

/**
 * Record a completed ingestion run.
 * @param {object} opts
 * @param {string} opts.source - e.g. 'apple-health-xml', 'pdf-lab'
 * @param {string} [opts.path] - absolute file path (null for directory scans)
 * @param {string} [opts.date] - ingestion date YYYY-MM-DD (defaults to today)
 * @param {number} [opts.count] - number of records ingested
 * @param {string} [opts.status] - ok, no_data, failed, or partial
 * @param {string} [opts.error] - failure/no-data reason
 * @param {object|string} [opts.metadata] - structured import summary
 */
export async function recordIngestion({ source, path = null, date = null, count = 0, status = 'ok', error = null, metadata = null }) {
  const ingested_date = date || new Date().toISOString().slice(0, 10);
  const s = stmts();
  const args = [randomUUID(), source, path || null, ingested_date, count];
  if (s.hasStatus) args.push(normalizeStatus(status));
  if (s.hasError) args.push(error ? String(error).slice(0, 1000) : null);
  if (s.hasMetadata) args.push(serializeMetadata(metadata));
  s.record.run(...args);
}

/**
 * Check if a source/file has already been ingested.
 * @param {object} opts
 * @param {string} opts.source
 * @param {string} [opts.path]
 * @returns {object|null} The existing log row, or null if not yet ingested
 */
export async function wasIngested({ source, path = null }) {
  const row = stmts().check.get(source, path || null, path || null) || null;
  if (retryableStatus(row)) return null;
  return row;
}

/**
 * Return the most recent ingestion log entries.
 * @returns {Array}
 */
export async function getIngestionLog() {
  return stmts().log.all();
}
