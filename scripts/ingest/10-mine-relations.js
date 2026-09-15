#!/usr/bin/env node
/**
 * scripts/ingest/10-mine-relations.js — full-corpus possessive relation
 * mining sweep (st_f67bc2eb AC-5).
 *
 * Compute tier map (compute-tier protocol):
 *   Tier 0 — EVERYTHING in this sweep: SQL source reads, the quoted-reply
 *            strip (lib/junk-classifier.js), closed-vocabulary regex
 *            extraction (lib/relation-mine.js), deterministic exact-first
 *            name resolution, evidence clustering, and the write/question
 *            policy through lib/relation-store.js. No LLM on the bulk pass
 *            (owner directive), no LLM anywhere in this file.
 *
 * Sources and authorship (speaker-relative anchoring — the author comes from
 * envelope metadata, never in-text inference):
 *   chat        — the `messages` table, role='user' = the owner by definition
 *                 (conversation chunks hold ~4% of owner chat; the table is
 *                 the corpus).
 *   email       — `emails`. Sender ∈ ownerEmails() → owner-sent (stated,
 *                 owner authority via the cluster policy); other senders
 *                 resolve through person_identifiers and mine as third-party
 *                 statements re-anchored to their author. Quoted replies are
 *                 stripped first so another author's text can never ride a
 *                 message (lib/junk-classifier.js strippedBody).
 *   notes       — `notes` (owner-authored). Shared notes (is_shared=1) are
 *                 skipped, and the HARD guard lives in the cluster policy: a
 *                 notes-only cluster never writes an edge.
 *   transcripts — `transcript_segments` with resolved speakers: QUESTION
 *                 GENERATION ONLY (probabilistic attribution never writes).
 *
 * Re-runnable: evidence dedup by (kind, source_id) + question dedup keys make
 * the sweep idempotent. Coverage report (per-source scanned / matched /
 * written / queued / unresolved) → ~/.robotdojo/reports/
 * relation-mining-latest.json (+ dated copy) — the plan-sealed path;
 * 'reports' rides dot_robotdojo_entries in config/root-allowlist.lock.json
 * (added under this story's sealed AC-5 criterion, owner countersign at
 * commit).
 *
 * CLI: node scripts/ingest/10-mine-relations.js --report [--source chat|email|notes|transcripts]
 */
export const INTELLIGENCE_TIER = 'extraction';

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const onlySource = (() => {
  const i = args.indexOf('--source');
  return i >= 0 ? args[i + 1] : null;
})();

const REPORT_DIR = resolve(homedir(), '.robotdojo', 'reports');
const log = (m) => console.log(`[mine-relations] ${m}`);

const { default: db } = await import('../../lib/db.js');
const { extractRelationStatements, createMiningAccumulator, extractLlmExportUserText } = await import('../../lib/relation-mine.js');
const { classifyChunk } = await import('../../lib/junk-classifier.js');
const { ownerEmails, ownerPersonId } = await import('../../lib/identity.js');
const { refreshDerivedRelationCache } = await import('../../lib/people-write.js');

const ownerId = ownerPersonId();
if (!ownerId) {
  console.error('[mine-relations] owner_person_id missing from identity.json — statements cannot anchor');
  process.exit(1);
}
const ownerEmailSet = new Set(ownerEmails());

const acc = createMiningAccumulator(db, { ownerId });
const report = {
  started_at: new Date().toISOString(),
  sources: {
    chat: { scanned: 0, matched: 0 },
    email_sent: { scanned: 0, matched: 0 },
    email_received: { scanned: 0, matched: 0 },
    notes: { scanned: 0, matched: 0, skipped_shared: 0 },
    llm_export: { scanned: 0, matched: 0 },
    transcripts: { scanned: 0, matched: 0 },
  },
};

function runSource(name) {
  return !onlySource || onlySource === name;
}

// ── chat: the messages table (role = author; user = owner by definition) ────
if (runSource('chat')) {
  const rows = db.prepare(`
    SELECT m.id, m.content, m.created_at FROM messages m WHERE m.role = 'user'
  `).all();
  for (const m of rows) {
    report.sources.chat.scanned++;
    const statements = extractRelationStatements(m.content);
    if (!statements.length) continue;
    report.sources.chat.matched += statements.length;
    for (const s of statements) {
      acc.add(s, {
        authorPersonId: String(ownerId),
        authorIsOwner: true,
        evidence: { kind: 'mining-chat', source_id: `message:${m.id}`, date: m.created_at || null },
      });
    }
  }
  log(`chat: scanned=${report.sources.chat.scanned} matched=${report.sources.chat.matched}`);
}

