/**
 * iMessage — read-only bridge over Apple's ~/Library/Messages/chat.db.
 *
 * Apple's chat.db is a SQLite store managed by the Messages app. Robot Dojo
 * reads it read-only, converts Apple-epoch timestamps (seconds since
 * 2001-01-01) to Unix epoch, normalizes handles (email/phone) via the shared
 * entity-matcher helpers, then bridges each (person, day) pair into the
 * robotdojo `person_interactions` table plus an `imessages` rollup for audit.
 *
 * Full Disk Access is required — opening chat.db without it fails with
 * "operation not permitted".
 *
 * Why (handle, day) dedup:
 *   At message granularity a single thread can produce thousands of rows a
 *   day. Downstream scoring cares about days-of-contact, not message volume,
 *   so we collapse to handle+date before writing person_interactions.
 *
 * Why create-or-link resolution (st_fd14cdd4 AC6, was link-only):
 *   Email addresses and phone numbers are seeds everywhere — a text thread
 *   with an unknown number is a real relationship signal the graph must hold.
 *   Guards: normalizePhone rejects <7-digit short codes (2FA/carrier codes),
 *   the role-account blocklist rejects noreply@-class emails, and group-chat
 *   handles never resolve. maint-clean's orphan archive is the backstop for
 *   residual noise. Revert lever: the `source: 'imessage'` tag on every
 *   identifier makes a one-line return to link-only possible for this source
 *   without touching any other path.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import db from './db.js';
import { normalizeEmail, normalizePhone, resolvePerson } from './entity-resolve.js';
import { insertTimelineEvent } from './timeline-schema.js';

/** Seconds between Unix epoch (1970-01-01) and Apple epoch (2001-01-01). */
export const APPLE_EPOCH_OFFSET = 978307200;

/** Group chat style code in Apple's `chat` table. */
export const GROUP_CHAT_STYLE = 43;

export const CHAT_DB_PATH = join(homedir(), 'Library', 'Messages', 'chat.db');

const WATERMARK_KEY = 'imessage:last_synced_apple_ns';

// --- Robot Dojo-side schema (imessages rollup + kv_store watermark) -------

db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS imessages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    handle         TEXT NOT NULL,
    handle_kind    TEXT NOT NULL,        -- 'email' | 'phone' | 'other'
    person_id      TEXT,                 -- null if unresolved
    is_group       INTEGER NOT NULL DEFAULT 0,
    date           TEXT NOT NULL,        -- YYYY-MM-DD (local Apple-epoch day)
    sent_count     INTEGER NOT NULL DEFAULT 0,
    received_count INTEGER NOT NULL DEFAULT 0,
    last_apple_ns  INTEGER NOT NULL,     -- high-water per (handle, date)
    source_id      TEXT NOT NULL UNIQUE, -- imessage:<handle>:<date>
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_imessages_handle  ON imessages(handle);
  CREATE INDEX IF NOT EXISTS idx_imessages_person  ON imessages(person_id);
  CREATE INDEX IF NOT EXISTS idx_imessages_date    ON imessages(date);
  CREATE INDEX IF NOT EXISTS idx_imessages_group   ON imessages(is_group);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_source_unique
    ON person_interactions(source_id)
    WHERE source_id IS NOT NULL;
