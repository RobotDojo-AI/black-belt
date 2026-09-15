#!/usr/bin/env node
/**
 * backfill-participants.js — retroactive people capture (st_fd14cdd4 AC7).
 *
 * Past traffic whose people identifiers were never processed gets them
 * captured retroactively, per source:
 *
 *   --source microsoft   Graph re-fetch of stored message ids with
 *                        $select=toRecipients,ccRecipients,from (the fields
 *                        the pre-st_fd14cdd4 sync never requested), then
 *                        participants + sender seeding via lib/people-seed.js.
 *
 *   --source granola     Stored transcripts with empty attendee_emails get
 *                        attendees from (a) a provider re-read when a Granola
 *                        token is available, else (b) the deterministic
 *                        calendar join (exact title + same-day match against
 *                        calendar_events — lib/granola-sync.js
 *                        findCalendarAttendees). Updates attendee_emails,
 *                        seeds create-or-link, writes channel-'meeting'
 *                        interactions. Unmatched transcripts are a REPORTED
 *                        residual, never invented.
 *
 *   --source dropfolder  Two passes. (1) Tier-0 sender pass: pure SQL inserts
 *                        sender participants for every dropfolder email, then
 *                        seeds distinct non-newsletter senders. (2) To/Cc
 *                        re-parse of retained source files listed in
 *                        drop_folder_files — files deleted from disk (the
 *                        /tmp import staging was wiped) are counted as
 *                        residual: their To/Cc are unrecoverable.
 *
 *   --source providersweep --account <gmail>
 *                        Provider-history sweep (owner directive: imported
 *                        emails MUST carry To/Cc; the import source files are
 *                        deleted but the headers still exist provider-side).
 *                        Pages a CONNECTED Gmail mailbox newest→oldest via
 *                        messages.list + metadata-format gets (Message-ID /
 *                        To / Cc / From headers only — no bodies), derives
 *                        the deterministic dropfolder id from each
 *                        Message-ID (dropfolderIdCandidates mirrors
 *                        lib/drop-folder/route-email.js dropFolderEmailId),
 *                        and writes participants + sender seeding onto every
 *                        matching dropfolder row. Cursor (epoch-seconds
 *                        `before:` watermark) persists in the google
 *                        accounts row metadata, so bounded slices resume.
 *
 *   --source mshistory --account <mailbox>
 *                        Microsoft full-history walk (owner directive 2: the
 *                        mailbox holds months of mail; sync only captured
 *                        the post-registration window). Walks BACKWARD from
 *                        the oldest stored message via Graph
 *                        `receivedDateTime lt` passes
 *                        (lib/outlook-sync.js syncOutlookHistorySlice),
 *                        storing rows + participants + seeding through the
 *                        exact live-sync path. Watermark = MIN(received_at)
 *                        in the DB — no cursor table; restart-safe.
 *
 * Bounded: --max-seconds N (default 240, the maintenance slice budget) stops
 * cleanly mid-source; re-running resumes (every write is INSERT OR IGNORE /
 * idempotent). --limit N caps per-source items for smoke runs. --dry-run
 * reports without writing.
 *
 * WAL discipline (build-conventions): a re-runnable batch transaction is
 * preceded by `wal_checkpoint(RESTART)` so an interrupted prior session's
 * reader marks cannot wedge this run in SQLITE_BUSY_SNAPSHOT.
 *
 * === Compute Tier Protocol ===
 * Tier 0 only: SQL + header parsing + Graph/Granola REST metadata fetches.
 * No LLM anywhere (identity is never an LLM decision).
 */

export const INTELLIGENCE_TIER = 'extraction';

