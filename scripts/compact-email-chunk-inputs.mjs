#!/usr/bin/env node
/**
 * Compact overlong historical email chunks to the current launch-safe embedding
 * input shape. New email chunks are capped at creation time in lib/chunk-worker.js;
 * this script is the bounded self-heal path for older installs.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { computeInsertValueRank, default as db } from '../lib/db.js';
import { buildEmailChunkContent } from '../lib/chunk-worker.js';
import { classifyChunk } from '../lib/junk-classifier.js';
import { withLaunchDbWriterGuard } from '../lib/db-writer-policy.js';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const DRY_RUN = args.has('--dry-run') || !APPLY;
const BATCH = positiveInt(argValue('--batch') || process.env.ROBOTDOJO_EMAIL_CHUNK_COMPACT_BATCH, 500);
const MIN_CHARS = positiveInt(
  argValue('--min-chars') || process.env.ROBOTDOJO_EMAIL_CHUNK_COMPACT_MIN_CHARS,
  2000,
);
const MAX_SECONDS = positiveInt(argValue('--max-seconds') || process.env.ROBOTDOJO_EMAIL_CHUNK_COMPACT_MAX_SECONDS, 0);
const startedAt = Date.now();

function positiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function argValue(name) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function expired() {
  return MAX_SECONDS > 0 && (Date.now() - startedAt) >= MAX_SECONDS * 1000;
}

function rawEmailId(sourceId) {
  const text = String(sourceId || '');
  return text.startsWith('email:') ? text.slice('email:'.length) : text;
}

const fetchCandidates = db.prepare(`
  SELECT id, topic, source_id, content, content_rank, event_time
    FROM chunks
   WHERE source_type = 'email'
     AND skip_embed = 0
     AND LENGTH(content) > ?
   ORDER BY id
   LIMIT ?
`);

const fetchEmail = db.prepare(`
  SELECT id, subject, sender, sender_email, body_text, received_at
    FROM emails
   WHERE id = ?
`);

const updateChunk = db.prepare(`
  UPDATE chunks
     SET content = ?,
         embedded = 0,
         content_hash = NULL,
         embedding_model_id = NULL,
         embedding_dim = NULL,
         embedding_signature = NULL,
         embedded_at = NULL,
         value_rank = ?
   WHERE id = ?
`);

export function compactEmailChunkInputs({ dryRun = true, batch = BATCH, minChars = MIN_CHARS } = {}) {
  const stats = {
    dry_run: dryRun,
    min_chars: minChars,
    batch,
    scanned: 0,
    matched: 0,
    changed: 0,
    already_compact: 0,
    missing_email: 0,
    pending_after: 0,
    partial: false,
  };

  while (!expired()) {
    const candidates = fetchCandidates.all(minChars, batch);
    if (!candidates.length) break;
    stats.scanned += candidates.length;
    const updates = [];

    for (const chunk of candidates) {
      const email = fetchEmail.get(rawEmailId(chunk.source_id));
      if (!email) {
        stats.missing_email++;
        continue;
      }
      stats.matched++;
      const verdict = classifyChunk({
        source_type: 'email',
        body: email.body_text || '',
        sender_email: email.sender_email,
        subject: email.subject,
      });
      const nextContent = buildEmailChunkContent({
        subject: email.subject,
        sender: email.sender,
        sender_email: email.sender_email,
        body: email.body_text || '',
        strippedBody: verdict.strippedBody,
      });
      if (nextContent === chunk.content || nextContent.length > minChars) {
        stats.already_compact++;
        continue;
      }
      const contentRank = Number.isFinite(Number(chunk.content_rank))
        ? Number(chunk.content_rank)
        : 3;
      const eventTime = email.received_at || chunk.event_time || null;
      updates.push({
        id: chunk.id,
        content: nextContent,
        value_rank: computeInsertValueRank(eventTime, nextContent, contentRank),
      });
    }

    if (!dryRun && updates.length) {
      db.transaction((rows) => {
        for (const row of rows) updateChunk.run(row.content, row.value_rank, row.id);
      })(updates);
    }
    stats.changed += updates.length;

    if (candidates.length < batch) break;
    if (updates.length === 0) break;
  }

  stats.pending_after = db.prepare(`
    SELECT COUNT(*) AS n
      FROM chunks
     WHERE source_type = 'email'
       AND skip_embed = 0
       AND LENGTH(content) > ?
  `).get(minChars).n;
  stats.partial = stats.pending_after > 0;
  return stats;
}

async function main() {
  const stats = compactEmailChunkInputs({ dryRun: DRY_RUN, batch: BATCH, minChars: MIN_CHARS });
  console.log(JSON.stringify(stats));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  withLaunchDbWriterGuard('compact-email-chunk-inputs', () => main())
    .catch((err) => {
      console.error(`[compact-email-chunk-inputs] ${err?.stack || err?.message || err}`);
      process.exitCode = 1;
    });
}
