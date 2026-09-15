/**
 * Local macOS Notes reader — st_fcdbe84f WS7.
 *
 * Reads the Notes group-container NoteStore.sqlite (Full Disk Access) and upserts
 * into the `notes` table. Title/snippet/dates are plain columns; the note body is
 * a gzip-compressed protobuf — we gunzip and take a best-effort text extraction
 * (refined when there is real local data to validate). Encrypted notes keep their
 * title/snippet but skip the body. Graceful when absent or empty so a future
 * multi-machine sync lights it up.
 */
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import db from './db.js';
import { insertTimelineEventForDb } from './timeline-schema.js';

const MAC_EPOCH_OFFSET = 978307200;

// Store path resolution lives in lib/apple-store-paths.js (st_fd14cdd4 — the
// integration registry needs it without importing this module's db side).
// Re-exported for existing callers.
export { appleNotesStorePath } from './apple-store-paths.js';
import { appleNotesStorePath } from './apple-store-paths.js';

function macToIso(s) {
  if (s == null || !Number.isFinite(s)) return '';
  const d = new Date((s + MAC_EPOCH_OFFSET) * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** Best-effort note-body text from the gzipped Apple Notes protobuf. */
export function extractNoteText(zdata) {
  if (!Buffer.isBuffer(zdata) || !zdata.length) return '';
  let buf;
  try { buf = gunzipSync(zdata); } catch { return ''; }
  // The body is a protobuf; the note text is the dominant readable string. Take
  // the longest printable run (skips the small style/attribute control blobs).
  const runs = buf.toString('utf8').match(/[\t\n\r\x20-\x7E -￿]{4,}/g) || [];
  if (!runs.length) return '';
  runs.sort((a, b) => b.length - a.length);
  return runs[0].replace(/�/g, '').trim().slice(0, 8000);
}

const upsert = db.prepare(`
  INSERT INTO notes (id, title, snippet, body, folder, created_at, modified_at, source, is_shared)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'apple-local', ?)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title, snippet=excluded.snippet, body=excluded.body,
    folder=excluded.folder, created_at=excluded.created_at,
    modified_at=excluded.modified_at, is_shared=excluded.is_shared,
    synced_at=datetime('now')
`);

function recordNoteTimeline(targetDb, { id, title, snippet, body, folder, createdAt, modifiedAt }) {
  const eventDate = modifiedAt || createdAt;
  if (!eventDate) return;
  try {
    insertTimelineEventForDb(targetDb, {
      sourceType: 'note',
      sourceId: id,
      eventDate,
      eventType: 'note',
      summary: title || snippet || body || 'Note',
      content: `${title || ''}\n${snippet || ''}\n${body || ''}`,
      metadata: {
        created_at: createdAt || null,
        folder: folder || null,
        source: 'apple-local',
      },
    });
  } catch { /* projection only — recalc can rebuild from notes */ }
}

export function syncAppleNotes({ storePath = appleNotesStorePath(), targetDb = db } = {}) {
  const stats = { synced: 0, store: storePath };
  if (!storePath) { stats.error = 'no_local_notes_store'; return stats; }

  let src;
  try { src = new Database(storePath, { readonly: true, fileMustExist: true }); }
  catch (err) { stats.error = `open_failed: ${err.message}`; return stats; }

  const stmt = targetDb === db ? upsert : targetDb.prepare(upsert.source);
  try {
    // st_f67bc2eb — shared-note marker, BEST-EFFORT (defense-in-depth only).
    // A shared note can contain third-party-authored text, so the relation
    // mining sweep skips is_shared=1 rows. Apple's NoteStore represents
    // sharing via a CloudKit share object reference; the column name has
    // moved across macOS versions, so probe for a known marker column and
    // degrade to 0 when absent. The HARD guard is elsewhere: a notes-only
    // evidence cluster never writes an edge (lib/relation-mine.js).
    const objCols = new Set(src.prepare("PRAGMA table_info('ZICCLOUDSYNCINGOBJECT')").all().map((c) => c.name));
    const shareCol = ['ZSERVERSHAREDATA', 'ZSERVERSHARE', 'ZISSHAREDVIACLOUDKIT', 'ZSHARE'].find((c) => objCols.has(c));
    const shareSelect = shareCol ? `o.${shareCol} AS share_marker,` : "NULL AS share_marker,";
    const rows = src.prepare(`
      SELECT o.Z_PK AS pk, o.ZTITLE1 AS title, o.ZSNIPPET AS snippet, o.ZFOLDER AS folder,
             o.ZCREATIONDATE1 AS created, o.ZMODIFICATIONDATE1 AS modified,
             ${shareSelect}
             d.ZDATA AS zdata, d.ZCRYPTOINITIALIZATIONVECTOR AS iv
      FROM ZICCLOUDSYNCINGOBJECT o
      LEFT JOIN ZICNOTEDATA d ON o.ZNOTEDATA = d.Z_PK
      WHERE o.ZTITLE1 IS NOT NULL OR d.ZDATA IS NOT NULL
    `).all();
    const tx = targetDb.transaction(() => {
      for (const r of rows) {
        const title = (r.title || '').trim();
        const snippet = (r.snippet || '').trim();
        if (!title && !snippet && !r.zdata) continue;
        const body = r.iv ? '[encrypted]' : extractNoteText(r.zdata);
        const id = `apple:${r.pk}`;
        const folder = String(r.folder ?? '');
        const createdAt = macToIso(r.created);
        const modifiedAt = macToIso(r.modified);
        const isShared = r.share_marker != null && r.share_marker !== 0 ? 1 : 0;
        stmt.run(
          id, title, snippet, body,
          folder, createdAt, modifiedAt, isShared,
        );
        recordNoteTimeline(targetDb, { id, title, snippet, body, folder, createdAt, modifiedAt });
        stats.synced++;
      }
    });
    tx();
  } catch (err) {
    stats.error = `read_failed: ${err.message}`;
  } finally {
    src.close();
  }
  return stats;
}
