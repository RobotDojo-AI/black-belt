/**
 * lib/chunk-worker.js
 *
 * Continuous background worker that converts raw integration data to RAG chunks,
 * then embeds all pending chunks inline.
 *
 * WHY continuous (not scheduled): chunk quality drives chat intelligence.
 * A user who connects Gmail should have context in minutes, not overnight.
 * The chunks table is the queue — setTimeout after each sync trigger is
 * sufficient; no separate worker infrastructure needed.
 *
 * Priority: is_starred DESC, content_rank ASC, event_time DESC
 * content_rank: 0=iMessage (highest signal), 1=transcript, 2=calendar, 3=email
 *
 * Exports:
 *   chunkEmails()          — convert emails → chunks
 *   chunkCalendarEvents()  — convert calendar_events → chunks
 *   chunkIMessages()       — convert chat.db conversations → chunks
 *   chunkTranscripts()     — convert transcripts → chunks
 *   retagChunk(sourceId, sourceType, oldTopic, newTopic) — retag + reset embedded
 *   runChunkWorker()       — orchestrate: chunk all sources, then embed all pending
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import Database from 'better-sqlite3';

import db, { computeInsertValueRank } from './db.js';
import { embedChunks } from './rag/embed.js';
import { classifyChunk } from './junk-classifier.js';
import {
  deleteVecRowForTopic,
  openSplitVectorStore,
} from './split-vector-store.js';
import {
  drainPassiveJobs,
  enqueuePassiveJob,
  mirrorPassiveJobStatus,
} from './passive-jobs.js';
import { runEnrichmentSlice } from './entity-enrich.js';
import {
  NEEDS_ROUTING_TOPIC,
  normalizeMemoryTopicSlug,
} from './topic-routing-policy.js';
import { topicForSourceAccount } from './topic-source-routing.js';
import { linkCompanyForPersonChunk } from './entity-company-evidence.js';
import { linkTimelineChunkEvidenceForChunk } from './entity-source-evidence.js';
import { refreshLinkedEntitySourceTimelineSections } from '../scripts/ingest/07-context.js';

// st_f6315f0b: env override for tests. CHAT_DB_PATH_OVERRIDE lets the
// imessage-tcc-backoff-test point at a non-existent path without overriding
// HOME (which would break Keychain access during DB init).
const CHAT_DB_PATH = process.env.CHAT_DB_PATH_OVERRIDE
  || join(homedir(), 'Library', 'Messages', 'chat.db');

// st_f6315f0b: exponential backoff schedule for chunkIMessages on TCC denial.
// Each step is the seconds-to-wait before the NEXT attempt: 1m, 5m, 15m, 30m,
// then sticky at 60m. The schedule comes from the framing decision; encoded
// here so a future tuning story (or a launch-day calibration) is one constant
// to update. State persists across launchd fires in worker_backoff table.
const IMESSAGE_BACKOFF_SECONDS = [60, 300, 900, 1800, 3600];
const IMESSAGE_WORKER_KEY = 'chunkIMessages.tcc';
const IMESSAGE_SETUP_KIND = 'tcc_imessage';

// Guard against overlapping worker cycles
let workerRunning = false;

// st_2cd1af73 — single embed owner. The long-lived chunk-embed-daemon
// (scripts/chunk-embed-daemon.mjs) now owns embedding: it loads the model once,
// drains value-first, and pauses on server activity. The 120s chunk-worker would
// otherwise reload the 2GB model every fire and race the daemon on the single
// WAL writer (the exact contention research found). So when EMBED_OWNER is
// 'daemon' (the shipped default), the worker does NOT enqueue or drain
// embedding_topic jobs — it keeps only its chunk-source-scanner role. Set
// ROBOTDOJO_EMBED_OWNER=worker to restore the legacy in-worker embed path (e.g.
// a box without the daemon installed).
const EMBED_OWNER = process.env.ROBOTDOJO_EMBED_OWNER || 'daemon';
export function daemonOwnsEmbedding() {
  return EMBED_OWNER === 'daemon';
}

let splitVectorDb;
function getSplitVectorDb() {
  if (splitVectorDb !== undefined) return splitVectorDb;
  splitVectorDb = openSplitVectorStore();
  return splitVectorDb;
}

function refreshLinkedSourceTimelines(entityIdsByType) {
  const companyIds = entityIdsByType?.company || [];
  const placeIds = entityIdsByType?.place || [];
  if (!companyIds.length && !placeIds.length) return null;
  try {
    return refreshLinkedEntitySourceTimelineSections(db, {
      entityIdsByType: { company: companyIds, place: placeIds },
      markFailures: true,
      log: (message) => console.warn(`[chunk-worker] ${message}`),
    });
  } catch (err) {
    console.warn(`[chunk-worker] source timeline refresh skipped: ${err.message}`);
    return null;
  }
}

function manualEmbedBatchLimit() {
  const n = Number(process.env.ROBOTDOJO_EMBED_MAX_BATCHES || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readEmbedDefault(name, fallback) {
  try {
    const raw = readFileSync(join(homedir(), 'robotdojo', 'config', 'defaults.json'), 'utf8');
    const cfg = JSON.parse(raw);
    const value = cfg?.embed?.[name];
    return positiveInt(value, fallback);
  } catch {
    return fallback;
  }
}

const EMAIL_EMBED_BODY_CHAR_CAP = positiveInt(
  process.env.ROBOTDOJO_EMAIL_EMBED_BODY_CHAR_CAP,
  readEmbedDefault('emailBodyCharCap', 1800),
);
const EMAIL_EMBED_TOTAL_CHAR_CAP = positiveInt(
  process.env.ROBOTDOJO_EMAIL_EMBED_TOTAL_CHAR_CAP,
  readEmbedDefault('emailTotalCharCap', 1900),
);
const EMAIL_EMBED_SUBJECT_CHAR_CAP = positiveInt(
  process.env.ROBOTDOJO_EMAIL_EMBED_SUBJECT_CHAR_CAP,
  readEmbedDefault('emailSubjectCharCap', 240),
);
const EMAIL_EMBED_SENDER_CHAR_CAP = positiveInt(
  process.env.ROBOTDOJO_EMAIL_EMBED_SENDER_CHAR_CAP,
  readEmbedDefault('emailSenderCharCap', 160),
);
const TRANSCRIPT_EMBED_CHUNK_CHAR_CAP = positiveInt(
  process.env.ROBOTDOJO_TRANSCRIPT_EMBED_CHUNK_CHAR_CAP,
  readEmbedDefault('transcriptChunkCharCap', 8000),
);

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

function chunkExists(sourceId, sourceType) {
  return !!db.prepare('SELECT 1 FROM chunks WHERE source_id = ? AND source_type = ?').get(sourceId, sourceType);
}

// st_db4b3118 — value_rank is stamped at INSERT so a brand-new chunk sorts in
// value order the moment the daemon fetches it (no waiting for a backfill pass).
// At insert there are no entity links yet, so computeInsertValueRank scores the
// recency+richness tiers (entity term 0); the VALUE-RANK REFRESH maintenance tick
// promotes the chunk to the entity tier once its links land. The two prepared
// statements below carry the value_rank column; the insertChunk()/insertChunkSkip()
// wrappers compute the rank from (eventTime, content) so the 8 call sites stay a
// single positional call each (no rank arithmetic duplicated per source type).
const insertChunkStmt = db.prepare(`
  INSERT OR IGNORE INTO chunks
    (topic, source_type, source_id, chunk_index, content, is_starred, content_rank, event_time, value_rank)
  VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
`);

const insertChunkSkipStmt = db.prepare(`
  INSERT OR IGNORE INTO chunks
    (topic, source_type, source_id, chunk_index, content, skip_embed, is_starred, content_rank, event_time, value_rank)
  VALUES (?, ?, ?, 0, ?, 1, ?, ?, ?, ?)
`);
const insertChunkAtIndexStmt = db.prepare(`
  INSERT OR IGNORE INTO chunks
    (topic, source_type, source_id, chunk_index, content, is_starred, content_rank, event_time, value_rank)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * Insert an embeddable chunk, stamping its insert-time value_rank. Signature
 * matches the prior prepared statement exactly so every call site is unchanged
 * except the binding now flows through here (which also computes value_rank).
 */
function insertChunk(topic, sourceType, sourceId, content, isStarred, contentRank, eventTime) {
  return insertChunkStmt.run(
    topic, sourceType, sourceId, content, isStarred, contentRank, eventTime,
    computeInsertValueRank(eventTime, content, contentRank),
  );
}

function insertChunkAtIndex(topic, sourceType, sourceId, chunkIndex, content, isStarred, contentRank, eventTime) {
  return insertChunkAtIndexStmt.run(
    topic, sourceType, sourceId, chunkIndex, content, isStarred, contentRank, eventTime,
    computeInsertValueRank(eventTime, content, contentRank),
  );
}