import { existsSync } from 'node:fs';
import db from '../lib/db.js';
import { recordEmailParticipants, seedEmailContact, seedTranscriptAttendees } from '../lib/people-seed.js';
import { findCalendarAttendees } from '../lib/granola-sync.js';
import { parseAddressList } from '../lib/email.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SOURCE = args[args.indexOf('--source') + 1];
const ACCOUNT = args.includes('--account') ? args[args.indexOf('--account') + 1] : null;
const RESTART = args.includes('--restart');
const MAX_SECONDS = args.includes('--max-seconds') ? Number(args[args.indexOf('--max-seconds') + 1]) : 240;
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : null;
const BUDGET_RESERVE_SECONDS = Number(process.env.ROBOTDOJO_PARTICIPANTS_BACKFILL_BUDGET_RESERVE_SECONDS || 75);

const startedAt = Date.now();

export function effectiveParticipantBackfillBudgetSeconds(maxSeconds = MAX_SECONDS, reserveSeconds = BUDGET_RESERVE_SECONDS) {
  const max = Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0 ? Number(maxSeconds) : 240;
  const reserve = Number.isFinite(Number(reserveSeconds)) && Number(reserveSeconds) > 0 ? Number(reserveSeconds) : 75;
  return Math.max(1, Math.floor(max - Math.min(reserve, Math.max(0, max / 2))));
}

const outOfBudget = () => (Date.now() - startedAt) / 1000 >= effectiveParticipantBackfillBudgetSeconds();

function log(msg) {
  process.stderr.write(`[backfill-participants] ${msg}\n`);
}

function walCheckpoint() {
  // Build-conventions: re-runnable batch writes checkpoint the WAL first so a
  // killed prior session's reader marks cannot hang this transaction.
  try { db.pragma('wal_checkpoint(RESTART)'); } catch { /* read-only / busy — proceed */ }
}

// The live DB runs under continuous writers (embed lanes) and periodic
// forced WAL TRUNCATEs that hold an exclusive lock well past the singleton's
// 30s busy_timeout. This script's transactions are short; the only failure
// mode is lock ACQUISITION — so this process waits longer instead of failing
// a whole slice. Scoped to this connection/process only.
function widenBusyTimeout() {
  try { db.pragma('busy_timeout = 120000'); } catch { /* read-only — proceed */ }
}

// ── Microsoft: Graph re-fetch of stored messages ────────────────────────────

