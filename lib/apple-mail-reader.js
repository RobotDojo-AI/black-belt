/**
 * Local macOS Mail reader — st_fcdbe84f WS7.
 *
 * Reads the Apple Mail "Envelope Index" SQLite (Full Disk Access) for message
 * metadata — sender, subject, date, mailbox, read/flagged — and upserts into the
 * shared `emails` table with source='apple-local'. This captures ALL local mail
 * accounts (incl. ones not connected via OAuth). Bodies live in per-message .emlx
 * files / server-side; we store metadata + any cached snippet here and leave full
 * bodies to the OAuth sync. Graceful when no local mail store exists (this Mac
 * has none — mail is server-side), so a multi-machine sync lights it up.
 */
import Database from 'better-sqlite3';
import db from './db.js';
import { appleMailEnvelopePath } from './apple-store-paths.js';
import { recordEmailParticipants } from './people-seed.js';

const MAC_EPOCH_OFFSET = 978307200;

// Store path resolution lives in lib/apple-store-paths.js (st_fd14cdd4 — the
// integration registry needs it without importing this module's db side).
// Re-exported for existing callers.
export { appleMailEnvelopePath } from './apple-store-paths.js';

// Envelope Index dates are usually Unix epoch seconds; older builds used
// CFAbsoluteTime (2001). Disambiguate by magnitude.
function toIso(n) {
  if (n == null || !Number.isFinite(n) || n <= 0) return '';
  const unix = n < 1_000_000_000 ? n + MAC_EPOCH_OFFSET : n;
  const d = new Date(unix * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

const upsert = db.prepare(`
  INSERT INTO emails (id, thread_id, subject, sender, sender_email, snippet, body_text,
                      received_at, is_read, is_starred, account_id, synced_at)
  VALUES (?, '', ?, ?, ?, ?, '', ?, ?, ?, NULL, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    subject=excluded.subject, sender=excluded.sender, sender_email=excluded.sender_email,
    snippet=excluded.snippet, received_at=excluded.received_at,
    is_read=excluded.is_read, is_starred=excluded.is_starred, synced_at=datetime('now')
`);

export function syncAppleMail({ storePath = appleMailEnvelopePath(), targetDb = db, limit = 50000 } = {}) {
  const stats = { synced: 0, store: storePath };
  if (!storePath) { stats.error = 'no_local_mail_store'; return stats; }

  let src;
  try { src = new Database(storePath, { readonly: true, fileMustExist: true }); }
  catch (err) { stats.error = `open_failed: ${err.message}`; return stats; }

  const stmt = targetDb === db ? upsert : targetDb.prepare(upsert.source);
  try {
    // Tolerant join — the Envelope Index schema is stable across recent macOS:
    // messages(sender→addresses, subject→subjects), addresses(address, comment).
    const rows = src.prepare(`
      SELECT m.ROWID AS rowid, m.message_id AS mid, s.subject AS subject,
             a.address AS email, a.comment AS display,
             m.date_received AS received, m.read AS read, m.flagged AS flagged
      FROM messages m
      LEFT JOIN subjects  s ON m.subject = s.ROWID
      LEFT JOIN addresses a ON m.sender  = a.ROWID
      ORDER BY m.date_received DESC
      LIMIT ?
    `).all(limit);
    const tx = targetDb.transaction(() => {
      for (const r of rows) {
        const id = `apple-mail:${r.mid || r.rowid}`;
        const senderEmail = (r.email || '').trim();
        const senderName = (r.display || r.email || '').trim();
        stmt.run(
          id,
          (r.subject || '').trim(),
          senderName,
          senderEmail,
          (r.subject || '').trim().slice(0, 200),
          toIso(r.received),
          r.read ? 1 : 0,
          r.flagged ? 1 : 0,
        );
        stats.synced++;
        // st_fd14cdd4 AC6: sender → participants + create-or-link seeding at
        // read. The Envelope Index carries no List-* headers for newsletter
        // detection; the role-account blocklist inside the seeding module
        // (noreply@/info@/…) is the guard for this source.
        try {
          recordEmailParticipants(targetDb, id, {
            sender: { email: senderEmail, name: senderName },
          }, { isNewsletter: false, source: 'email' });
        } catch { /* additive index — never fail the mail read */ }
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
