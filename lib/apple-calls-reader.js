/**
 * Local macOS Call / FaceTime history reader — st_fcdbe84f WS7.
 *
 * Reads CallHistoryDB/CallHistory.storedata (Full Disk Access) and upserts a
 * who/when/duration timeline into the `calls` table. Read-only on the store.
 * Graceful when the store is absent or empty (e.g. a machine with no call data)
 * so a future multi-machine sync just lights it up.
 */
import Database from 'better-sqlite3';
import db from './db.js';
import { recordCallInteraction } from './people-seed.js';
import { insertTimelineEventForDb } from './timeline-schema.js';

const MAC_EPOCH_OFFSET = 978307200; // CFAbsoluteTime (2001) → Unix (1970), seconds

// Store path resolution lives in lib/apple-store-paths.js (st_fd14cdd4 — the
// integration registry needs it without importing this module's db side).
// Re-exported for existing callers.
export { appleCallStorePath } from './apple-store-paths.js';
import { appleCallStorePath } from './apple-store-paths.js';

function macToIso(s) {
  if (s == null || !Number.isFinite(s)) return '';
  const d = new Date((s + MAC_EPOCH_OFFSET) * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

// ZADDRESS is often a BLOB holding the phone number bytes; coerce to a string.
function asText(v) {
  if (v == null) return '';
  if (Buffer.isBuffer(v)) return v.toString('utf8').replace(/\u0000/g, '').trim();
  return String(v).trim();
}

const upsert = db.prepare(`
  INSERT INTO calls (id, address, name, direction, answered, duration_sec, service, call_time, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'apple-local')
  ON CONFLICT(id) DO UPDATE SET
    address=excluded.address, name=excluded.name, direction=excluded.direction,
    answered=excluded.answered, duration_sec=excluded.duration_sec,
    service=excluded.service, call_time=excluded.call_time, synced_at=datetime('now')
`);

function recordCallTimeline(targetDb, { id, address, name, direction, answered, durationSec, service, callTime }) {
  try {
    insertTimelineEventForDb(targetDb, {
      sourceType: 'call',
      sourceId: id,
      eventDate: callTime,
      eventType: 'call',
      summary: `${direction || 'call'} call with ${name || address || 'unknown'}`,
      content: `${name || ''}\n${address || ''}\n${direction || ''}\n${service || ''}`,
      metadata: {
        direction: direction || null,
        answered: !!answered,
        duration_sec: durationSec || 0,
        service: service || null,
        source: 'apple-local',
      },
    });
  } catch { /* projection only — recalc can rebuild from calls */ }
}

export function syncAppleCalls({ storePath = appleCallStorePath(), targetDb = db } = {}) {
  const stats = { synced: 0, store: storePath };
  if (!storePath) { stats.error = 'no_local_call_store'; return stats; }

  let src;
  try { src = new Database(storePath, { readonly: true, fileMustExist: true }); }
  catch (err) { stats.error = `open_failed: ${err.message}`; return stats; }

  const stmt = targetDb === db ? upsert : targetDb.prepare(upsert.source);
  try {
    const rows = src.prepare(`
      SELECT Z_PK AS pk, ZUNIQUE_ID AS uid, ZADDRESS AS address, ZNAME AS name,
             ZORIGINATED AS originated, ZANSWERED AS answered, ZDURATION AS duration,
             ZSERVICE_PROVIDER AS service, ZDATE AS date
      FROM ZCALLRECORD WHERE ZDATE IS NOT NULL
    `).all();
    const tx = targetDb.transaction(() => {
      for (const r of rows) {
        const t = macToIso(r.date);
        if (!t) continue;
        const id = `apple:${asText(r.uid) || r.pk}`;
        const address = asText(r.address);
        const name = asText(r.name);
        const direction = r.originated ? 'outgoing' : 'incoming';
        const service = asText(r.service);
        const durationSec = Math.round(r.duration || 0);
        stmt.run(
          id,
          address,
          name,
          direction,
          r.answered ? 1 : 0,
          durationSec,
          service,
          t,
        );
        stats.synced++;
        recordCallTimeline(targetDb, {
          id,
          address,
          name,
          direction,
          answered: r.answered ? 1 : 0,
          durationSec,
          service,
          callTime: t,
        });
        // st_fd14cdd4 AC6: phone → create-or-link seeding + one
        // person_interactions row (channel 'call') at read. normalizePhone
        // inside the module rejects <7-digit short codes; idempotent via the
        // unique source_id `call:{id}`.
        try {
          recordCallInteraction(targetDb, {
            callId: id,
            phone: address,
            name,
            direction,
            dateIso: t,
          });
        } catch { /* additive — never fail the call read */ }
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