async function backfillMicrosoft() {
  const { getValidMicrosoftAccessToken } = await import('../lib/microsoft-oauth.js');
  const result = { source: 'microsoft', scanned: 0, updated: 0, seeded: 0, errors: 0, residual: 0, partial: false };

  // Messages from Microsoft accounts that have no to/cc participant rows yet.
  const rows = db.prepare(`
    SELECT e.id, e.sender, e.sender_email, e.is_newsletter, a.email AS mailbox
      FROM emails e
      JOIN accounts a ON a.id = e.account_id
     WHERE a.vendor = 'microsoft'
       AND NOT EXISTS (
         SELECT 1 FROM email_participants ep
          WHERE ep.email_id = e.id AND ep.role IN ('to','cc')
       )
     ${LIMIT ? 'LIMIT ' + Math.floor(LIMIT) : ''}
  `).all();
  result.scanned = rows.length;
  if (!rows.length || DRY_RUN) return result;

  walCheckpoint();
  const byMailbox = new Map();
  for (const row of rows) {
    if (!byMailbox.has(row.mailbox)) byMailbox.set(row.mailbox, []);
    byMailbox.get(row.mailbox).push(row);
  }

  for (const [mailbox, messages] of byMailbox) {
    let token;
    try {
      token = await getValidMicrosoftAccessToken(mailbox);
    } catch (err) {
      log(`microsoft: token failed for ${mailbox}: ${err.message}`);
      result.errors += messages.length;
      continue;
    }
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages`;
    // Sequential single-message fetches: 67 stored messages live — trivial
    // volume; per-message GETs keep 429 handling simple (skip + count).
    for (const row of messages) {
      if (outOfBudget()) { result.partial = true; break; }
      try {
        const res = await fetch(`${base}/${encodeURIComponent(row.id)}?$select=toRecipients,ccRecipients,from`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          // 404 = message deleted upstream — its recipients are unrecoverable.
          if (res.status === 404) result.residual++;
          else result.errors++;
          continue;
        }
        const msg = await res.json();
        const addresses = (list) => (Array.isArray(list) ? list : [])
          .map((r) => String(r?.emailAddress?.address || '').trim().toLowerCase())
          .filter((addr) => addr.includes('@'));
        const fromAddress = String(msg.from?.emailAddress?.address || row.sender_email || '').trim().toLowerCase();
        const seeded = recordEmailParticipants(db, row.id, {
          sender: { email: fromAddress, name: msg.from?.emailAddress?.name || row.sender || '' },
          to: addresses(msg.toRecipients),
          cc: addresses(msg.ccRecipients),
        }, { isNewsletter: !!row.is_newsletter, source: 'email' });
        result.updated++;
        if (seeded.seeded) result.seeded++;
      } catch (err) {
        result.errors++;
        log(`microsoft: ${row.id.slice(0, 18)}…: ${err.message}`);
      }
    }
  }
  return result;
}

// ── Granola: provider re-read when possible, calendar join always ───────────

async function backfillGranola() {
  const result = {
    source: 'granola', scanned: 0, updated: 0, seeded: 0, interactions: 0,
    provider_reads: 0, calendar_matches: 0, residual: 0, partial: false,
  };

  const rows = db.prepare(`
    SELECT id, meeting_id, title, meeting_date
      FROM transcripts
     WHERE source = 'granola'
       AND (attendee_emails IS NULL OR attendee_emails = '')
     ${LIMIT ? 'LIMIT ' + Math.floor(LIMIT) : ''}
  `).all();
  result.scanned = rows.length;
  if (!rows.length) return result;

  // Provider re-read is best-effort: at build time every local Granola token
  // was expired and the refresh endpoint rejected the stored refresh token,
  // so the calendar join is the working path until the Granola app mints
  // fresh tokens. The code path stays — a healthy token upgrades coverage.
  let providerDocs = null;
  try {
    const { getGranolaToken } = await import('../lib/granola-client.js');
    const token = await getGranolaToken();
    if (token) {
      const res = await fetch('https://api.granola.ai/v1/get-documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const body = await res.json();
        const docs = Array.isArray(body) ? body : (body?.documents || []);
        providerDocs = new Map(docs.map((doc) => [doc.id || doc.document_id, doc]));
      }
    }
  } catch (err) {
    log(`granola: provider read unavailable (${err.message}) — using calendar join only`);
  }

  const { extractAttendeeEmails } = await import('../lib/granola-client.js');
  const updateAttendees = db.prepare(`UPDATE transcripts SET attendee_emails = ? WHERE id = ?`);
  if (!DRY_RUN) walCheckpoint();

  for (const row of rows) {
    if (outOfBudget()) { result.partial = true; break; }

    let attendees = [];
    const doc = providerDocs?.get(row.meeting_id);
    if (doc) {
      attendees = extractAttendeeEmails(doc);
      if (attendees.length) result.provider_reads++;
    }
    if (!attendees.length) {
      attendees = findCalendarAttendees(db, row.title, row.meeting_date);
      if (attendees.length) result.calendar_matches++;
    }
    if (!attendees.length) {
      result.residual++; // ad-hoc meeting with no invite — honestly uncoverable
      continue;
    }
    if (DRY_RUN) { result.updated++; continue; }

    updateAttendees.run(attendees.map((a) => a.email).join(','), row.id);
    const seeded = seedTranscriptAttendees(db, {
      meetingId: row.meeting_id,
      date: row.meeting_date,
      attendees,
    }, { source: 'transcript' });
    result.updated++;
    result.seeded += seeded.seeded;
    result.interactions += seeded.interactions;
  }
  return result;
}

// ── Drop-folder: Tier-0 sender pass + To/Cc re-parse of retained files ──────

async function backfillDropfolder() {
  const result = {
    source: 'dropfolder', sender_rows: 0, senders_seeded: 0,
    files_present: 0, files_absent: 0, tocc_rows: 0, reparsed_messages: 0,
    residual_emails_without_tocc: 0, partial: false,
  };

  if (!DRY_RUN) {
    walCheckpoint();
    // Pass 1a — pure SQL: every dropfolder email's sender into the
    // interchange. One set-based statement; INSERT OR IGNORE dedupes.
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO email_participants (email_id, participant_email, role)
      SELECT id, lower(trim(sender_email)), 'sender'
        FROM emails
       WHERE id LIKE 'dropfolder:%'
         AND sender_email LIKE '%@%'
    `).run();
    result.sender_rows = inserted.changes;

    // Pass 1b — seed distinct non-newsletter senders create-or-link. The
    // blocklist inside seedEmailContact drops role accounts; newsletters are
    // excluded in SQL (Gmail's rule, generalized).
    const senders = db.prepare(`
      SELECT lower(trim(sender_email)) AS email, MAX(sender) AS name
        FROM emails
       WHERE id LIKE 'dropfolder:%'
         AND sender_email LIKE '%@%'
         AND is_newsletter = 0
       GROUP BY lower(trim(sender_email))
       ${LIMIT ? 'LIMIT ' + Math.floor(LIMIT) : ''}
    `).all();
    for (const sender of senders) {
      if (outOfBudget()) { result.partial = true; break; }
      const seeded = seedEmailContact(db, { email: sender.email, name: sender.name }, { source: 'email' });
      if (seeded) result.senders_seeded++;
    }
  }

  // Pass 2 — To/Cc re-parse of retained source files. dropFolderEmailId is
  // deterministic from Message-Id, so re-parsing a retained file matches the
  // stored rows and recordEmailParticipants back-fills to/cc idempotently.
  const files = db.prepare(`
    SELECT path FROM drop_folder_files WHERE doc_type LIKE 'email%'
  `).all();
  const present = files.filter((f) => existsSync(f.path));
  result.files_present = present.length;
  result.files_absent = files.length - present.length;

  if (present.length && !DRY_RUN) {
    const { routeEmail } = await import('../lib/drop-folder/route-email.js');
    for (const file of present) {
      if (outOfBudget()) { result.partial = true; break; }
      try {
        // routeEmail re-parses and re-inserts (INSERT OR IGNORE on the
        // deterministic id) — existing rows are skipped, but participants
        // are only written on first insert, so count to/cc rows directly.
        const before = db.prepare(`SELECT COUNT(*) c FROM email_participants WHERE email_id LIKE 'dropfolder:%' AND role IN ('to','cc')`).get().c;
        await routeEmail({ path: file.path });
        const after = db.prepare(`SELECT COUNT(*) c FROM email_participants WHERE email_id LIKE 'dropfolder:%' AND role IN ('to','cc')`).get().c;
        result.tocc_rows += after - before;
        result.reparsed_messages++;
      } catch (err) {
        log(`dropfolder: re-parse failed for ${file.path}: ${err.message}`);
      }
    }
  }

  result.residual_emails_without_tocc = db.prepare(`
    SELECT COUNT(*) c FROM emails e
     WHERE e.id LIKE 'dropfolder:%'
       AND NOT EXISTS (SELECT 1 FROM email_participants ep WHERE ep.email_id = e.id AND ep.role IN ('to','cc'))
  `).get().c;
  return result;
}