`);

const stmts = {
  getKv: db.prepare('SELECT value FROM kv_store WHERE key = ?'),
  setKv: db.prepare(`
    INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `),
  upsertImessage: db.prepare(`
    INSERT INTO imessages
      (handle, handle_kind, person_id, is_group, date,
       sent_count, received_count, last_apple_ns, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      sent_count     = imessages.sent_count + excluded.sent_count,
      received_count = imessages.received_count + excluded.received_count,
      last_apple_ns  = MAX(imessages.last_apple_ns, excluded.last_apple_ns),
      person_id      = COALESCE(imessages.person_id, excluded.person_id),
      updated_at     = datetime('now')
  `),
  insertInteraction: db.prepare(`
    INSERT OR IGNORE INTO person_interactions
      (person_id, channel, direction, date, source_id, metadata)
    VALUES (?, 'imessage', ?, ?, ?, ?)
  `),
};

// --- Apple epoch math ------------------------------------------------------

/**
 * Apple `message.date` is stored as nanoseconds since 2001-01-01 UTC in
 * macOS 10.13+ (older rows are seconds). Both shapes coexist in a mature
 * chat.db, so detect by magnitude.
 *
 * @param {number|bigint} rawDate
 * @returns {number} Unix epoch milliseconds.
 */
export function appleDateToUnixMs(rawDate) {
  if (rawDate === null || rawDate === undefined) return 0;
  const n = typeof rawDate === 'bigint' ? Number(rawDate) : rawDate;
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Nanoseconds path: post-High Sierra. 1e17 is ~2002-12 in ns; safe threshold.
  const seconds = n > 1e11 ? n / 1e9 : n;
  return (seconds + APPLE_EPOCH_OFFSET) * 1000;
}

/** @returns {string} Apple-local YYYY-MM-DD for a raw chat.db date. */
export function appleDateToDayKey(rawDate) {
  const ms = appleDateToUnixMs(rawDate);
  if (!ms) return '1970-01-01';
  return new Date(ms).toISOString().slice(0, 10);
}

// --- Handle classification -------------------------------------------------

/**
 * Classify + normalize an Apple handle id. Returns `{ kind, value }` or
 * `null` for unusable handles (empty / chat-room IDs / group identifiers).
 */
export function classifyHandle(rawHandle) {
  if (!rawHandle) return null;
  const raw = String(rawHandle).trim();
  if (!raw || raw === 'unknown') return null;
  // Group chat identifiers in Apple's store look like 'chat123456…' — skip.
  if (/^chat\d/i.test(raw)) return null;

  if (raw.includes('@')) {
    const email = normalizeEmail(raw);
    return email ? { kind: 'email', value: email } : null;
  }
  const phone = normalizePhone(raw);
  if (phone) return { kind: 'phone', value: phone };
  // Non-US phone or other — keep raw lowercased so the rollup still tracks it.
  return { kind: 'other', value: raw.toLowerCase() };
}

// --- Watermark -------------------------------------------------------------

/** @returns {bigint} Apple nanoseconds of last synced message (0 on first run). */
export function getWatermark() {
  const row = stmts.getKv.get(WATERMARK_KEY);
  if (!row) return 0n;
  try { return BigInt(row.value); } catch { return 0n; }
}

export function setWatermark(appleNs) {
  const asStr = typeof appleNs === 'bigint' ? appleNs.toString() : String(appleNs);
  stmts.setKv.run(WATERMARK_KEY, asStr);
}

export function resolveSinceAppleNs({ since = null, resetWatermark = false } = {}) {
  if (resetWatermark) {
    setWatermark(0n);
    return 0n;
  }
  if (since) {
    const ms = Date.parse(since);
    if (!Number.isFinite(ms)) {
      throw new Error(`iMessage since "${since}" is not a parseable date`);
    }
    const unixSec = Math.floor(ms / 1000);
    const appleSec = unixSec - APPLE_EPOCH_OFFSET;
    return appleSec > 0 ? BigInt(appleSec) * 1_000_000_000n : 0n;
  }
  return getWatermark();
}

// --- Chat DB reader --------------------------------------------------------

/**
 * Open ~/Library/Messages/chat.db read-only. Throws a legible error when
 * Full Disk Access is missing.
 */
export function openChatDb(path = CHAT_DB_PATH) {
  try {
    return new Database(path, { readonly: true, fileMustExist: true });
  } catch (err) {
    if (/operation not permitted/i.test(err.message)) {
      throw new Error(
        `Cannot open ${path}: macOS Full Disk Access required. ` +
        `Grant it in System Settings → Privacy & Security → Full Disk Access, ` +
        `then re-run.`,
      );
    }
    throw err;
  }
}

/**
 * Pull raw messages from chat.db. Apple joins: message → handle (sender id),
 * message → chat_message_join → chat (for group/style).
 *
 * @param {Database} chatDb
 * @param {{ sinceAppleNs?: bigint, limit?: number|null }} opts
 */
export function readMessages(chatDb, { sinceAppleNs = 0n, limit = null } = {}) {
  const params = [];
  let where = "m.text IS NOT NULL AND LENGTH(m.text) > 0";
  if (sinceAppleNs > 0n) {
    where += ' AND m.date > ?';
    params.push(sinceAppleNs.toString()); // better-sqlite3 binds strings as int64 OK
  }
  let sql = `
    SELECT
      m.ROWID                                   AS id,
      m.is_from_me                              AS is_from_me,
      m.date                                    AS apple_date,
      COALESCE(h.id, c.chat_identifier)         AS handle,
      c.style                                   AS chat_style,
      c.ROWID                                   AS chat_id
    FROM message m
    LEFT JOIN handle h             ON m.handle_id = h.ROWID
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c               ON c.ROWID = cmj.chat_id
    WHERE ${where}
    ORDER BY m.date ASC
  `;
  if (typeof limit === 'number' && limit > 0) sql += ` LIMIT ${Math.floor(limit)}`;
  return chatDb.prepare(sql).all(...params);
}

// --- Aggregation + resolution ---------------------------------------------

/**
 * Collapse raw message rows to `(handle, day)` pairs. Returns a Map keyed by
 * `${value}|${date}` so the caller can iterate deterministically. Also
 * tracks the max Apple-ns seen so the caller can advance the watermark even
 * when every row was skipped.
 */
export function aggregateByHandleDay(rows) {
  const pairs = new Map();
  let maxAppleNs = 0n;

  for (const r of rows) {
    const rawNs = r.apple_date;
    if (rawNs !== null && rawNs !== undefined) {
      const asBig = typeof rawNs === 'bigint' ? rawNs : BigInt(Math.trunc(Number(rawNs)));
      if (asBig > maxAppleNs) maxAppleNs = asBig;
    }

    const classified = classifyHandle(r.handle);
    if (!classified) continue;
    const isGroup = r.chat_style === GROUP_CHAT_STYLE;
    const date = appleDateToDayKey(rawNs);
    const key = `${classified.value}|${date}|${isGroup ? 1 : 0}`;

    let entry = pairs.get(key);
    if (!entry) {
      entry = {
        handle: classified.value,
        kind: classified.kind,
        date,
        isGroup,
        sent: 0,
        received: 0,
        lastAppleNs: 0n,
      };
      pairs.set(key, entry);
    }
    if (r.is_from_me) entry.sent++;
    else entry.received++;

    const thisNs = typeof rawNs === 'bigint' ? rawNs : BigInt(Math.trunc(Number(rawNs || 0)));
    if (thisNs > entry.lastAppleNs) entry.lastAppleNs = thisNs;
  }

  return { pairs, maxAppleNs };
}

/**
 * Resolve a handle-day entry to a person via the shared create-or-link
 * resolver (st_fd14cdd4 AC6 — upgraded from link-only so unknown handles
 * become people instead of dropping). Display name falls back to the handle
 * itself — honest, and merged when a named source (contacts) later links the
 * same identifier. Returns `null` for unusable handles ('other' kind) or
 * blocklisted/short-code identifiers (guards live in entity-resolve).
 */
export function resolveHandleToPerson(entry) {
  if (entry.kind === 'email') {
    return resolvePerson({ name: entry.handle, email: entry.handle, source: 'imessage' });
  }
  if (entry.kind === 'phone') {
    return resolvePerson({ name: entry.handle, phone: entry.handle, source: 'imessage' });
  }
  return null; // 'other' — skip until classification improves
}

// --- Persistence -----------------------------------------------------------

/**
 * Write one aggregated entry into imessages + person_interactions.
 * Idempotent: re-running the same entry folds counts into the existing row
 * (via ON CONFLICT) and the INSERT OR IGNORE on person_interactions drops
 * duplicates by `source_id`.
 *
 * @returns {{ linked: boolean, unresolved: boolean, isGroup: boolean }}
 */
export function persistEntry(entry) {
  const personLink = entry.isGroup ? null : resolveHandleToPerson(entry);
  const personId = personLink?.personId ?? null;
  const baseSource = `imessage:${entry.handle}:${entry.date}${entry.isGroup ? ':group' : ''}`;

  stmts.upsertImessage.run(
    entry.handle,
    entry.kind,
    personId,
    entry.isGroup ? 1 : 0,
    entry.date,
    entry.sent,
    entry.received,
    entry.lastAppleNs.toString(),
    baseSource,
  );
  insertTimelineEvent({
    sourceType: 'imessage',
    sourceId: baseSource,
    eventDate: entry.date,
    eventType: 'imessage',
    summary: `iMessage with ${entry.isGroup ? 'group' : entry.handle} (${entry.sent} sent, ${entry.received} received)`,
    content: `${entry.handle}:${entry.sent}:${entry.received}`,
    metadata: { handle_kind: entry.kind, is_group: !!entry.isGroup },
  });

  if (personId && !entry.isGroup) {
    const metadata = JSON.stringify({
      handle_kind: entry.kind,
      sent: entry.sent,
      received: entry.received,
    });
    if (entry.sent > 0) {
      stmts.insertInteraction.run(
        personId, 'outbound', entry.date, `${baseSource}:out`, metadata,
      );
    }
    if (entry.received > 0) {
      stmts.insertInteraction.run(
        personId, 'inbound', entry.date, `${baseSource}:in`, metadata,
      );
    }
  }

  return {
    linked: !!personId,
    unresolved: !personId && !entry.isGroup,
    isGroup: entry.isGroup,
  };
}

/** Run a set of entries inside a single transaction for throughput. */
export const writeBatch = db.transaction((entries) => {
  const counts = { linked: 0, unresolved: 0, group: 0 };
  for (const entry of entries) {
    const r = persistEntry(entry);
    if (r.isGroup) counts.group++;
    else if (r.linked) counts.linked++;
    else counts.unresolved++;
  }
  return counts;
});

export function syncIMessage({
  since = null,
  limit = null,
  dryRun = false,
  resetWatermark = false,
  chatDbPath = CHAT_DB_PATH,
} = {}) {
  const sinceAppleNs = resolveSinceAppleNs({ since, resetWatermark });
  const normalizedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : null;
  const chatDb = openChatDb(chatDbPath);
  try {
    const total = chatDb.prepare(
      'SELECT COUNT(*) AS c FROM message WHERE text IS NOT NULL',
    ).get().c;
    const rows = readMessages(chatDb, { sinceAppleNs, limit: normalizedLimit });
    const { pairs, maxAppleNs } = aggregateByHandleDay(rows);

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        total,
        pulled: rows.length,
        pairs: pairs.size,
        watermark: sinceAppleNs.toString(),
        partial: Boolean(normalizedLimit && rows.length >= normalizedLimit),
      };
    }

    const BATCH = 2000;
    const entries = [...pairs.values()];
    const counts = { linked: 0, unresolved: 0, group: 0 };
    for (let i = 0; i < entries.length; i += BATCH) {
      const slice = entries.slice(i, i + BATCH);
      const c = writeBatch(slice);
      counts.linked += c.linked;
      counts.unresolved += c.unresolved;
      counts.group += c.group;
    }

    if (maxAppleNs > sinceAppleNs) setWatermark(maxAppleNs);

    return {
      ok: true,
      total,
      pulled: rows.length,
      pairs: pairs.size,
      linked: counts.linked,
      unresolved: counts.unresolved,
      group: counts.group,
      watermark: maxAppleNs > sinceAppleNs ? maxAppleNs.toString() : sinceAppleNs.toString(),
      partial: Boolean(normalizedLimit && rows.length >= normalizedLimit),
    };
  } finally {
    chatDb.close();
  }
}
