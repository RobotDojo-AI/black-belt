#!/usr/bin/env node
/**
 * scripts/purge-junk-chunks.js
 *
 * One-shot backfill purge: removes already-embedded chunks that the new junk
 * classifier would now reject. Targets the 148,161 newsletter chunks already
 * embedded (Tantei finding — is_newsletter was set retroactively after
 * embedding) plus all chunks below the 50-token floor.
 *
 * INTELLIGENCE TIER: extraction (deterministic; no LLM calls).
 *
 * Usage:
 *   node scripts/purge-junk-chunks.js              — live mode
 *   node scripts/purge-junk-chunks.js --dry-run    — count only, no mutations
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LOAD-BEARING INVARIANTS — DO NOT VIOLATE
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. NEVER DELETE chunks ROWS.
 *    fetchUnchunkedEmails (lib/chunk-worker.js:65) uses NOT EXISTS to detect
 *    work. Deleting a chunks row makes the email reappear "unchunked" and
 *    the worker re-creates it on the next 120s cycle — undoing the purge.
 *    Correct mutation: UPDATE chunks SET skip_embed=1, embedded=0.
 *
 * 2. NEVER PURGE source_type='imessage'.
 *    scripts/extract-imessage/01-extract.js:278 reads the chunks table for
 *    participant metadata. Removing iMessage rows OR flipping their
 *    skip_embed/embedded bits breaks that downstream pipeline. Both the
 *    candidate query and the UPDATE exclude source_type='imessage'.
 *
 * 3. ALWAYS WAL CHECKPOINT BEFORE TRANSACTIONS.
 *    Killed prior runs may leave stale reader marks in the WAL SHM file,
 *    causing SQLITE_BUSY_SNAPSHOT to hang. wal_checkpoint(RESTART) clears
 *    them.
 *
 * 4. ATOMIC PER-TOPIC TRANSACTION.
 *    Each topic's UPDATE+DELETE runs inside one db.transaction(). On
 *    crash, partial work is rolled back. Idempotent: re-running finds the
 *    same candidate set minus whatever was already marked. The 9 topics
 *    purged in the 2026-05-14 first-run stay committed across restarts.
 *
 * 5. DRY-RUN MUTATES NOTHING.
 *    --dry-run computes target counts via SQL aggregates and exits 0
 *    without touching the DB. VC8 verifies skip_embed=1 count is unchanged
 *    before/after.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY SQL-DRIVEN (not row-by-row classify)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The forward gate (lib/chunk-worker.js + lib/junk-classifier.js) runs the
 * full classifier on every NEW chunk. The backfill targets two deterministic
 * sets that can be expressed in pure SQL without running the classifier:
 *
 *   (a) Newsletter: JOIN to emails.is_newsletter=1. Same fast-path the
 *       classifier uses (line 103 of junk-classifier.js).
 *
 *   (b) Short-body: chunks.token_count < 50 on source_type IN ('email','drive').
 *       SQL-side proxy for the classifier's post-strip token count. The
 *       classifier could mark MORE chunks as short (after stripping), but
 *       it never marks fewer. Restricted to email + drive because the
 *       forward gate's body-substance check applies only there — calendar,
 *       conversation, transcripts can be legitimately short signal.
 *
 * Transactional headers (Auto-Submitted, Precedence, Feedback-ID, List-Id)
 * apply to NEWLY-synced emails only — gmail-sync was widened to set
 * is_newsletter=1 on these. Historical emails don't have those headers in
 * the DB, so the backfill catches them via is_newsletter only.
 *
 * Row-by-row classification on 870K candidates would take ~70 minutes and
 * was attempted in the prior version — its candidate query had no
 * ORDER BY/OFFSET, and chunks classified shouldEmbed=true did not leave
 * the candidate set, producing an infinite loop on the same 10K rows.
 * SQL-driven mode runs in seconds-to-minutes with no infinite-loop hazard.
 */

import db from '../lib/db.js';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

export const INTELLIGENCE_TIER = 'extraction';

const DRY_RUN = process.argv.includes('--dry-run');
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const METRICS_PATH = resolve(REPO_ROOT, 'databases', 'junk-purge-metrics.json');
const PLIST_PATH = resolve(homedir(), 'Library', 'LaunchAgents', 'com.robotdojo.chunk-worker.plist');

// Token floor mirrors lib/junk-classifier.js MIN_TOKENS_POST_STRIP. The
// classifier's post-strip count is more aggressive than this SQL proxy
// (it strips quoted-reply + signature + footer before counting); this
// proxy under-counts but never over-counts.
const TOKEN_FLOOR = 50;