// ── Provider sweep helpers (shared by both modes) ───────────────────────────

/**
 * Candidate `emails.id` values for a provider Message-ID. Mirrors
 * lib/drop-folder/route-email.js dropFolderEmailId: `dropfolder:` + the
 * Message-Id stripped of angle brackets. The SECOND candidate matches the
 * legacy malformed shape — 60 live rows were stored as `dropfolder: <core`
 * because a folded Message-Id header kept its leading space, so the importer's
 * `^<` strip never fired. Both shapes must match or those rows stay
 * unrecoverable forever. Exported for unit tests.
 */
export function dropfolderIdCandidates(messageId) {
  const raw = String(messageId || '').trim();
  if (!raw) return [];
  const core = raw.replace(/^</, '').replace(/>$/, '').trim();
  if (!core) return [];
  return [`dropfolder:${core}`, `dropfolder: <${core}`];
}

function findHeaderValue(headers, name) {
  const lower = String(name).toLowerCase();
  return headers?.find((h) => String(h?.name || '').toLowerCase() === lower)?.value || '';
}

/** Best-effort From-header parse (name + address). Same shape gmail-sync uses. */
function parseFromHeader(from) {
  if (!from) return { name: '', email: '' };
  const m = String(from).match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/);
  const email = (m?.[2] || from).trim().toLowerCase();
  return { name: (m?.[1] || '').trim(), email: email.includes('@') ? email : '' };
}

