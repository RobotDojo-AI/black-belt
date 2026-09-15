/**
 * backfill-email-chunks.js — Chunk agency-related emails for RAG search.
 *
 * Usage: node scripts/backfill-email-chunks.js <topic-slug>
 *   or set AGENCY_TOPIC_SLUG env var
 *
 * WHY this script: ingestion (ingest-agency-xlsx.js) creates company chunks
 * immediately searchable. But 351K emails aren't automatically RAG-indexed.
 * This script finds emails related to companies in a given topic and writes
 * chunks so the RAG search includes email evidence alongside company context.
 *
 * === Compute Tier Protocol ===
 * Tier 0 (this script): SQL LIKE filter → ~500–2000 relevant emails from 351K
 * No Tier 1/2: email chunks left embedded=0 — the chunk-embed daemon handles them.
 * WHY skip embedding here: the embed daemon is throttled and idle-aware.
 * The vec table (chunk_vec_${safeTopic}) is created by ingest-agency-xlsx.js
 * on first ingest, so the embed daemon will pick these up automatically.
 *
 * WHY dynamic agency list from DB: hardcoded agency names would drift from DB.
 * Read from company_topics so the filter stays current as new agencies are added.
 */

import db from '../lib/db.js';
import { CHUNK_SIZE } from '../lib/rag.js';

// -- Constants --
// TOPIC_SLUG: pass as CLI arg or set AGENCY_TOPIC_SLUG env var
const TOPIC_SLUG  = process.argv[2] || process.env.AGENCY_TOPIC_SLUG;
const EMAIL_LIMIT = 5000;   // Tier 0 cap — prevents runaway on large corpora
const MIN_BODY    = 100;    // skip extremely short bodies

if (!TOPIC_SLUG) {
  console.error('Usage: node scripts/backfill-email-chunks.js <topic-slug>');
  console.error('  or set AGENCY_TOPIC_SLUG env var');
  process.exit(1);
}

// ─── Build dynamic LIKE conditions from DB ───────────────────────────────────

/**
 * WHY dynamic agency list: load agency names from company_topics so the SQL
 * filter auto-updates when new agencies are ingested. Never hardcode names.
 */
function buildAgencyConditions() {
  const rows = db.prepare(`
    SELECT c.name FROM companies c
    JOIN company_topics ct ON ct.company_id = c.id
    WHERE ct.topic = ?
    ORDER BY c.name
  `).all(TOPIC_SLUG);

  // Build LIKE conditions for each agency name (top-level words only to avoid
  // false positives from very short names like "IC System")
  return rows
    .map((r) => r.name)
    .filter((n) => n && n.length >= 5) // skip very short names
    .map((n) => {
      const escaped = n.replace(/'/g, "''"); // SQL escape
      return `body_text LIKE '%${escaped}%'`;
    });
}

// ─── Chunking ────────────────────────────────────────────────────────────────

function chunkText(text, chunkSize = CHUNK_SIZE) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize));
    start += chunkSize;
  }
  return chunks;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.info('[backfill-email-chunks] starting');

  const agencyConditions = buildAgencyConditions();
  console.info(`[backfill-email-chunks] loaded ${agencyConditions.length} agency name conditions from DB`);

  if (agencyConditions.length === 0) {
    console.warn(`[backfill-email-chunks] no agencies in '${TOPIC_SLUG}' topic — run ingest-agency-xlsx.js first`);
    process.exit(0);
  }

  // Tier 0 SQL filter — agency company name LIKE conditions from DB
  const dynamicWhere = agencyConditions.join('\n    OR ');

  const emailRows = db.prepare(`
    SELECT id, subject, body_text, sender_email, received_at
    FROM emails
    WHERE body_text IS NOT NULL AND LENGTH(body_text) > ${MIN_BODY}
      AND (${dynamicWhere})
    ORDER BY received_at DESC
    LIMIT ${EMAIL_LIMIT}
  `).all();

  console.info(`[backfill-email-chunks] found ${emailRows.length} matching emails`);

  if (emailRows.length === 0) {
    console.info('[backfill-email-chunks] no emails matched — done');
    return;
  }

  // Insert email chunks — leave embedded=0 for the chunk-embed daemon
  // WHY INSERT OR REPLACE: idempotent — re-running this script is safe
  const upsertChunk = db.prepare(`
    INSERT OR REPLACE INTO chunks
      (topic, source_type, source_id, chunk_index, content, metadata, token_count, embedded)
    VALUES (?, 'email', ?, ?, ?, ?, ?, 0)
  `);

  let totalChunks = 0;
  let processedEmails = 0;

  const insertAll = db.transaction(() => {
    for (const email of emailRows) {
      const windows = chunkText(email.body_text);
      const metadata = JSON.stringify({
        subject: email.subject,
        sender_email: email.sender_email,
        received_at: email.received_at,
      });

      for (let i = 0; i < windows.length; i++) {
        const window = windows[i];
        const tokenCount = Math.ceil(window.length / 4);
        upsertChunk.run(TOPIC_SLUG, email.id, i, window, metadata, tokenCount);
        totalChunks++;
      }
      processedEmails++;
    }
  });

  insertAll();

  console.info(
    `[backfill-email-chunks] wrote ${totalChunks} chunks from ${processedEmails} emails`,
  );
  console.info('[backfill-email-chunks] done (chunks left embedded=0 — chunk-embed daemon will handle)');
}

run().catch((err) => {
  console.error('[backfill-email-chunks] fatal:', err);
  process.exit(1);
});