// ── email: sender join = author; quoted replies stripped first ───────────────
if (runSource('email')) {
  const identStmt = db.prepare(
    "SELECT person_id FROM person_identifiers WHERE type = 'email' AND LOWER(value) = ? LIMIT 1",
  );
  const senderCache = new Map();
  const resolveSender = (email) => {
    const key = String(email || '').toLowerCase();
    if (!key) return null;
    if (senderCache.has(key)) return senderCache.get(key);
    const row = identStmt.get(key);
    const id = row ? String(row.person_id) : null;
    senderCache.set(key, id);
    return id;
  };
  // Newsletters/transactional mail never seed relationship statements — the
  // same SQL pre-filter the chunk pipeline uses.
  // Page the 300k-row scan by rowid so memory stays bounded, and BUFFER the
  // (tiny) matched-statement set per page: acc.add can write question rows,
  // and better-sqlite3 forbids writes while a read iterator is open on the
  // same connection.
  const pageStmt = db.prepare(`
    SELECT rowid AS rid, id, sender_email, subject, body_text, received_at FROM emails
    WHERE rowid > ? AND COALESCE(is_newsletter, 0) = 0 AND list_unsubscribe IS NULL
      AND body_text IS NOT NULL AND LENGTH(body_text) > 0
    ORDER BY rowid LIMIT 2000
  `);
  let cursor = 0;
  for (;;) {
    const page = pageStmt.all(cursor);
    if (!page.length) break;
    cursor = page[page.length - 1].rid;
    const buffered = [];
    for (const e of page) {
      const sender = String(e.sender_email || '').toLowerCase();
      const isOwner = ownerEmailSet.has(sender);
      const bucket = isOwner ? report.sources.email_sent : report.sources.email_received;
      bucket.scanned++;
      // Strip quoted replies + signatures so another author's words can never
      // count as this sender's statement (the classifier's strip pipeline).
      let body = e.body_text;
      try {
        const verdict = classifyChunk({ source_type: 'email', body, sender_email: e.sender_email, subject: e.subject });
        body = (verdict.strippedBody ?? body) || '';
      } catch { /* strip is best-effort; the raw body still mines */ }
      if (!body) continue;
      const statements = extractRelationStatements(body);
      if (!statements.length) continue;
      bucket.matched += statements.length;
      buffered.push({ statements, isOwner, sender, email: e });
    }
    for (const { statements, isOwner, sender, email } of buffered) {
      const authorPersonId = isOwner ? String(ownerId) : resolveSender(sender);
      // ALIAS-AUTHORSHIP guard (owner QC round): a sender address that
      // resolves to the OWNER's row via identifiers but is missing from
      // identity.json ownerEmails() is a split owner alias — the authorship
      // chain is untrustworthy (live case: old work addresses carrying
      // unstripped quoted third-party text became PYMK parent questions).
      // Skip entirely; register the alias so the owner can add it.
      if (!isOwner && String(authorPersonId || '') === String(ownerId)) {
        report.sources.email_received.alias_artifacts = (report.sources.email_received.alias_artifacts || 0) + 1;
        (report.owner_alias_candidates ||= new Set()).add(sender);
        continue;
      }
      for (const s of statements) {
        acc.add(s, {
          authorPersonId,
          authorIsOwner: isOwner,
          evidence: { kind: 'mining-email', source_id: `email:${email.id}`, date: email.received_at || null },
        });
      }
    }
  }
  log(`email: sent scanned=${report.sources.email_sent.scanned} matched=${report.sources.email_sent.matched}; received scanned=${report.sources.email_received.scanned} matched=${report.sources.email_received.matched}`);
}