/**
 * Sweep cursor persistence — lives in the connected account row's metadata
 * JSON (key `provider_sweep`) so slices resume across processes with no new
 * table and the state is visible wherever the account is inspected.
 */
function readSweepState(vendor, account) {
  const row = db.prepare(
    `SELECT metadata FROM accounts WHERE vendor=? AND type='email' AND email=? AND status IN ('active', 'connected')`,
  ).get(vendor, account);
  if (!row) return null;
  let meta = {};
  try { meta = JSON.parse(row.metadata || '{}') || {}; } catch { meta = {}; }
  return { meta, sweep: meta.provider_sweep || {} };
}

function writeSweepState(vendor, account, sweep) {
  const state = readSweepState(vendor, account);
  if (!state) return;
  const meta = { ...state.meta, provider_sweep: { ...sweep, updated_at: new Date().toISOString() } };
  // Best-effort: cursor persistence is resume OPTIMIZATION, not correctness —
  // every data write is INSERT OR IGNORE, so a lost cursor only re-processes.
  // A transient SQLITE_BUSY here (live DB under checkpoint/embed load) must
  // not turn a successful slice into an exit-1 failure.
  try {
    db.prepare(`UPDATE accounts SET metadata=?, updated_at=datetime('now') WHERE vendor=? AND type='email' AND email=?`)
      .run(JSON.stringify(meta), vendor, account);
  } catch (err) {
    log(`sweep-state write skipped for ${account}: ${err.message}`);
  }
}

// ── Gmail provider sweep: recover imported-email To/Cc from the mailbox ─────

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SWEEP_LIST_PAGE = 500;
const SWEEP_GET_CONCURRENCY = 20;
const SWEEP_MAX_BACKOFFS = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Authenticated Gmail JSON fetch with 429/quota backoff. A rate limit that
 * survives SWEEP_MAX_BACKOFFS throws an error tagged `rateLimited` so the
 * slice stops PARTIAL (passive re-enqueue retries later) instead of failing.
 */
async function gmailJson(url, token, { onBackoff = null } = {}) {
  let delay = 2_000;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => '');
    const rateLimited = res.status === 429
      || (res.status === 403 && /rate ?limit|quota|usage ?limit/i.test(body));
    if (rateLimited && attempt < SWEEP_MAX_BACKOFFS) {
      onBackoff?.();
      await sleep(delay);
      delay = Math.min(delay * 2, 60_000);
      continue;
    }
    const err = new Error(`Gmail ${res.status}: ${body.slice(0, 200)}`);
    err.rateLimited = rateLimited;
    throw err;
  }
}

/**
 * One bounded Gmail sweep slice. Injectable deps (`gmailJson`, `getToken`,
 * `budgetExceeded`) keep unit tests fixture-only — no live calls.
 */
