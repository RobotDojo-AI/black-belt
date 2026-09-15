/**
 * Apple Photos local metadata sync.
 *
 * Reads metadata from the local Photos Library SQLite database. No media is
 * copied, uploaded, or modified. Rows land in the shared `photos` table under
 * account_id='apple-local' so chat can use time/place/photo context later.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import db from './db.js';
import { insertTimelineEventForDb } from './timeline-schema.js';

export const DEFAULT_APPLE_PHOTOS_DB = join(homedir(), 'Pictures', 'Photos Library.photoslibrary', 'database', 'Photos.sqlite');

function hasColumn(cols, name) {
  return cols.some((c) => c.name === name);
}

function appleDateToIso(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return new Date((n + 978307200) * 1000).toISOString();
}

export function readApplePhotosMetadata({ photosDbPath = DEFAULT_APPLE_PHOTOS_DB, limit = 1000 } = {}) {
  if (!existsSync(photosDbPath)) {
    throw new Error(`Apple Photos database not found at ${photosDbPath}`);
  }
  const photosDb = new Database(photosDbPath, { readonly: true, fileMustExist: true });
  try {
    const table = photosDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ZASSET'").get();
    if (!table) throw new Error('ZASSET table not found in Photos.sqlite');
    const cols = photosDb.prepare('PRAGMA table_info(ZASSET)').all();
    const idExpr = hasColumn(cols, 'ZUUID') ? 'ZUUID' : "CAST(Z_PK AS TEXT)";
    const filenameExpr = hasColumn(cols, 'ZFILENAME') ? 'ZFILENAME' : "''";
    const createdExpr = hasColumn(cols, 'ZDATECREATED') ? 'ZDATECREATED' : hasColumn(cols, 'ZADDEDDATE') ? 'ZADDEDDATE' : 'NULL';
    const widthExpr = hasColumn(cols, 'ZWIDTH') ? 'ZWIDTH' : 'NULL';
    const heightExpr = hasColumn(cols, 'ZHEIGHT') ? 'ZHEIGHT' : 'NULL';
    const rows = photosDb.prepare(`
      SELECT ${idExpr} AS id,
             ${filenameExpr} AS filename,
             ${createdExpr} AS creation_raw,
             ${widthExpr} AS width,
             ${heightExpr} AS height
      FROM ZASSET
      ORDER BY Z_PK DESC
      LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 1000, 1), 10000));
    return rows.map((r) => ({
      id: `apple:${r.id}`,
      account_id: 'apple-local',
      filename: r.filename || '',
      mime_type: '',
      creation_time: appleDateToIso(r.creation_raw),
      width: r.width || null,
      height: r.height || null,
      product_url: null,
      description: null,
    }));
  } finally {
    photosDb.close();
  }
}

export function syncApplePhotosMetadata({ photosDbPath = DEFAULT_APPLE_PHOTOS_DB, limit = 1000, database = db } = {}) {
  const rows = readApplePhotosMetadata({ photosDbPath, limit });
  const upsert = database.prepare(`
    INSERT INTO photos (id, account_id, filename, mime_type, creation_time, width, height, product_url, description, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      filename = excluded.filename,
      creation_time = excluded.creation_time,
      width = excluded.width,
      height = excluded.height,
      indexed_at = excluded.indexed_at
  `);
  const tx = database.transaction((items) => {
    for (const row of items) {
      upsert.run(row.id, row.account_id, row.filename, row.mime_type, row.creation_time, row.width, row.height, row.product_url, row.description);
      if (row.creation_time) {
        insertTimelineEventForDb(database, {
          sourceType: 'photo',
          sourceId: row.id,
          eventDate: row.creation_time,
          eventType: 'photo',
          summary: row.filename || 'Photo',
          content: `${row.filename || ''}\n${row.creation_time}`,
          metadata: { account_id: row.account_id, mime_type: row.mime_type || null, source: 'apple-local' },
        });
      }
    }
  });
  tx(rows);
  return { ok: true, imported: rows.length };
}