// ── notes: owner-authored; shared notes skipped (defense-in-depth) ───────────
if (runSource('notes')) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, title, body, is_shared, COALESCE(modified_at, created_at) AS dated
      FROM notes
    `).all();
  } catch { rows = []; }
  for (const n of rows) {
    if (Number(n.is_shared) === 1) { report.sources.notes.skipped_shared++; continue; }
    report.sources.notes.scanned++;
    const text = [n.title, n.body].filter(Boolean).join('\n');
    const statements = extractRelationStatements(text);
    if (!statements.length) continue;
    report.sources.notes.matched += statements.length;
    for (const s of statements) {
      acc.add(s, {
        authorPersonId: String(ownerId),
        authorIsOwner: true,
        evidence: { kind: 'mining-notes', source_id: `note:${n.id}`, date: n.dated || null },
      });
    }
  }
  log(`notes: scanned=${report.sources.notes.scanned} matched=${report.sources.notes.matched} skipped_shared=${report.sources.notes.skipped_shared}`);
}

// ── llm_export: the owner's exported foundation-model chats ─────────────────
// Owner-directed this session ("i have given my family tree many times
// before, can you search"): User lines are the owner by construction;
// Assistant lines are machine text and are excluded rigorously
// (extractLlmExportUserText scans only User segments). Kinship statements
// here are the owner's own words — cross-instance-confirmed clusters write
// owner-touching kinship edges directly, and matching open questions
// auto-resolve with the mined provenance.
if (runSource('llm_export')) {
  const pageStmt = db.prepare(`
    SELECT rowid AS rid, id, source_id, content FROM chunks
    WHERE rowid > ? AND source_type = 'llm_export'
    ORDER BY rowid LIMIT 2000
  `);
  let cursor = 0;
  for (;;) {
    const page = pageStmt.all(cursor);
    if (!page.length) break;
    cursor = page[page.length - 1].rid;
    const buffered = [];
    for (const ch of page) {
      const { userText, date } = extractLlmExportUserText(ch.content);
      report.sources.llm_export.scanned++;
      if (!userText) continue;
      const statements = extractRelationStatements(userText);
      if (!statements.length) continue;
      report.sources.llm_export.matched += statements.length;
      buffered.push({ statements, date, chunk: ch });
    }
    for (const { statements, date, chunk } of buffered) {
      for (const s of statements) {
        acc.add(s, {
          authorPersonId: String(ownerId),
          authorIsOwner: true,
          evidence: { kind: 'mining-llm-export', source_id: `chunk:${chunk.source_id || chunk.id}:${chunk.id}`, date },
        });
      }
    }
  }
  log(`llm_export: scanned=${report.sources.llm_export.scanned} matched=${report.sources.llm_export.matched} (User lines only — Assistant text excluded)`);
}

// ── transcripts: question generation ONLY ────────────────────────────────────
if (runSource('transcripts')) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, text, speaker_person_id FROM transcript_segments
      WHERE speaker_person_id IS NOT NULL AND text IS NOT NULL
    `).all();
  } catch { rows = []; }
  for (const seg of rows) {
    report.sources.transcripts.scanned++;
    const statements = extractRelationStatements(seg.text);
    if (!statements.length) continue;
    report.sources.transcripts.matched += statements.length;
    for (const s of statements) {
      acc.add(s, {
        authorPersonId: String(seg.speaker_person_id),
        authorIsOwner: String(seg.speaker_person_id) === String(ownerId),
        // questionOnly: probabilistic speaker attribution never writes an
        // edge — every transcript candidate lands in the queue.
        questionOnly: true,
        evidence: { kind: 'mining-transcript', source_id: `segment:${seg.id}`, date: null },
      });
    }
  }
  log(`transcripts: scanned=${report.sources.transcripts.scanned} matched=${report.sources.transcripts.matched} (questions only)`);
}

// ── Apply the write/question policy, refresh the derived cache, report ──────
// Bounded retry: the chunk-embed daemon holds long write transactions and a
// WAL write-write conflict returns SQLITE_BUSY immediately (the documented
// crash-loop class — busy_timeout does not cover an open peer transaction).
// flush() is idempotent by evidence/question dedup, so re-running after a
// mid-flush loss is safe.
let stats;
for (let attempt = 1; ; attempt++) {
  try {
    stats = acc.flush();
    refreshDerivedRelationCache(db, { ownerId });
    break;
  } catch (err) {
    if (attempt >= 4 || !/SQLITE_BUSY|database is locked/i.test(String(err?.message || err?.code || ''))) throw err;
    log(`writer busy (attempt ${attempt}) — retrying in 10s: ${err.message}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

report.finished_at = new Date().toISOString();
report.results = stats;
// The AC-5 coverage criterion reads sources.chat / sources.email_sent /
// sources.notes with real scan counts — notes is broken out explicitly and an
// empty notes store reports an honest zero. Per-source write attribution
// lives in each edge's evidence list (kind = mining-chat/-email/-notes).
report.summary = {
  written: stats.written,
  queued: stats.queued,
  auto_resolved: stats.auto_resolved,
  conflicts: stats.conflicts,
  refused: stats.refused,
  unresolved: stats.unresolved,
  ambiguous: stats.ambiguous,
  decompose_queued: stats.decompose,
};

if (report.owner_alias_candidates) {
  report.owner_alias_candidates = [...report.owner_alias_candidates].slice(0, 20);
  log(`owner-alias candidates (add to identity.json emails if his): ${report.owner_alias_candidates.length}`);
}

if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const latestPath = resolve(REPORT_DIR, 'relation-mining-latest.json');
const datedPath = resolve(REPORT_DIR, `relation-mining-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(latestPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
writeFileSync(datedPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
log(`report → ${latestPath}`);
log(`done: written=${stats.written} queued=${stats.queued} auto_resolved=${stats.auto_resolved} conflicts=${stats.conflicts} unresolved=${stats.unresolved} ambiguous=${stats.ambiguous}`);
process.exit(0);