export async function backfillProviderSweep(opts = {}) {
  const account = opts.account ?? ACCOUNT;
  const dryRun = opts.dryRun ?? DRY_RUN;
  const limit = opts.limit ?? LIMIT;
  const restart = opts.restart ?? RESTART;
  const budgetExceeded = opts.budgetExceeded ?? outOfBudget;
  const fetchJson = opts.gmailJson ?? gmailJson;

  const result = {
    source: 'providersweep', account, pages: 0, listed: 0, matched: 0,
    unmatched: 0, no_message_id: 0, tocc_rows: 0, seeded: 0, errors: 0,
    rate_limit_hits: 0, partial: false, done: false,
  };
  if (!account) throw new Error('providersweep requires --account <connected gmail address>');
  const state = readSweepState('google', account);
  if (!state) {
    result.error = `no active google email account row for ${account} — connect the mailbox first`;
    return result;
  }
  if (state.sweep.done && !restart) {
    result.done = true;
    result.cursor_before_sec = state.sweep.before_sec ?? null;
    return result;
  }

  let token;
  if (opts.getToken) token = await opts.getToken(account);
  else {
    const { getValidAccessToken } = await import('../lib/google-oauth.js');
    token = await getValidAccessToken(account);
  }
  if (!token) {
    result.error = `no valid Gmail token for ${account}`;
    return result;
  }

  const matchStmt = db.prepare(`SELECT id, is_newsletter FROM emails WHERE id IN (?, ?)`);
  if (!dryRun) { widenBusyTimeout(); walCheckpoint(); }

  let beforeSec = restart ? null : (Number(state.sweep.before_sec) || null);
  const onBackoff = () => { result.rate_limit_hits++; };

  while (!budgetExceeded()) {
    if (limit && result.listed >= limit) { result.partial = true; break; }

    const qs = new URLSearchParams({ maxResults: String(SWEEP_LIST_PAGE), includeSpamTrash: 'true' });
    if (beforeSec) qs.set('q', `before:${beforeSec}`);
    let page;
    try {
      page = await fetchJson(`${GMAIL_BASE}/messages?${qs}`, token, { onBackoff });
    } catch (err) {
      result.errors++;
      result.partial = true;
      result.error = err.message;
      log(`providersweep ${account}: list failed — ${err.message}`);
      break;
    }
    const ids = (page.messages || []).map((m) => m.id);
    if (!ids.length) {
      // Mailbox floor: nothing older than the cursor — the sweep is complete.
      result.done = true;
      break;
    }
    result.pages++;

    // Metadata-format gets: headers only, no bodies — the cheap fetch the
    // directive names. Both Message-ID spellings requested; matching is
    // case-insensitive on our side regardless.
    const headerQs = ['Message-ID', 'Message-Id', 'To', 'Cc', 'From']
      .map((h) => `metadataHeaders=${h}`).join('&');
    const fetched = [];
    for (let i = 0; i < ids.length; i += SWEEP_GET_CONCURRENCY) {
      if (budgetExceeded()) break;
      const chunk = ids.slice(i, i + SWEEP_GET_CONCURRENCY);
      const settled = await Promise.allSettled(chunk.map((id) => fetchJson(
        `${GMAIL_BASE}/messages/${id}?format=metadata&${headerQs}`, token, { onBackoff },
      )));
      for (const r of settled) {
        if (r.status === 'fulfilled') fetched.push(r.value);
        else result.errors++;
      }
    }

    let minInternalMs = null;
    const writePage = db.transaction((messages) => {
      for (const msg of messages) {
        const internalMs = Number(msg.internalDate);
        if (Number.isFinite(internalMs) && internalMs > 0) {
          minInternalMs = minInternalMs === null ? internalMs : Math.min(minInternalMs, internalMs);
        }
        const headers = msg.payload?.headers || [];
        const candidates = dropfolderIdCandidates(findHeaderValue(headers, 'Message-ID'));
        result.listed++;
        if (!candidates.length) { result.no_message_id++; continue; }
        const row = matchStmt.get(candidates[0], candidates[1]);
        if (!row) { result.unmatched++; continue; }
        result.matched++;
        if (dryRun) continue;
        const sender = parseFromHeader(findHeaderValue(headers, 'From'));
        const written = recordEmailParticipants(db, row.id, {
          sender,
          to: parseAddressList(findHeaderValue(headers, 'To')),
          cc: parseAddressList(findHeaderValue(headers, 'Cc')),
        }, { isNewsletter: !!row.is_newsletter, source: 'email' });
        result.tocc_rows += written.participants;
        if (written.seeded) result.seeded++;
      }
    });
    writePage(fetched);

    // Advance the cursor only past FULLY processed messages. +1s overlap:
    // `before:` is exclusive at second granularity, so the boundary second is
    // re-listed next slice — a few idempotent re-writes beat skipped messages.
    if (minInternalMs !== null) {
      const nextBefore = Math.floor(minInternalMs / 1000) + 1;
      if (beforeSec && nextBefore >= beforeSec) {
        // The page contained ONLY boundary-second messages — every one was
        // just (re)processed, so step strictly past that second or the same
        // page re-lists forever (live-run bug: a 93-message mailbox stalled
        // here at its floor). Bounded loss: none — the page is processed.
        beforeSec = beforeSec - 1;
      } else {
        beforeSec = nextBefore;
      }
      if (!dryRun) {
        writeSweepState('google', account, {
          before_sec: beforeSec,
          listed: (Number(state.sweep.listed) || 0) + result.listed,
          matched: (Number(state.sweep.matched) || 0) + result.matched,
        });
      }
    }
  }

  if (!result.done && !result.partial) result.partial = true; // budget stop
  if (result.done && !dryRun) {
    writeSweepState('google', account, {
      done: true,
      before_sec: beforeSec,
      listed: (Number(state.sweep.listed) || 0) + result.listed,
      matched: (Number(state.sweep.matched) || 0) + result.matched,
    });
  }
  result.cursor_before_sec = beforeSec;
  return result;
}