function log(...args) { console.log('[purge]', ...args); }

// ── LaunchAgent control ───────────────────────────────────────────────────

function stopChunkWorker() {
  if (DRY_RUN) { log('dry-run — skipping launchctl unload'); return; }
  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'pipe' });
    log('chunk-worker LaunchAgent unloaded');
  } catch (err) {
    log(`launchctl unload warning: ${err.message?.split('\n')[0]}`);
  }
}

function startChunkWorker() {
  if (DRY_RUN) return;
  try {
    execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'pipe' });
    log('chunk-worker LaunchAgent reloaded');
  } catch (err) {
    log(`launchctl load warning: ${err.message?.split('\n')[0]}`);
  }
}

// ── Vec table discovery ───────────────────────────────────────────────────

function listMainVecTables() {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table'
      AND name LIKE 'chunk_vec_%'
      AND name NOT LIKE '%_info'
      AND name NOT LIKE '%_chunks'
      AND name NOT LIKE '%_rowids'
      AND name NOT LIKE '%_vector_chunks00'
  `).all().map(r => r.name);
}

function countVecRows() {
  let total = 0;
  for (const t of listMainVecTables()) {
    try {
      const r = db.prepare(`SELECT count(*) as n FROM "${t}"`).get();
      total += r.n;
    } catch {}
  }
  return total;
}

// ── Main purge ────────────────────────────────────────────────────────────

function purgeOnce() {
  log(`mode: ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`);

  const baselineVecTotal = countVecRows();
  const baselineImessageEmbedded = db.prepare(
    `SELECT count(*) as n FROM chunks WHERE source_type='imessage' AND embedded=1`
  ).get().n;
  log(`baseline vec rows: ${baselineVecTotal.toLocaleString()}`);
  log(`baseline iMessage embedded: ${baselineImessageEmbedded.toLocaleString()}`);

  stopChunkWorker();

  // Newsletter target count (live).
  const newsletterCount = db.prepare(`
    SELECT count(*) as n
    FROM chunks c
    JOIN emails e ON (c.source_id = 'email:' || e.id OR c.source_id = e.id)
    WHERE c.source_type='email'
      AND c.embedded=1
      AND c.skip_embed=0
      AND e.is_newsletter=1
  `).get().n;

  // Short-body target count (live). Email + drive only — see WHY block at top.
  const shortBodyCount = db.prepare(`
    SELECT count(*) as n
    FROM chunks
    WHERE embedded=1
      AND skip_embed=0
      AND source_type IN ('email','drive')
      AND token_count < ?
  `).get(TOKEN_FLOOR).n;

  log(`targets: ${newsletterCount.toLocaleString()} newsletter + ${shortBodyCount.toLocaleString()} short-body`);

  let newsletterPurged = 0;
  let shortBodyPurged = 0;

  if (!DRY_RUN) {
    // ── Stage candidate ids in a temp table ──────────────────────────────
    db.pragma('wal_checkpoint(RESTART)');

    db.exec(`
      DROP TABLE IF EXISTS _purge_ids;
      CREATE TEMP TABLE _purge_ids (
        id INTEGER PRIMARY KEY,
        topic TEXT NOT NULL,
        junk_class TEXT NOT NULL
      );
    `);

    const insertNewsletter = db.prepare(`
      INSERT OR IGNORE INTO _purge_ids (id, topic, junk_class)
      SELECT c.id, c.topic, 'newsletter'
      FROM chunks c
      JOIN emails e ON (c.source_id = 'email:' || e.id OR c.source_id = e.id)
      WHERE c.source_type='email'
        AND c.embedded=1
        AND c.skip_embed=0
        AND e.is_newsletter=1
    `);
    const insertShortBody = db.prepare(`
      INSERT OR IGNORE INTO _purge_ids (id, topic, junk_class)
      SELECT id, topic, 'short-body'
      FROM chunks
      WHERE embedded=1
        AND skip_embed=0
        AND source_type IN ('email','drive')
        AND token_count < ?
    `);

    db.transaction(() => {
      insertNewsletter.run();
      insertShortBody.run(TOKEN_FLOOR);
    })();

    newsletterPurged = db.prepare(
      `SELECT count(*) as n FROM _purge_ids WHERE junk_class='newsletter'`
    ).get().n;
    shortBodyPurged = db.prepare(
      `SELECT count(*) as n FROM _purge_ids WHERE junk_class='short-body'`
    ).get().n;
    const totalUnique = db.prepare(`SELECT count(*) as n FROM _purge_ids`).get().n;
    log(`staged ${totalUnique.toLocaleString()} unique ids (${newsletterPurged.toLocaleString()} newsletter + ${shortBodyPurged.toLocaleString()} short-body, overlap deduped)`);

    // ── Per-topic vec DELETE + chunks UPDATE ──────────────────────────────
    //
    // Each topic = one transaction. WAL checkpoint between to keep WAL
    // bounded. CAST(id AS TEXT): vec0 stores chunk_id as TEXT
    // (lib/rag/embed.js:41) while chunks.id is INTEGER.
    const topics = db.prepare(
      `SELECT DISTINCT topic FROM _purge_ids`
    ).all().map(r => r.topic);
    log(`topics affected: ${topics.length}`);

    const vecTables = new Set(listMainVecTables());
    let totalUpdated = 0;
    let totalVecDeleted = 0;

    for (const topic of topics) {
      db.pragma('wal_checkpoint(RESTART)');
      const safe = topic.replace(/[^a-z0-9_]/g, '_');
      const vecTable = `chunk_vec_${safe}`;
      const hasVec = vecTables.has(vecTable);

      let topicVecDeleted = 0;
      let topicUpdated = 0;

      db.transaction(() => {
        if (hasVec) {
          const r = db.prepare(`
            DELETE FROM "${vecTable}"
            WHERE chunk_id IN (
              SELECT CAST(id AS TEXT) FROM _purge_ids WHERE topic = ?
            )
          `).run(topic);
          topicVecDeleted = r.changes;
        }
        const u = db.prepare(`
          UPDATE chunks
          SET skip_embed=1, embedded=0
          WHERE id IN (SELECT id FROM _purge_ids WHERE topic = ?)
        `).run(topic);
        topicUpdated = u.changes;
      })();

      totalVecDeleted += topicVecDeleted;
      totalUpdated += topicUpdated;
      log(`  ${topic}: updated ${topicUpdated.toLocaleString()} chunks, deleted ${topicVecDeleted.toLocaleString()} vec rows`);
    }

    log(`total: updated ${totalUpdated.toLocaleString()} chunks, deleted ${totalVecDeleted.toLocaleString()} vec rows`);

    // ── Try vec optimize (vlasky fork only; no-op on official asg017) ─────
    try {
      db.prepare(`INSERT INTO chunk_vec_personal(chunk_vec_personal) VALUES ('optimize')`).run();
      log('sqlite-vec optimize succeeded');
    } catch {
      log('sqlite-vec optimize unavailable in installed build — skipped');
    }

    db.exec('DROP TABLE IF EXISTS _purge_ids');
  }

  const postVecTotal = DRY_RUN ? baselineVecTotal : countVecRows();
  const postImessageEmbedded = db.prepare(
    `SELECT count(*) as n FROM chunks WHERE source_type='imessage' AND embedded=1`
  ).get().n;
  const ratioDropped = baselineVecTotal > 0 ? 1 - (postVecTotal / baselineVecTotal) : 0;

  if (DRY_RUN) {
    newsletterPurged = newsletterCount;
    shortBodyPurged = shortBodyCount;
  }

  log(`vec rows: ${baselineVecTotal.toLocaleString()} → ${postVecTotal.toLocaleString()} (${(ratioDropped * 100).toFixed(2)}% drop)`);
  log(`iMessage embedded chunks: ${baselineImessageEmbedded.toLocaleString()} → ${postImessageEmbedded.toLocaleString()}`);

  startChunkWorker();

  // ── Metrics file ─────────────────────────────────────────────────────────
  const metrics = {
    baseline_vec_total: baselineVecTotal,
    post_vec_total: postVecTotal,
    newsletter_purged: newsletterPurged,
    short_body_purged: shortBodyPurged,
    transactional_purged: 0,
    imessage_baseline_embedded: baselineImessageEmbedded,
    imessage_post_embedded: postImessageEmbedded,
    ratio_dropped: ratioDropped,
    dry_run: DRY_RUN,
    ran_at: DRY_RUN ? null : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  writeFileSync(METRICS_PATH, JSON.stringify(metrics, null, 2));
  log(`metrics written: ${METRICS_PATH}`);

  if (DRY_RUN) log('dry-run complete');
  else log('purge complete');
}

purgeOnce();