/** Insert a skip_embed=1 chunk (no vec row) with the same insert-time value_rank. */
function insertChunkSkip(topic, sourceType, sourceId, content, isStarred, contentRank, eventTime) {
  return insertChunkSkipStmt.run(
    topic, sourceType, sourceId, content, isStarred, contentRank, eventTime,
    computeInsertValueRank(eventTime, content, contentRank),
  );
}

function normalizeEmailChunkBody(body) {
  return String(body || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compactEmailHeader(value, fallback, maxChars) {
  const compacted = String(value || fallback || '')
    .replace(/\r\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = positiveInt(maxChars, 0);
  if (!limit || compacted.length <= limit) return compacted || fallback;
  return compacted.slice(0, limit).trim() || fallback;
}

export function buildEmailChunkContent({
  subject,
  sender,
  sender_email,
  body,
  strippedBody,
  maxBodyChars = EMAIL_EMBED_BODY_CHAR_CAP,
  maxTotalChars = EMAIL_EMBED_TOTAL_CHAR_CAP,
  maxSubjectChars = EMAIL_EMBED_SUBJECT_CHAR_CAP,
  maxSenderChars = EMAIL_EMBED_SENDER_CHAR_CAP,
} = {}) {
  const totalCap = positiveInt(maxTotalChars, EMAIL_EMBED_TOTAL_CHAR_CAP);
  const subjectText = compactEmailHeader(subject, '(no subject)', maxSubjectChars) || '(no subject)';
  const fromText = compactEmailHeader(sender || sender_email, 'unknown', maxSenderChars) || 'unknown';
  const preferredBody = String(strippedBody || '').trim() || String(body || '').trim();
  const normalizedBody = normalizeEmailChunkBody(preferredBody);
  const prefix = `Subject: ${subjectText}\nFrom: ${fromText}`;
  const bodyCap = positiveInt(maxBodyChars, EMAIL_EMBED_BODY_CHAR_CAP);
  const remaining = Math.max(0, totalCap - prefix.length - 2);
  const cappedBody = normalizedBody.slice(0, Math.min(bodyCap, remaining)).trim();
  const content = `${prefix}${cappedBody ? `\n\n${cappedBody}` : ''}`;
  return content.length > totalCap ? content.slice(0, totalCap).trim() : content;
}

// ──────────────────────────────────────────────────────────────────────────────
// chunkEmails
// ──────────────────────────────────────────────────────────────────────────────

// Batch size for email processing — keeps memory bounded on large corpora (350K+ emails)
const EMAIL_BATCH_SIZE = 500;
const EMAIL_MAX_BATCHES = positiveInt(process.env.ROBOTDOJO_EMAIL_CHUNK_MAX_BATCHES, 2);

// Prepared once at module scope — reused across all chunkEmails() calls
const fetchUnchunkedEmails = db.prepare(`
  SELECT e.id, e.subject, e.sender, e.sender_email, e.body_text, e.is_starred, e.received_at, e.account_id
  FROM emails e INDEXED BY idx_emails_received
  WHERE e.is_newsletter = 0
    AND e.list_unsubscribe IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM chunks c
      WHERE c.source_type = 'email' AND (c.source_id = 'email:' || e.id OR c.source_id = e.id)
    )
  ORDER BY e.received_at DESC NULLS LAST
  LIMIT ${EMAIL_BATCH_SIZE}
`);

const fetchAccountEmailStmt = db.prepare('SELECT email, topic_slug FROM accounts WHERE id = ?');

/**
 * The owning account's own email address and mailbox topic, cached per
 * chunkEmails() call — the account roster is small and static within one run.
 */
function accountEmailLookup() {
  const cache = new Map();
  return (accountId) => {
    if (!accountId) return { email: null, topic: null };
    if (cache.has(accountId)) return cache.get(accountId);
    const row = fetchAccountEmailStmt.get(accountId);
    const value = { email: row?.email || null, topic: row?.topic_slug || null };
    cache.set(accountId, value);
    return value;
  };
}

/**
 * Convert emails to RAG chunks. Quality filters applied at creation time:
 * - SQL pre-filter (lines 68–69): is_newsletter=0 AND list_unsubscribe IS NULL
 *   stays in place as defense in depth — even if classifyChunk is bypassed,
 *   the pre-filter blocks the dominant newsletter class.
 * - classifyChunk() is invoked on every survivor — newsletter/transactional
 *   header signals (7 RFCs), short-body floor, signature/quoted-reply strip.
 *   On shouldEmbed=false, the row is inserted with skip_embed=1 so the
 *   entity/timeline pipeline still has the source reference but no vec
 *   row is created.
 * - content_rank = 3 (lowest signal among sources)
 * - is_starred mirrors emails.is_starred
 *
 * WHY NOT EXISTS with OR: checks both 'email:{id}' (new format) and raw '{id}' (old format
 * from prior ingest pipeline) — without OR, 325K already-chunked emails appear unchunked.
 * WHY received_at DESC: newest emails chunked first — newly connected users get context
 * within minutes; long-tail backfill continues in subsequent cycles.
 * WHY LIMIT 500 + max batches: loading 350K emails at once causes OOM, and
 * draining every email batch in one launchd slice monopolizes the writer. Newest
 * mail lands first; the long tail continues on later slices.
 */
export async function chunkEmails() {
  let created = 0;
  let batches = 0;
  const accountEmailFor = accountEmailLookup();
  // Lazy — only loaded once there's at least one email to place, so an idle
  // cycle with nothing to chunk pays no extra query.
  let validTopics = null;

  while (batches < EMAIL_MAX_BATCHES) {
    const emails = fetchUnchunkedEmails.all();
    if (!emails.length) break;
    batches++;
    if (!validTopics) {
      validTopics = new Set(db.prepare('SELECT slug FROM user_topics').all().map((r) => r.slug));
    }

    for (const email of emails) {
      const sourceId = `email:${email.id}`;
      const body = (email.body_text || '').trim();
      const eventTime = email.received_at || null;

      // st_2cd1af73 — email chunks are EMBEDDABLE by default and embed value-LAST
      // (owner correction: recall must include the email corpus; the daemon orders
      // email bulk after high-signal sources). The classifier's shouldEmbed=false
      // signals (newsletter/transactional/short-body) used to stamp skip_embed=1
      // and permanently exclude ~109k email chunks from recall — that was the
      // gap. We keep skip_embed=1 ONLY for genuinely-unembeddable content: a chunk
      // whose visible body is empty after the strip pipeline (no text to embed).
      // The SQL pre-filter (is_newsletter=0 AND list_unsubscribe IS NULL) still
      // blocks the dominant newsletter class at selection time; everything that
      // survives to here carries usable signal and should be retrievable.
      const verdict = classifyChunk({
        source_type: 'email',
        body,
        sender_email: email.sender_email,
        subject: email.subject,
      });
      const content = buildEmailChunkContent({
        subject: email.subject,
        sender: email.sender,
        sender_email: email.sender_email,
        body,
        strippedBody: verdict.strippedBody,
      });

      // "Genuinely unembeddable" = no usable text ANYWHERE: the classifier's
      // post-strip body (quoted replies + signature + footer removed) is empty
      // AND the subject is empty. Such a chunk has nothing for the embedder to
      // ground on, so it stays skipped. Everything else — including newsletters
      // and transactional mail the classifier flagged shouldEmbed=false — carries
      // signal in its subject/sender/body and IS embedded (value-last via the
      // daemon ordering). strippedBody is null on the header-class path, so we
      // coalesce to '' and then also weigh the subject.
      const strippedBody = (verdict.strippedBody || '').trim();
      const subjectText = (email.subject || '').trim();
      const hasUsableText = strippedBody.length > 0 || subjectText.length > 0;
      // st_56bd10d1 — deterministic source-account/domain routing is a
      // HIGH-CONFIDENCE signal that wins over the cosine-similarity
      // reclassifier: an email whose sender or owning mailbox matches a
      // configured domain lands directly in the right topic instead of
      // waiting on embeddings. `topic` is free-text with no FK (see
      // migrations/000_base_entities.sql) — validTopics guards against
      // assigning a slug this install's taxonomy doesn't actually have
      // (e.g. a work-specific topic configured but not yet created), which
      // would silently orphan the chunk outside every topic the UI renders.
      // Everything else still starts in the T1-residual routing queue until
      // embedding/reclassify can place it under a real T2.
      const mailbox = accountEmailFor(email.account_id);
      const routedTopic = topicForSourceAccount({
        senderEmail: email.sender_email,
        accountEmail: mailbox.email,
        accountTopic: mailbox.topic,
      });
      const topic = (routedTopic && validTopics.has(routedTopic)) ? routedTopic : NEEDS_ROUTING_TOPIC;
      if (!hasUsableText) {
        insertChunkSkip(topic, 'email', sourceId, content, email.is_starred || 0, 3, eventTime);
      } else {
        insertChunk(topic, 'email', sourceId, content, email.is_starred || 0, 3, eventTime);
      }
      created++;
    }
  }

  const capped = batches >= EMAIL_MAX_BATCHES ? ` (slice cap ${EMAIL_MAX_BATCHES} batch${EMAIL_MAX_BATCHES === 1 ? '' : 'es'})` : '';
  console.log(`[chunk-worker] chunkEmails: ${created} new email chunks${capped}`);
  return created;
}

// ──────────────────────────────────────────────────────────────────────────────
// chunkCalendarEvents
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Convert calendar events to RAG chunks. Filters:
 * - Skip cancelled events
 * - Skip events with no attendees (empty, null, or '[]')
 * - source_type = 'calendar' (existing convention — NOT 'calendar_event')
 * - content_rank = 2
 *
 * st_f6315f0b: SELECT now joins NOT EXISTS in the primary filter so already-
 * chunked events never enter the JS loop. Prior code loaded all calendar_events
 * (33K+ rows on a typical user) on every 120s cycle and called chunkExists()
 * per row — a full table scan inside the worker hot path. The NOT EXISTS
 * pushes the dedup to SQLite where it belongs.
 */
export async function chunkCalendarEvents() {
  const events = db.prepare(`
    SELECT id, summary, description, location, start_time, end_time, attendees, organizer
    FROM calendar_events ce
    WHERE status != 'cancelled'
      AND attendees IS NOT NULL
      AND attendees != ''
      AND attendees != '[]'
      AND NOT EXISTS (
        SELECT 1 FROM chunks c
        WHERE c.source_type = 'calendar' AND c.source_id = 'calendar:' || ce.id
      )
  `).all();

  let created = 0;
  for (const ev of events) {
    const sourceId = `calendar:${ev.id}`;
    // Defensive: NOT EXISTS in the SELECT covers the common path; this
    // guard catches the rare race where another writer inserts the same
    // source_id between SELECT and INSERT. Cheap (single indexed lookup).
    if (chunkExists(sourceId, 'calendar')) continue;

    const lines = [`Meeting: ${ev.summary || '(no title)'}`];
    if (ev.description) lines.push(`Description: ${ev.description}`);
    if (ev.location) lines.push(`Location: ${ev.location}`);
    if (ev.organizer) lines.push(`Organizer: ${ev.organizer}`);
    if (ev.attendees) {
      try {
        const parsed = JSON.parse(ev.attendees);
        const emails = parsed.map(a => a.email || a).filter(Boolean).join(', ');
        if (emails) lines.push(`Attendees: ${emails}`);
      } catch {
        lines.push(`Attendees: ${ev.attendees}`);
      }
    }
    const content = lines.join('\n');
    const eventTime = ev.start_time || null;

    const inserted = insertChunk(NEEDS_ROUTING_TOPIC, 'calendar', sourceId, content, 0, 2, eventTime);
    if (inserted.changes > 0) {
      const chunk = db.prepare('SELECT id FROM chunks WHERE source_id = ? AND source_type = ?').get(sourceId, 'calendar');
      if (chunk) {
        const linked = linkTimelineChunkEvidenceForChunk(db, chunk.id, {
          entityTypes: ['company', 'place'],
          markNeedsRegen: false,
        });
        refreshLinkedSourceTimelines(linked.entityIdsByType);
      }
      created++;
    }
  }

  console.log(`[chunk-worker] chunkCalendarEvents: ${created} new calendar chunks`);
  return created;
}

// ──────────────────────────────────────────────────────────────────────────────
// chunkIMessages
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Read the current iMessage TCC backoff state. Returns null when no backoff
 * row exists (try immediately). Returns { nextAttemptAt, attemptCount } when
 * a row exists — caller compares nextAttemptAt against now.
 *
 * @returns {{nextAttemptAt: number, attemptCount: number}|null}
 */
function readIMessageBackoff() {
  return db.prepare(`
    SELECT next_attempt_at AS nextAttemptAt, attempt_count AS attemptCount
    FROM worker_backoff WHERE worker_key = ?
  `).get(IMESSAGE_WORKER_KEY) || null;
}

/**
 * Record an iMessage TCC denial. Advances the backoff step (capped at the
 * last entry), schedules the next attempt, and (on first denial only) inserts
 * a needs_user setup task. Idempotent on the setup_tasks side via the
 * UNIQUE(kind, source_key) constraint.
 */
function recordIMessageBackoff(errMessage) {
  const existing = readIMessageBackoff();
  const nextStep = existing
    ? Math.min(existing.attemptCount, IMESSAGE_BACKOFF_SECONDS.length - 1)
    : 0;
  const waitSeconds = IMESSAGE_BACKOFF_SECONDS[nextStep];
  const now = Math.floor(Date.now() / 1000);
  const nextAttemptAt = now + waitSeconds;
  const attemptCount = existing ? Math.min(existing.attemptCount + 1, IMESSAGE_BACKOFF_SECONDS.length) : 1;

  db.prepare(`
    INSERT INTO worker_backoff (worker_key, next_attempt_at, attempt_count, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(worker_key) DO UPDATE SET
      next_attempt_at = excluded.next_attempt_at,
      attempt_count = excluded.attempt_count,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run(IMESSAGE_WORKER_KEY, nextAttemptAt, attemptCount, errMessage || null, now);

  // INSERT OR IGNORE on (kind, source_key) — first denial creates the row,
  // every subsequent denial is a no-op. This is the "surface once, not every
  // cycle" half of the AC.
  db.prepare(`
    INSERT OR IGNORE INTO setup_tasks (kind, source_key, status, message, created_at, updated_at)
    VALUES (?, ?, 'needs_user', ?, ?, ?)
  `).run(
    IMESSAGE_SETUP_KIND,
    'chat.db',
    'iMessage Full Disk Access not granted — grant in System Settings → Privacy & Security → Full Disk Access',
    now, now,
  );
}

/**
 * Clear the backoff row on success. Called after a successful chat.db open
 * so the next denial restarts the schedule from step 1.
 */
function clearIMessageBackoff() {
  db.prepare(`DELETE FROM worker_backoff WHERE worker_key = ?`).run(IMESSAGE_WORKER_KEY);
}

/**
 * Convert iMessage conversations to RAG chunks, grouped by (handle, day).
 * Reads directly from ~/Library/Messages/chat.db — requires Full Disk Access.
 * Skips gracefully if chat.db is inaccessible.
 * content_rank = 0 (highest signal — revealed, actual behavior)
 *
 * st_f6315f0b: TCC failures now back off exponentially (1m → 5m → 15m → 30m
 * → 60m sticky) instead of log-spamming every 120s cycle. State persists in
 * worker_backoff. First denial inserts a setup_tasks row so the user sees
 * "iMessage needs Full Disk Access" once in /onboard, not 720 times per day
 * in /tmp/robotdojo-chunk-worker.err.log.
 */
export async function chunkIMessages() {
  // Backoff gate runs BEFORE any FS check. If the row says next_attempt_at is
  // in the future, return 0 silently — no log line, no work. The setup_tasks
  // row is already surfacing the issue.
  const backoff = readIMessageBackoff();
  const nowSec = Math.floor(Date.now() / 1000);
  if (backoff && backoff.nextAttemptAt > nowSec) {
    // Quiet skip — single line per fire, no spam. Useful for debugging via
    // grep but doesn't drown the err.log.
    if (process.env.IMESSAGE_BACKOFF_VERBOSE === '1') {
      console.log(`[chunk-worker] chunkIMessages: in backoff window (${backoff.nextAttemptAt - nowSec}s left)`);
    }
    return 0;
  }

  if (!existsSync(CHAT_DB_PATH)) {
    console.warn('[chunk-worker] chunkIMessages: chat.db not found — FDA not granted, skipping');
    recordIMessageBackoff('chat.db not found');
    return 0;
  }

  let chatDb;
  try {
    chatDb = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
    // Successful open → clear any prior backoff so future denials restart fresh.
    clearIMessageBackoff();
  } catch (err) {
    console.warn(`[chunk-worker] chunkIMessages: cannot open chat.db — ${err.message}`);
    recordIMessageBackoff(err.message);
    return 0;
  }

  // Apple timestamps are nanoseconds since 2001-01-01 (vs Unix epoch 1970-01-01)
  const APPLE_EPOCH_OFFSET = 978307200; // seconds between 1970-01-01 and 2001-01-01
  let rows;
  try {
    rows = chatDb.prepare(`
      SELECT
        COALESCE(h.id, c.chat_identifier)                           AS handle,
        date(datetime(m.date / 1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch')) AS day,
        m.is_from_me                                                AS is_from_me,
        m.text                                                      AS text
      FROM message m
      LEFT JOIN handle h             ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c               ON c.ROWID = cmj.chat_id
      WHERE m.text IS NOT NULL AND LENGTH(TRIM(m.text)) > 0 AND m.date > 0
      ORDER BY handle, day, m.date ASC
    `).all();
  } catch (err) {
    console.warn(`[chunk-worker] chunkIMessages: query failed — ${err.message}`);
    chatDb.close();
    return 0;
  }
  chatDb.close();

  // Group by (handle, day) and build window content
  const windows = new Map();
  for (const row of rows) {
    if (!row.handle || !row.day) continue;
    const key = `${row.handle}|${row.day}`;
    if (!windows.has(key)) windows.set(key, { handle: row.handle, day: row.day, messages: [] });
    const speaker = row.is_from_me ? 'Me' : row.handle;
    windows.get(key).messages.push(`${speaker}: ${row.text}`);
  }

  let created = 0;
  for (const [, win] of windows) {
    const sourceId = `imessage:${win.handle}:${win.day}`;
    if (chunkExists(sourceId, 'imessage')) continue;

    // Truncate to 8000 chars to keep local embedding CPU bounded.
    const content = `[iMessage: ${win.handle} — ${win.day}]\n${win.messages.join('\n')}`.slice(0, 8000);
    const eventTime = `${win.day}T00:00:00`;

    insertChunk(NEEDS_ROUTING_TOPIC, 'imessage', sourceId, content, 0, 0, eventTime);
    created++;
  }

  console.log(`[chunk-worker] chunkIMessages: ${created} new iMessage chunks`);
  return created;
}

// ──────────────────────────────────────────────────────────────────────────────
// chunkHealthNotes
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Convert health rows to RAG chunks so health queries land in RAG retrieval.
 *
 * Sources (st_d142f701 AC3 / AC18):
 *   1. `health_notes`        — Oura live sync. Content already includes the
 *                              metric name and value as text; we chunk the
 *                              row verbatim with the date prefix.
 *   2. `health_data_points`  — Apple Health XML + lab imports. Numeric only;
 *                              we render "{date} {marker_id}: {value}".
 *
 * Dedup guard (AC18): if a `health_notes` row exists for (date, metric_name)
 * we skip the corresponding `health_data_points` row. The two tables can hold
 * the same Oura metric for the same day when a user imports the JSON export
 * alongside the live sync — without this check, chat would see the same metric
 * twice and the model can double-count trends.
 *
 * Topic: 'health' (matches lib/topic-skill-configs/health.js context).
 * content_rank = 2 — structured signal, same tier as calendar.
 * source_id format: 'health_note:{id}' and 'health_dp:{id}'.
 */
export async function chunkHealthNotes() {
  let created = 0;

  // ── health_notes ─────────────────────────────────────────────────────────
  // st_d142f701 AC18 hardening: pre-filter at the SQL layer to keep only ONE
  // health_note row per (date, metric_name) tuple. The metric name is the
  // prefix before the first `:` in the content (Oura format
  // "{metric}: {value} {unit}"). Upstream Oura sync paths can re-insert the
  // same metric multiple times per day:
  //   - identical content (backfill overlaps live sync) → MIN(id) collapses
  //   - value updates intraday (335 → 337 kcal as activity accumulates) →
  //     we keep the LAST id (highest id, most recent value), so chat sees
  //     the day-end reading, not a partial morning value.
  // Using MAX(id) — the latest insertion — keeps the most recent value for
  // each (date, metric) within the day. Older partial values still exist in
  // health_notes (we never mutate the source table), but they don't reach
  // the chunks/RAG layer twice.
  const notes = db.prepare(`
    SELECT hn.id, hn.date, hn.content, hn.tags
    FROM health_notes hn
    WHERE hn.content IS NOT NULL AND LENGTH(TRIM(hn.content)) > 0
      AND hn.id = (
        SELECT MAX(hn2.id) FROM health_notes hn2
        WHERE hn2.date = hn.date
          AND SUBSTR(hn2.content, 1, INSTR(hn2.content, ':') - 1)
              = SUBSTR(hn.content, 1, INSTR(hn.content, ':') - 1)
      )
      AND NOT EXISTS (
        SELECT 1 FROM chunks c
        WHERE c.source_type = 'health' AND c.source_id = 'health_note:' || hn.id
      )
  `).all();

  for (const note of notes) {
    const sourceId = `health_note:${note.id}`;
    if (chunkExists(sourceId, 'health')) continue;
    const datePart = note.date || '';
    const content = `[${datePart}] ${note.content}`.slice(0, 8000);
    const eventTime = datePart ? `${datePart}T00:00:00` : null;
    insertChunk('health', 'health', sourceId, content, 0, 2, eventTime);
    created++;
  }

  // ── health_data_points ───────────────────────────────────────────────────
  // Skip dp rows whose (date, marker_id-derived metric name) already has a
  // health_notes chunk. The LIKE pattern checks for the human-readable name
  // from health_markers OR for the marker_id itself appearing in the note
  // body — covers both Oura's name-bearing notes and bare marker rows.
  const dps = db.prepare(`
    SELECT dp.id, dp.marker_id, dp.date, dp.value, dp.source,
           m.name AS marker_name, m.unit AS marker_unit
    FROM health_data_points dp
    LEFT JOIN health_markers m ON m.id = dp.marker_id
    WHERE dp.excluded = 0
      AND dp.value IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM chunks c
        WHERE c.source_type = 'health' AND c.source_id = 'health_dp:' || dp.id
      )
  `).all();

  const checkHealthNoteDup = db.prepare(`
    SELECT 1 FROM health_notes hn
    WHERE hn.date = ?
      AND (LOWER(hn.content) LIKE LOWER(?) OR LOWER(hn.content) LIKE LOWER(?))
    LIMIT 1
  `);

  for (const dp of dps) {
    const sourceId = `health_dp:${dp.id}`;
    if (chunkExists(sourceId, 'health')) continue;

    // AC18 dedup: same (date, metric) already in health_notes?
    const datePart = dp.date || '';
    const namePattern = dp.marker_name ? `%${dp.marker_name}%` : null;
    const idPattern = dp.marker_id ? `%${dp.marker_id}%` : '%';
    if (datePart && (namePattern || idPattern)) {
      const dup = checkHealthNoteDup.get(datePart, namePattern || idPattern, idPattern);
      if (dup) continue;
    }

    const label = dp.marker_name || dp.marker_id || 'metric';
    const unit = dp.marker_unit ? ` ${dp.marker_unit}` : '';
    const content = `[${datePart}] ${label}: ${dp.value}${unit}`.slice(0, 8000);
    const eventTime = datePart ? `${datePart}T00:00:00` : null;
    insertChunk('health', 'health', sourceId, content, 0, 2, eventTime);
    created++;
  }

  console.log(`[chunk-worker] chunkHealthNotes: ${created} new health chunks`);
  return created;
}

// ──────────────────────────────────────────────────────────────────────────────
// chunkTranscripts
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build the RAG chunk content for a transcript. When the transcript has
 * attributed turns (st_8a841c68), the body is `Name: text` per turn so chat and
 * external tools see WHO said what; otherwise the legacy anonymous flat block.
 * Also returns the speaking person ids (for chunk_entities linking) and the
 * talk-share JSON (for chunk metadata).
 *
 * @returns {{content:string, speakerIds:string[], talkShare:string}}
 */
function buildTranscriptChunkContent(t) {
  const lines = [`Meeting: ${t.title || '(no title)'}`];
  if (t.duration_minutes) lines.push(`Duration: ${t.duration_minutes} minutes`);
  if (t.call_notes) lines.push(`Notes: ${t.call_notes}`);
  lines.push('');

  const segments = db.prepare(
    'SELECT speaker_person_id, text FROM transcript_segments WHERE transcript_id = ? ORDER BY turn_index ASC',
  ).all(t.id);

  const speakerIds = new Set();
  if (segments.length > 0) {
    const ids = [...new Set(segments.map((s) => s.speaker_person_id).filter(Boolean))];
    const nameById = new Map();
    for (const id of ids) {
      const p = db.prepare('SELECT display_name FROM people WHERE id = ?').get(id);
      nameById.set(id, (p?.display_name || '').trim() || 'Unknown');
      speakerIds.add(id);
    }
    for (const s of segments) {
      const label = s.speaker_person_id ? (nameById.get(s.speaker_person_id) || 'Unknown') : 'Unassigned';
      lines.push(`${label}: ${s.text || ''}`);
    }
  } else {
    lines.push(t.transcript_text || '');
  }

  return {
    content: lines.join('\n'),
    speakerIds: [...speakerIds],
    talkShare: t.talk_share || '{}',
  };
}

function splitLongLine(line, budget) {
  const text = String(line || '');
  if (text.length <= budget) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += budget) {
    out.push(text.slice(i, i + budget));
  }
  return out;
}

function splitTranscriptContent(content, maxChars = TRANSCRIPT_EMBED_CHUNK_CHAR_CAP) {
  const text = String(content || '').trim();
  if (!text) return [];
  const cap = Math.max(2000, Number(maxChars) || TRANSCRIPT_EMBED_CHUNK_CHAR_CAP);
  if (text.length <= cap) return [text];

  const lines = text.split(/\n/);
  const headerEnd = lines.findIndex((line, index) => index > 0 && line.trim() === '');
  const header = (headerEnd >= 0 ? lines.slice(0, headerEnd) : lines.slice(0, 1)).join('\n').trim();
  const bodyLines = headerEnd >= 0 ? lines.slice(headerEnd + 1) : lines.slice(1);
  const prefixBase = header ? `${header}\n\nPart ` : 'Part ';
  const budget = Math.max(500, cap - prefixBase.length - 20);
  const chunks = [];
  let current = [];
  let currentLen = 0;

  function flush() {
    const body = current.join('\n').trim();
    if (!body) return;
    chunks.push(body);
    current = [];
    currentLen = 0;
  }

  for (const rawLine of bodyLines) {
    for (const line of splitLongLine(rawLine, budget)) {
      const nextLen = currentLen + line.length + (current.length ? 1 : 0);
      if (current.length && nextLen > budget) flush();
      current.push(line);
      currentLen = currentLen + line.length + (current.length > 1 ? 1 : 0);
    }
  }
  flush();

  return chunks.map((body, index) => {
    const part = `${index + 1}/${chunks.length}`;
    return header
      ? `${header}\nPart: ${part}\n\n${body}`.slice(0, cap)
      : `Part: ${part}\n\n${body}`.slice(0, cap);
  });
}

function insertTranscriptChunks({ topic, sourceId, chunks, eventTime, talkShare, speakerIds }) {
  let inserted = 0;
  for (let i = 0; i < chunks.length; i++) {
    insertChunkAtIndex(topic, 'transcript', sourceId, i, chunks[i], 0, 1, eventTime);
    const chunk = db.prepare('SELECT id FROM chunks WHERE source_id = ? AND source_type = ? AND chunk_index = ?')
      .get(sourceId, 'transcript', i);
    if (!chunk) continue;
    inserted++;
    if (talkShare && talkShare !== '{}') {
      db.prepare('UPDATE chunks SET metadata = ? WHERE id = ?').run(talkShare, chunk.id);
    }
    linkTranscriptChunkEntities(chunk.id, speakerIds);
  }
  return inserted;
}

// Link the people who spoke in a transcript chunk via chunk_entities, so the
// call surfaces in lib/chat-context.js Layer 2 when the user names a
// participant. entity_id stores the TEXT p_... id (SQLite dynamic typing).
const insertTranscriptChunkEntity = db.prepare(
  "INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, entity_type) VALUES (?, ?, 'person')",
);

function linkTranscriptChunkEntity(chunkId, personId) {
  insertTranscriptChunkEntity.run(chunkId, personId);
  return linkCompanyForPersonChunk(db, chunkId, personId, { markNeedsRegen: false });
}

function linkTranscriptChunkEntities(chunkId, personIds) {
  const companyIds = [];
  for (const pid of personIds) {
    const linked = linkTranscriptChunkEntity(chunkId, pid);
    if (linked?.companyId) companyIds.push(linked.companyId);
  }
  refreshLinkedSourceTimelines({ company: companyIds });
}

function transcriptChunkTopic(rawTopic) {
  return normalizeMemoryTopicSlug(rawTopic, { fallback: true }) || NEEDS_ROUTING_TOPIC;
}

/**
 * Convert Granola meeting transcripts to RAG chunks.
 * Uses the transcript's own topic field when it is a real topic; legacy fallback
 * tags like `general` and blank topics route to Uncategorized.
 * content_rank = 1 (high signal — actual meeting content).
 * When a transcript is attributed, the chunk carries named turns + speaker
 * entity links + talk-share metadata (st_8a841c68).
 */
export async function chunkTranscripts() {
  const transcripts = db.prepare(`
    SELECT id, title, meeting_date, duration_minutes, transcript_text, call_notes, topic, talk_share
    FROM transcripts
    WHERE transcript_text IS NOT NULL AND LENGTH(transcript_text) > 0
  `).all();

  let created = 0;
  for (const t of transcripts) {
    const sourceId = `transcript:${t.id}`;
    if (chunkExists(sourceId, 'transcript')) continue;

    const { content, speakerIds, talkShare } = buildTranscriptChunkContent(t);
    const chunks = splitTranscriptContent(content);
    const topic = transcriptChunkTopic(t.topic);
    const eventTime = t.meeting_date ? `${t.meeting_date}T00:00:00` : null;

    created += insertTranscriptChunks({ topic, sourceId, chunks, eventTime, talkShare, speakerIds });
  }

  console.log(`[chunk-worker] chunkTranscripts: ${created} new transcript chunks`);
  return created;
}

/**
 * Re-chunk a single transcript after an attribution pass (st_8a841c68). Unlike
 * the bulk chunkTranscripts, this BYPASSES the chunkExists guard and rewrites
 * the existing chunk's content with the freshly-attributed turns, relinks the
 * speakers, refreshes talk-share metadata, and resets embedded=0 so the daemon
 * re-embeds the new text. Gated by the orchestrator on attributed_at, so it
 * only runs when there's a newer attribution than the chunk.
 *
 * @param {string} transcriptId
 * @returns {boolean} true when a chunk was rewritten (or created)
 */
export async function rechunkTranscript(transcriptId) {
  const t = db.prepare(`
    SELECT id, title, meeting_date, duration_minutes, transcript_text, call_notes, topic, talk_share
    FROM transcripts WHERE id = ?
  `).get(transcriptId);
  if (!t) return false;

  const sourceId = `transcript:${t.id}`;
  const { content, speakerIds, talkShare } = buildTranscriptChunkContent(t);
  const chunks = splitTranscriptContent(content);
  const topic = transcriptChunkTopic(t.topic);
  const eventTime = t.meeting_date ? `${t.meeting_date}T00:00:00` : null;

  const existingRows = db.prepare('SELECT id, topic FROM chunks WHERE source_id = ? AND source_type = ?')
    .all(sourceId, 'transcript');
  const tx = db.transaction(() => {
    for (const row of existingRows) {
      deleteVecRowForTopic(row.topic || topic, row.id, {
        database: db,
        embeddingsDb: getSplitVectorDb(),
      });
      db.prepare('DELETE FROM chunk_entities WHERE chunk_id = ?').run(row.id);
    }
    db.prepare('DELETE FROM chunks WHERE source_id = ? AND source_type = ?').run(sourceId, 'transcript');
    insertTranscriptChunks({ topic, sourceId, chunks, eventTime, talkShare, speakerIds });
  });
  tx();
  return true;
}

// File extensions whose bytes are directly readable as text.
const DROP_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log',
  '.rtf', '.html', '.htm', '.xml', '.yaml', '.yml',
]);

const MAX_DROP_FILE_CHARS = 8000;

// Best-effort text extraction for a dropped file on disk. Known text extensions
// are read as UTF-8; unknown/binary files are kept only if enough printable
// characters survive (a locked PDF or an image yields nothing usable → skipped).
function bestEffortFileText(filePath) {
  let raw;
  try { raw = readFileSync(filePath, 'utf8'); } catch { return ''; }
  if (DROP_TEXT_EXTENSIONS.has(extname(filePath).toLowerCase())) return raw;
  const printable = raw.replace(/[^\x20-\x7E\n\t\r]/g, ' ');
  const density = printable.replace(/\s/g, '').length / Math.max(1, raw.length);
  return density > 0.6 ? printable : '';
}

/**
 * Chunk dropped files (PDF/CSV/text/markdown/etc.) so they become searchable
 * RAG content — st_fcdbe84f WS2 / AC6. The drop-folder watcher records each
 * file in drop_folder_files with its on-disk path and topic; the body text is
 * not stored in the DB, so we read it from disk. One chunk per file under its
 * assigned T2 (or T1) topic; the embedding reclassifier re-homes it later.
 * Files with no extractable text (images, locked PDFs) are skipped, not errored.
 */
export async function chunkDropFolderFiles() {
  let rows;
  try {
    rows = db.prepare(`
      SELECT path, original_name, topic_t1, topic_t2, doc_type,
             COALESCE(processed_at, datetime('now')) AS event_time
      FROM drop_folder_files
      WHERE status = 'processed'
    `).all();
  } catch {
    return 0; // table absent (minimal test DBs) — nothing to chunk
  }

  let created = 0;
  for (const r of rows) {
    const sourceId = r.path;
    if (!sourceId || chunkExists(sourceId, 'drop_folder_file')) continue;
    if (!existsSync(sourceId)) continue;
    const text = bestEffortFileText(sourceId).trim();
    if (!text) continue;

    const header = r.original_name
      ? `[${r.original_name}${r.doc_type ? ` | ${r.doc_type}` : ''}]\n`
      : '';
    const content = (header + text).slice(0, MAX_DROP_FILE_CHARS);
    const topic = (r.topic_t2 && r.topic_t2.trim())
      || (r.topic_t1 && r.topic_t1.trim())
      || NEEDS_ROUTING_TOPIC;

    const res = insertChunk(topic, 'drop_folder_file', sourceId, content, 0, 1, r.event_time);
    if (res.changes > 0) created++;
  }

  console.log(`[chunk-worker] chunkDropFolderFiles: ${created} new dropped-file chunks`);
  return created;
}

// ──────────────────────────────────────────────────────────────────────────────
// retagChunk
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Retag a chunk to a new topic and reset embedded=0 so it gets re-embedded.
 * Also removes the chunk from the old topic's vec table to prevent ghost matches.
 *
 * @param {string} sourceId
 * @param {string} sourceType
 * @param {string} oldTopic
 * @param {string} newTopic
 */
export async function retagChunk(sourceId, sourceType, oldTopic, newTopic) {
  const chunk = db.prepare('SELECT id FROM chunks WHERE source_id = ? AND source_type = ?').get(sourceId, sourceType);
  if (!chunk) return;

  const tx = db.transaction(() => {
    // Update topic and reset embedded so it gets re-embedded under new topic.
    db.prepare('UPDATE chunks SET topic = ?, embedded = 0 WHERE id = ?').run(newTopic, chunk.id);
    // Remove from old vec table if it exists — prevents ghost matches on old topic.
    deleteVecRowForTopic(oldTopic, chunk.id, { database: db, embeddingsDb: getSplitVectorDb() });
  });
  tx();
}

// ──────────────────────────────────────────────────────────────────────────────
// runChunkWorker
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Are there new (un-chunked) source rows waiting to be turned into chunks?
 *
 * st_b50005df: split out of hasPendingWork() so the enqueue path can re-derive
 * the chunk-scan need INDEPENDENTLY of the embed need. The old code folded both
 * needs into one ordered struct (embed checked first), which let the embed
 * backlog permanently mask the chunk-scan need — see the WHY block on
 * enqueueChunkWorkerJobs. This helper answers only the chunk question; embed is
 * answered separately. Each probe is a single indexed NOT-EXISTS LIMIT 1.
 *
 * iMessage is intentionally NOT probed here — it is gated by chat.db file
 * existence + a separate backoff window owned by chunkIMessages(). Probing it
 * would couple the chunk-scan decision to a permissions/TCC failure path.
 *
 * @returns {{pending: boolean, reason: string|null}}
 */
export function hasPendingChunkSources(database = db) {
  // Emails: NOT EXISTS subquery — same shape chunkEmails uses.
  const pendingEmail = database.prepare(`
    SELECT 1 FROM emails e INDEXED BY idx_emails_received
    WHERE e.is_newsletter = 0 AND e.list_unsubscribe IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM chunks c
        WHERE c.source_type = 'email' AND (c.source_id = 'email:' || e.id OR c.source_id = e.id)
      )
    LIMIT 1
  `).get();
  if (pendingEmail) return { pending: true, reason: 'new emails to chunk' };

  // Calendar: NOT EXISTS shape matches chunkCalendarEvents.
  const pendingCal = database.prepare(`
    SELECT 1 FROM calendar_events ce
    WHERE status != 'cancelled' AND attendees IS NOT NULL
      AND attendees != '' AND attendees != '[]'
      AND NOT EXISTS (
        SELECT 1 FROM chunks c
        WHERE c.source_type = 'calendar' AND c.source_id = 'calendar:' || ce.id
      )
    LIMIT 1
  `).get();
  if (pendingCal) return { pending: true, reason: 'new calendar events to chunk' };

  // Transcripts: NOT EXISTS keyed on transcripts.id.
  const pendingTranscript = database.prepare(`
    SELECT 1 FROM transcripts t
    WHERE t.transcript_text IS NOT NULL AND LENGTH(t.transcript_text) > 0
      AND NOT EXISTS (
        SELECT 1 FROM chunks c
        WHERE c.source_type = 'transcript' AND c.source_id = 'transcript:' || t.id
      )
    LIMIT 1
  `).get();
  if (pendingTranscript) return { pending: true, reason: 'new transcripts to chunk' };

  // st_d142f701 AC3: health rows. Check both health_notes and
  // health_data_points so the worker fires when new sync data lands.
  const pendingHealthNote = database.prepare(`
    SELECT 1 FROM health_notes hn
    WHERE hn.content IS NOT NULL AND LENGTH(TRIM(hn.content)) > 0
      AND NOT EXISTS (
        SELECT 1 FROM chunks c
        WHERE c.source_type = 'health' AND c.source_id = 'health_note:' || hn.id
      )
    LIMIT 1
  `).get();
  if (pendingHealthNote) return { pending: true, reason: 'new health notes to chunk' };

  const pendingHealthDp = database.prepare(`
    SELECT 1 FROM health_data_points dp
    WHERE dp.excluded = 0 AND dp.value IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM chunks c
        WHERE c.source_type = 'health' AND c.source_id = 'health_dp:' || dp.id
      )
    LIMIT 1
  `).get();
  if (pendingHealthDp) return { pending: true, reason: 'new health data points to chunk' };

  return { pending: false, reason: null };
}

/**
 * How many chunks still wait to be embedded? A single indexed COUNT.
 * @returns {number}
 */
export function pendingEmbedCount(database = db) {
  return database.prepare(`
    SELECT COUNT(*) AS n FROM chunks WHERE embedded = 0 AND skip_embed = 0
  `).get().n;
}

/**
 * Check whether ANY of the chunk sources has pending work, AND/OR
 * whether the embed phase has rows queued. Returns a small struct so the
 * caller can decide to short-circuit before loading the local embedding model.
 *
 * st_f6315f0b: this is the no-load fast path. The chunkX() functions are
 * each individually cheap (SQL only), but Phase 2's embedBatch() loads a
 * local model even when 0 chunks are queued. Pre-checking
 * `chunks WHERE embedded=0 AND skip_embed=0` is a single indexed COUNT —
 * sub-millisecond on a corpus of any realistic size.
 *
 * NOTE on ordering (st_b50005df): this function still reports embed first for
 * the fast-path "should I bother loading the model?" question. It must NOT be
 * used to DECIDE which job to enqueue — that decision re-derives both needs
 * independently via hasPendingChunkSources() + pendingEmbedCount(). Using this
 * struct's single `reason` to pick a job is exactly the bug that froze the
 * chunker on 2026-06-03.
 */
export function hasPendingWork() {
  // Embed phase: do any rows wait to be embedded?
  // st_2cd1af73 — when the daemon owns embedding, the embed backlog is NOT the
  // worker's work; counting it here would make the worker load every fire while
  // an embed backlog exists, even though its drain now skips embedding_topic.
  // The daemon drains the backlog; the worker only reports chunk-source work.
  if (!daemonOwnsEmbedding()) {
    const embedN = pendingEmbedCount();
    if (embedN > 0) {
      return { hasWork: true, reason: `${embedN} chunks pending embed` };
    }
  }

  // Chunk phase: are there new sources to chunk?
  const chunkSources = hasPendingChunkSources();
  if (chunkSources.pending) {
    return { hasWork: true, reason: chunkSources.reason };
  }

  // iMessage: gated by chat.db file existence + backoff window (separate
  // failure path). We do NOT probe chat.db here — that's chunkIMessages's
  // job under its own backoff. If chat.db is reachable, the next fire will
  // produce work; if not, the backoff will skip. Either way, no need to
  // load the local embedding model just for iMessage chunking.

  return { hasWork: false, reason: 'all sources empty' };
}

// Base priority floor for an embedding_topic job. The cross-topic value bonus
// (0..VALUE_PRIORITY_SPAN) is added on top, so a high-value topic outranks the
// chunk_source_scan job (priority 60) while a low-value topic sits below it —
// the chunker always wins ties so new source rows never starve behind a long
// embed tail. Env-overridable per the no-hardcoded-tunables rule.
const EMBED_PRIORITY_BASE = positiveInt(process.env.ROBOTDOJO_EMBED_PRIORITY_BASE, 40);
const VALUE_PRIORITY_SPAN = positiveInt(process.env.ROBOTDOJO_EMBED_PRIORITY_SPAN, 40);

/**
 * Per-topic value score for cross-topic embed ordering (st_b50005df, AC-2a).
 *
 * Intra-topic ordering already prefers high-signal source types + content_rank
 * (see lib/rag/embed.js fetchBatch). This adds the missing CROSS-topic axis:
 * which topic should embed FIRST so the user's highest-value world is citable
 * in the first session while the long tail finishes.
 *
 * The score blends two truths, both read from the source of truth (no LLM):
 *   - high-value share: fraction of a topic's un-embedded chunks that are
 *     high-signal (content_rank <= 1 — iMessage/transcript/meeting). Lower
 *     content_rank = higher signal (migration 053).
 *   - linked-entity density: fraction of a topic's un-embedded chunks that are
 *     linked to a known person/company/place via chunk_entities — the chunks
 *     that prove "knows your world".
 *
 * Both are in [0,1]; their average × VALUE_PRIORITY_SPAN is the priority bonus.
 * A topic with no un-embedded chunks scores 0 (it will not be enqueued anyway).
 *
 * @param {object} database
 * @param {string} topic
 * @returns {number} value score in [0,1]
 */
export function topicValueScore(database, topic) {
  const row = database.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN content_rank <= 1 THEN 1 ELSE 0 END) AS high_value,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM chunk_entities ce WHERE ce.chunk_id = c.id
      ) THEN 1 ELSE 0 END) AS entity_linked
    FROM chunks c
    WHERE c.topic = ? AND c.embedded = 0 AND c.skip_embed = 0
  `).get(topic);
  return valueScoreFromCounts(row?.total || 0, row?.high_value || 0, row?.entity_linked || 0);
}

/**
 * st_fd14cdd4 — pure value-score formula, the single source of truth shared by
 * topicValueScore (live correlated-subquery path, kept for fixtures/un-ranked
 * rows) AND the embed daemon's value_rank-based work order. Both feed the SAME
 * (highValueShare + entityDensity)/2 here so the two paths never drift.
 *
 * WHY a second caller exists (the daemon): topicValueScore's per-chunk
 * EXISTS(chunk_entities) correlated subquery was MEASURED at ~7s for the `personal`
 * topic's 276k pending rows, and daemonWorkOrder ran it for every topic on every
 * derive — a ~55s scan on the daemon's shared SQLCipher connection that blocked a
 * chat turn landing during it for the full derive (LIVE: TTFT 52s). The daemon now
 * derives entity-linkedness from the precomputed chunks.value_rank in its single
 * GROUP BY scan (value_rank >= the entity term ⇒ entity-linked; see lib/db.js
 * VALUE_RANK_ENTITY_TERM), cutting the derive to ~1.4s. The arithmetic is identical
 * — this helper guarantees that. content_rank<=1 is the high-value share both ways.
 *
 * @param {number} total      un-embedded chunk count for the topic
 * @param {number} highValue  count with content_rank <= 1 (high-signal sources)
 * @param {number} entityLinked count linked to a known entity
 * @returns {number} value score in [0,1] (0 when total is 0)
 */
export function valueScoreFromCounts(total, highValue, entityLinked) {
  const t = Number(total) || 0;
  if (t === 0) return 0;
  const highValueShare = (Number(highValue) || 0) / t;
  const entityDensity = (Number(entityLinked) || 0) / t;
  return (highValueShare + entityDensity) / 2;
}

/**
 * Map a topic's value score to a passive-job priority. Higher score → higher
 * priority → embeds first.
 */
export function embedPriorityForTopic(database, topic) {
  const score = topicValueScore(database, topic);
  return embedPriorityFromScore(score);
}

/**
 * st_fd14cdd4 — value score → passive-job priority, shared by embedPriorityForTopic
 * and the daemon's value_rank-based work order so the priority math is defined once.
 * @param {number} score value score in [0,1]
 * @returns {number} priority (>= EMBED_PRIORITY_BASE)
 */
export function embedPriorityFromScore(score) {
  return EMBED_PRIORITY_BASE + Math.round((Number(score) || 0) * VALUE_PRIORITY_SPAN);
}

export function enqueuePendingEmbeddingJobs({ database = db } = {}) {
  const pendingTopics = database.prepare(`
    SELECT DISTINCT topic FROM chunks WHERE embedded = 0 AND skip_embed = 0
  `).all().map(r => r.topic);
  return pendingTopics.map((topic) => enqueuePassiveJob({
    database,
    jobType: 'embedding_topic',
    uniqueKey: `embedding-topic:${topic}`,
    targetType: 'topic',
    targetId: topic,
    payload: { topic },
    // st_b50005df (AC-2a): cross-topic priority. The topic carrying the user's
    // highest-value, highest-entity-density un-embedded chunks embeds first, so
    // the first session has depth while the long tail finishes. Replaces the
    // old fixed priority: 40.
    priority: embedPriorityForTopic(database, topic),
    // st_27561b77 (expansion) — bumped from 120s to 300s. With
    // ROBOTDOJO_EMBED_MAX_BATCHES=8 (set in the persistent worker plist)
    // each slice does at most 8 internal batches ≈ 30-60s under normal
    // load, but a slow CPU window or memory contention can stretch a
    // single batch to several seconds. 300s gives headroom so the
    // passive_jobs watchdog never quarantines a job whose work was
    // committing fine but the slice ran long.
    timeoutMs: 300_000,
    metadata: { source: 'chunk-worker' },
    requeueDone: true,
  }));
}

/**
 * Re-derive ALL outstanding background work from the source of truth and
 * enqueue a job for each need. This runs every worker fire.
 *
 * WHY re-derive both needs independently (st_b50005df — the freeze fix): the
 * old code asked hasPendingWork() for a SINGLE reason and, because embed was
 * checked first, enqueued ONLY embedding jobs whenever any chunk was unembedded.
 * With 66% of the corpus perpetually unembedded, the chunk_source_scan job was
 * never re-enqueued — so new emails/calendar/transcripts arriving after the
 * last scan were never chunked. The scan froze `done` on 2026-06-03 and stayed
 * frozen. The fix: enqueue chunk_source_scan when new source rows exist AND
 * embedding_topic when unembedded chunks exist — neither can starve the other.
 */
export function enqueueChunkWorkerJobs({ database = db } = {}) {
  const queued = [];

  // Need 1 — new source rows to chunk. Re-derived independently of embed.
  const chunkSources = hasPendingChunkSources();
  if (chunkSources.pending) {
    queued.push(enqueuePassiveJob({
      database,
      jobType: 'chunk_source_scan',
      uniqueKey: 'chunk-source-scan',
      targetType: 'system',
      targetId: 'chunks',
      payload: { reason: chunkSources.reason },
      priority: 60,
      timeoutMs: 120_000,
      metadata: { source: 'chunk-worker' },
      requeueDone: true,
    }));
  }

  // Need 2 — un-embedded chunks. Re-derived independently of the chunk scan.
  // st_2cd1af73 — skipped entirely when the daemon owns embedding: the daemon
  // drains the backlog directly off `chunks WHERE embedded=0`, no job needed,
  // and a worker-enqueued embed job would just race the daemon's writer.
  const embedN = daemonOwnsEmbedding() ? 0 : pendingEmbedCount();
  if (embedN > 0) {
    queued.push(...enqueuePendingEmbeddingJobs({ database }));
  }

  const pending = {
    hasWork: queued.length > 0,
    chunkScan: chunkSources.pending ? chunkSources.reason : null,
    pendingEmbed: embedN,
  };
  return { pending, queued };
}

export async function runChunkSourceScan(signal = null, {
  shouldYield = null,
  scanners = {},
} = {}) {
  // st_fd14cdd4 — mid-job chat-yield. A source scan runs 6 source scanners back to
  // back; a single scan can exceed the 5s chat bar, and the per-JOB idleCheck only
  // stops BEFORE the next job — it cannot interrupt this one. So at the SAME source
  // boundaries the scan already checks signal?.aborted, it also asks shouldYield():
  // when the chat app has opened mid-scan, it throws the SAME AbortError, which the
  // passive-job handler routes to the benign `{aborted:true}` re-queue path — no
  // work is lost and the scan resumes from the next source on the next round once
  // chat closes. Each individual chunkX() scanner is the bounded unit (sub-5s), so
  // the longest a chat turn can wait behind this job is one source scanner.
  const cut = () => {
    if (signal?.aborted) throw new DOMException('chunk source scan aborted', 'AbortError');
    if (typeof shouldYield === 'function' && shouldYield()) {
      throw new DOMException('chunk source scan yielding to chat', 'AbortError');
    }
  };
  const sourceScanners = {
    emails: chunkEmails,
    calendar: chunkCalendarEvents,
    imessage: chunkIMessages,
    transcripts: chunkTranscripts,
    health: chunkHealthNotes,
    dropFolderFiles: chunkDropFolderFiles,
    ...scanners,
  };
  const stats = {
    emails: await sourceScanners.emails(),
  };
  cut();
  stats.calendar = await sourceScanners.calendar();
  cut();
  stats.imessage = await sourceScanners.imessage();
  cut();
  stats.transcripts = await sourceScanners.transcripts();
  cut();
  stats.health = await sourceScanners.health();
  cut();
  stats.dropFolderFiles = await sourceScanners.dropFolderFiles();
  cut();
  return stats;
}

export async function runEmbeddingTopicJob(job, signal = null) {
  const topic = job?.payload?.topic || job?.target_id;
  if (!topic) throw new Error('embedding topic job missing topic');
  const result = await embedChunks(topic, signal, {
    maxBatches: manualEmbedBatchLimit() || 0,
    idleGateWorkerName: 'chunk-embed-worker',
  });
  if (result?.error) throw new Error(result.error);
  // st_b50005df Phase 2 — propagate idle/signal abort so the passive-job
  // handler re-queues this job benignly (attempts unchanged) instead of
  // marking the topic done while chunks remain unembedded. runPassiveJob reads
  // `{ aborted: true }` and routes to requeuePassiveJob.
  if (result?.aborted) {
    const reason = result.abortReason === 'rss-ceiling'
      ? 'embed rss-ceiling restart'
      : 'embed idle/signal abort';
    return { aborted: true, reason, ...result };
  }
  return result || { ok: true };
}

/**
 * Handler for an `entity_enrich` passive job (st_b50005df Phase 4).
 *
 * Enriches one bounded, highest-value-first slice of the needs_regen backlog via
 * runEnrichmentSlice (which reuses the tier-then-score selector). Rides the same
 * lease/reconciler discipline as embedding: an idle/SIGTERM abort is propagated
 * as `{ aborted: true }` so the passive-job handler re-queues it benignly
 * (attempts unchanged) instead of marking it done while needs_regen rows remain.
 *
 * The `enrich` argument is forwarded to runEnrichmentSlice so tests can inject a
 * fixture enricher and exercise the full queue path with zero model spend.
 *
 * @param {object} job
 * @param {AbortSignal} [signal]
 * @param {object} [opts]
 * @param {Function} [opts.enrich] injectable enrichEntity for tests
 * @returns {Promise<object>}
 */
export async function runEntityEnrichJob(job, signal = null, { enrich } = {}) {
  const result = await runEnrichmentSlice(db, {
    belt: process.env.BELT || 'black',
    signal,
    ...(enrich ? { enrich } : {}),
  });
  if (result.aborted) {
    return { aborted: true, reason: 'enrich idle/signal abort', ...result };
  }
  return result;
}

export async function drainChunkWorkerJobs({
  worker = 'chunk-worker',
  limit = positiveInt(process.env.ROBOTDOJO_CHUNK_WORKER_DRAIN_LIMIT, 3),
  signal = null,
  enrichEnabled = false,
  enrich = undefined,
  // st_fd14cdd4 — per-JOB chat-yield. drainPassiveJobs invokes idleCheck BEFORE
  // each job is acquired and breaks the drain (without starting the next job)
  // when it returns { ok:false }. The worker wires this to "chat app is open" so
  // the drain stops at the per-job boundary — the tightest committed-state seam —
  // the moment a human opens chat, instead of finishing the whole DRAIN_LIMIT
  // round first. Forwarded straight through; the supervisor's own idle gate uses
  // the same idleCheck hook, so this re-uses the proven pattern, not a new one.
  idleCheck = null,
} = {}) {
  // st_b50005df Phase 4 — entity_enrich is drained on the SAME worker only when
  // enrichment is enabled on this box (BB active + no owner-box opt-out). When
  // paused, the type is excluded so a stray enqueued job is never drained
  // (no spend). The handler is registered either way for test injection.
  // st_2cd1af73 — exclude embedding_topic when the daemon owns embedding so the
  // worker never drains an embed job (no model reload, no WAL-writer race with
  // the daemon). The handler stays registered for test injection.
  const embedTypes = daemonOwnsEmbedding() ? [] : ['embedding_topic'];
  const jobTypes = enrichEnabled
    ? ['chunk_source_scan', ...embedTypes, 'entity_enrich']
    : ['chunk_source_scan', ...embedTypes];
  return drainPassiveJobs({
    worker,
    jobTypes,
    limit,
    idleCheck,
    // st_27561b77 (expansion) — 5-min lease matches the embedding_topic
    // timeoutMs. The default 30 s lease was expiring during long batches
    // (under contention the model takes 15-120 s per 8-chunk batch). When
    // the lease expired, recoverClaimableJobs swept the job back to
    // 'queued' and the next drain picked it up — racing the still-running
    // handler. The result was attempts climbing past max_attempts without
    // anything actually committing. A 5-min lease covers a full bounded
    // slice (ROBOTDOJO_EMBED_MAX_BATCHES=8) so the handler holds its lease
    // for the slice's lifetime.
    leaseMs: 5 * 60_000,
    handlers: {
      chunk_source_scan: async () => {
        // st_fd14cdd4 — derive a mid-scan yield predicate from the same idleCheck
        // the drain uses between jobs, so the scan stops at its next source
        // boundary the instant chat opens (the per-job idleCheck cannot interrupt
        // an already-running scan). Re-queues benignly via the {aborted:true} path.
        const shouldYield = typeof idleCheck === 'function'
          ? () => { try { return idleCheck()?.ok === false; } catch { return false; } }
          : null;
        const stats = await runChunkSourceScan(signal, { shouldYield });
        // st_2cd1af73 — when the daemon owns embedding, a scan does NOT enqueue
        // embed jobs (the daemon drains off truth directly). Only enqueue here
        // in the legacy worker-owned mode.
        const queuedEmbeddings = daemonOwnsEmbedding() ? [] : enqueuePendingEmbeddingJobs();
        return { stats, queued_embeddings: queuedEmbeddings.length };
      },
      embedding_topic: (job) => runEmbeddingTopicJob(job, signal),
      entity_enrich: (job) => runEntityEnrichJob(job, signal, { enrich }),
    },
  });
}

/**
 * Orchestrate: chunk all sources, then embed all pending chunks.
 * Guard against concurrent invocations — returns immediately if already running.
 *
 * @param {AbortSignal} [signal] - Optional abort signal for SIGTERM-driven cancel.
 *   Forwarded to embedChunks so in-flight local embedding batches abort cleanly.
 */
export async function runChunkWorker(signal = null) {
  if (workerRunning) {
    console.log('[chunk-worker] already running — skipping');
    return;
  }
  workerRunning = true;

  try {
    // Phase 1: chunk all sources
    mirrorPassiveJobStatus(db, {
      jobType: 'chunk_source_scan',
      uniqueKey: 'chunk-source-scan',
      targetType: 'system',
      targetId: 'chunks',
      status: 'running',
      metadata: { source: 'chunk-worker' },
    });
    try {
      const stats = {
        emails: await chunkEmails(),
      };
      if (signal?.aborted) { console.log('[chunk-worker] aborted after chunkEmails'); return; }
      stats.calendar = await chunkCalendarEvents();
      if (signal?.aborted) { console.log('[chunk-worker] aborted after chunkCalendarEvents'); return; }
      stats.imessage = await chunkIMessages();
      if (signal?.aborted) { console.log('[chunk-worker] aborted after chunkIMessages'); return; }
      stats.transcripts = await chunkTranscripts();
      if (signal?.aborted) { console.log('[chunk-worker] aborted after chunkTranscripts'); return; }
      stats.health = await chunkHealthNotes();
      if (signal?.aborted) { console.log('[chunk-worker] aborted after chunkHealthNotes'); return; }
      mirrorPassiveJobStatus(db, {
        jobType: 'chunk_source_scan',
        uniqueKey: 'chunk-source-scan',
        targetType: 'system',
        targetId: 'chunks',
        status: 'ok',
        metadata: { source: 'chunk-worker', stats },
      });
    } catch (err) {
      mirrorPassiveJobStatus(db, {
        jobType: 'chunk_source_scan',
        uniqueKey: 'chunk-source-scan',
        targetType: 'system',
        targetId: 'chunks',
        status: 'error',
        error: err.message,
        metadata: { source: 'chunk-worker' },
      });
      throw err;
    }

    // Phase 2: embed all pending chunks (grouped by topic).
    // st_2cd1af73 — skipped when the daemon owns embedding: the long-lived
    // chunk-embed-daemon drains the backlog directly, so this in-worker embed
    // loop would reload the model and race the daemon on the single WAL writer.
    const pendingTopics = daemonOwnsEmbedding()
      ? []
      : db.prepare(`
          SELECT DISTINCT topic FROM chunks WHERE embedded = 0 AND skip_embed = 0
        `).all().map(r => r.topic);

    let remainingManualBatches = manualEmbedBatchLimit();
    for (const topic of pendingTopics) {
      if (signal?.aborted) { console.log('[chunk-worker] aborted before embedChunks'); return; }
      try {
        mirrorPassiveJobStatus(db, {
          jobType: 'embedding_topic',
          uniqueKey: `embedding-topic:${topic}`,
          targetType: 'topic',
          targetId: topic,
          status: 'running',
          metadata: { source: 'chunk-worker' },
        });
        const result = await embedChunks(topic, signal, {
          maxBatches: remainingManualBatches || 0,
          idleGateWorkerName: 'chunk-embed-worker',
        });
        if (result.error) {
          throw new Error(result.error);
        }
        mirrorPassiveJobStatus(db, {
          jobType: 'embedding_topic',
          uniqueKey: `embedding-topic:${topic}`,
          targetType: 'topic',
          targetId: topic,
          status: 'ok',
          metadata: { source: 'chunk-worker', result },
        });
        if (remainingManualBatches) {
          remainingManualBatches -= result.batches || 0;
          if (remainingManualBatches <= 0) {
            console.log('[chunk-worker] manual embed batch limit reached');
            return;
          }
        }
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) {
          console.log(`[chunk-worker] embedChunks aborted for topic "${topic}"`);
          return;
        }
        mirrorPassiveJobStatus(db, {
          jobType: 'embedding_topic',
          uniqueKey: `embedding-topic:${topic}`,
          targetType: 'topic',
          targetId: topic,
          status: 'error',
          error: err.message,
          metadata: { source: 'chunk-worker' },
        });
        console.error(`[chunk-worker] embedChunks failed for topic "${topic}":`, err.message);
      }
    }

    console.log('[chunk-worker] cycle complete');
  } catch (err) {
    console.error('[chunk-worker] runChunkWorker error:', err.message);
  } finally {
    workerRunning = false;
  }
}