// ── Microsoft full-history walk ──────────────────────────────────────────────

const MS_HISTORY_CHUNK = 200;

/**
 * One bounded Microsoft history slice: walk backward from the oldest stored
 * message until the mailbox floor or the slice budget. `historySlice` is
 * injectable for fixture-only unit tests.
 */
export async function backfillMicrosoftHistory(opts = {}) {
  const account = opts.account ?? ACCOUNT;
  const dryRun = opts.dryRun ?? DRY_RUN;
  const budgetExceeded = opts.budgetExceeded ?? outOfBudget;

  const result = {
    source: 'mshistory', account, passes: 0, synced: 0, errors: 0,
    provider_total: null, db_count_before: null, db_count_after: null,
    oldest_before: null, oldest_after: null, floor_reached: false, partial: false,
  };
  if (!account) throw new Error('mshistory requires --account <connected microsoft mailbox>');
  const acct = db.prepare(
    `SELECT id FROM accounts WHERE vendor='microsoft' AND type='email' AND email=? AND status IN ('active', 'connected')`,
  ).get(account);
  if (!acct) {
    result.error = `no active microsoft email account row for ${account} — connect the mailbox first`;
    return result;
  }

  const countStmt = db.prepare(`SELECT COUNT(*) c, MIN(received_at) oldest FROM emails WHERE account_id=?`);
  const before0 = countStmt.get(acct.id);
  result.db_count_before = before0.c;
  result.oldest_before = before0.oldest;

  let historySlice = opts.historySlice;
  if (!historySlice) {
    ({ syncOutlookHistorySlice: historySlice } = await import('../lib/outlook-sync.js'));
    // Probe-first (directive 2): one $top=1 request with the full $select +
    // $count verifies field availability AND captures the provider total so
    // coverage is checkable after the floor. A failed probe stops the run
    // with a visible error — never a silent walk against rejected fields.
    try {
      const { getValidMicrosoftAccessToken } = await import('../lib/microsoft-oauth.js');
      const token = await getValidMicrosoftAccessToken(account);
      const probeUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(account)}/messages`
        + `?$select=id,conversationId,subject,from,toRecipients,ccRecipients,bodyPreview,body,isRead,flag,receivedDateTime,internetMessageHeaders`
        + `&$top=1&$count=true`;
      const res = await fetch(probeUrl, {
        headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        result.error = `Graph $select probe failed: ${res.status} ${body.slice(0, 200)}`;
        return result;
      }
      const probe = await res.json();
      if (Number.isFinite(Number(probe['@odata.count']))) result.provider_total = Number(probe['@odata.count']);
    } catch (err) {
      result.error = `Graph probe failed: ${err.message}`;
      return result;
    }
  }

  if (!dryRun) { widenBusyTimeout(); walCheckpoint(); }
  let prevOldest = before0.oldest;
  let lockRetries = 0;
  while (!budgetExceeded()) {
    const { oldest } = countStmt.get(acct.id);
    const before = oldest ? new Date(oldest) : new Date();
    if (dryRun) { result.partial = true; break; }
    const pass = await historySlice(account, { before, maxMessages: opts.chunk || MS_HISTORY_CHUNK });
    result.passes++;
    result.synced += pass.synced || 0;
    if (pass.error) {
      // Transient lock contention (forced WAL TRUNCATE bursts on the live DB)
      // is retried within the slice budget; anything else stops the slice.
      if (/database is locked|SQLITE_BUSY/i.test(pass.error) && lockRetries < 5) {
        lockRetries++;
        log(`mshistory ${account}: lock contention — retry ${lockRetries}/5 in 15s`);
        await sleep(15_000);
        continue;
      }
      result.errors++;
      result.error = pass.error;
      result.partial = true;
      log(`mshistory ${account}: pass failed — ${pass.error}`);
      break;
    }
    lockRetries = 0;
    const { oldest: newOldest } = countStmt.get(acct.id);
    if ((pass.synced || 0) === 0 && newOldest === prevOldest) {
      // Floor: a pass strictly older than the stored-oldest added nothing.
      result.floor_reached = true;
      break;
    }
    prevOldest = newOldest;
  }
  if (!result.floor_reached && !result.error) result.partial = true; // budget stop

  const after = countStmt.get(acct.id);
  result.db_count_after = after.c;
  result.oldest_after = after.oldest;
  if (!dryRun) {
    writeSweepState('microsoft', account, {
      done: result.floor_reached,
      oldest: after.oldest,
      db_count: after.c,
      provider_total: result.provider_total,
    });
  }
  return result;
}

// ── Entry ────────────────────────────────────────────────────────────────────

const RUNNERS = {
  microsoft: backfillMicrosoft,
  granola: backfillGranola,
  dropfolder: backfillDropfolder,
  providersweep: backfillProviderSweep,
  mshistory: backfillMicrosoftHistory,
};

async function main() {
  const runner = RUNNERS[SOURCE];
  if (!runner) {
    process.stderr.write('usage: backfill-participants.js --source microsoft|granola|dropfolder|providersweep|mshistory [--account EMAIL] [--max-seconds N] [--limit N] [--dry-run] [--restart]\n');
    process.exit(2);
  }
  log(`start source=${SOURCE}${ACCOUNT ? ` account=${ACCOUNT}` : ''} max_seconds=${MAX_SECONDS} effective_budget=${effectiveParticipantBackfillBudgetSeconds()}${LIMIT ? ` limit=${LIMIT}` : ''}${DRY_RUN ? ' (dry-run)' : ''}`);
  const result = await runner();
  result.dry_run = DRY_RUN;
  result.duration_ms = Date.now() - startedAt;
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.partial) log('budget reached — re-run to continue (idempotent)');
}

// Import-safe entry guard (the backfill-email-history.js pattern): unit tests
// import the exported runners with fixture deps; only a direct CLI invocation
// runs main().
const _isMain = (() => {
  try {
    const url = new URL(import.meta.url);
    const argv1 = process.argv[1] || '';
    return url.pathname === argv1 || url.pathname.endsWith(argv1);
  } catch { return false; }
})();
if (_isMain) {
  main().catch((err) => {
    process.stderr.write(`[backfill-participants] fatal: ${err.message}\n`);
    process.exit(1);
  });
}
