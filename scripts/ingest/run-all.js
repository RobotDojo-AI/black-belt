/**
 * scripts/ingest/run-all.js
 *
 * Orchestrator for the RAG embedding + entity-linking pipeline.
 *
 * Steps:
 *   1. embedChunks for all topics that have unembedded rows
 *   2. link-chunk-entities (entity → chunk associations)
 *
 * Usage:
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/ingest/run-all.js           # normal run
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/ingest/run-all.js --dry-run # preview only
 *
 * Design: one failing topic does not abort the rest. Errors are logged and
 * the script exits 0 if all steps that could run did run (partial success
 * is better than aborting in a 900K-chunk corpus).
 */

import db from '../../lib/db.js';
import { EMBED_DIM } from '../../lib/rag.js';
import { embedChunks } from '../../lib/rag/embed.js';
import { linkChunkEntities } from './link-chunk-entities.js';
import { spawn } from 'node:child_process';

const isDryRun = process.argv.includes('--dry-run');

// Lift SQLite busy_timeout for the duration of this run. The chat-path
// default in lib/db.js is 5s; the embed transactions hold the writer
// channel for ~1–2s per 100-chunk batch and may need to wait out
// concurrent writes from a live server. 120s gives plenty of slack.
db.pragma('busy_timeout = 120000');

const safeTableName = (t) => 'chunk_vec_' + String(t).replace(/[^a-z0-9_]/g, '_');

/**
 * Step 0 — Self-heal the embed-flag-vs-storage invariant.
 *
 * The canonical embed pipeline (lib/rag/embed.js) is atomic, but the
 * `chunks` table is mutated from multiple non-canonical paths (legacy
 * migrations, ingest scripts that touch the flag directly, topic
 * renames). Without a self-heal step, drift accumulates: chunks marked
 * embedded=1 with no vector row, or marked both embedded=1 AND
 * skip_embed=1.
 *
 * This step runs every invocation and is idempotent — on a clean DB
 * it makes zero writes. On a drifted DB it:
 *   - Creates any missing chunk_vec_<slug> virtual table
 *   - Resets embedded=1 → 0 where no vector exists in the topic's
 *     chunk_vec_<slug> table → those rows flow into Step 1 below
 *   - Resets embedded=1 → 0 where skip_embed=1 (logical contradiction)
 *
 * A new-user install on a freshly-chunked corpus has embedded=0
 * everywhere, so Step 0 is a no-op and Step 1 does all the work.
 */
function reconcileEmbedFlags() {
  const topics = db.prepare(
    "SELECT DISTINCT topic FROM chunks WHERE topic IS NOT NULL"
  ).all().map(r => r.topic);

  // Ensure every chunks.topic value has a corresponding user_topics row.
  // Hidden is a nav preference (visible=0), NOT "this topic doesn't exist."
  // Chunks need a real topic record so chat-context's parent_slug traversal
  // + classification queries can resolve them. Insert with visible=0 so they
  // don't crowd the left nav unless the operator promotes them.
  const ensureTopic = db.prepare(
    `INSERT OR IGNORE INTO user_topics (slug, label, visible, created_at, updated_at)
     VALUES (?, ?, 0, datetime('now'), datetime('now'))`
  );
  let topicsSeeded = 0;
  for (const t of topics) {
    // Friendly label from slug: 'foo-bar' → 'Foo Bar', 'nl-foo' → 'NL: Foo'.
    const label = t.startsWith('nl-')
      ? 'NL: ' + t.slice(3).replace(/(^|-)([a-z])/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase())
      : t.replace(/(^|-)([a-z])/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase());
    const r = ensureTopic.run(t, label);
    if (r.changes) topicsSeeded++;
  }

  // Ensure every topic has a chunk_vec_<slug> table.
  let created = 0;
  for (const t of topics) {
    const tn = safeTableName(t);
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
    ).get(tn);
    if (!exists) {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${tn} USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${EMBED_DIM}])`
      );
      created++;
    }
  }

  // Reset flag drift.
  let resetOrphans = 0;
  let resetContradictions = 0;
  const tx = db.transaction(() => {
    for (const t of topics) {
      const tn = safeTableName(t);
      try {
        const r = db.prepare(
          `UPDATE chunks SET embedded=0 WHERE embedded=1 AND skip_embed=0 AND topic=? AND id NOT IN (SELECT CAST(chunk_id AS INTEGER) FROM ${tn})`
        ).run(t);
        resetOrphans += r.changes;
      } catch (e) {
        console.warn(`[run-all][reconcile] topic=${t} orphan reset failed:`, e.message);
      }
    }
    const r2 = db.prepare(
      'UPDATE chunks SET embedded=0 WHERE embedded=1 AND skip_embed=1'
    ).run();
    resetContradictions = r2.changes;
  });
  tx();

  if (created || resetOrphans || resetContradictions) {
    console.log(`[run-all][reconcile] created_tables=${created} orphan_resets=${resetOrphans} skip_embed_contradictions=${resetContradictions}`);
  } else {
    console.log('[run-all][reconcile] clean — no drift to repair');
  }
}

async function main() {
  if (isDryRun) {
    console.log('[run-all] --dry-run mode: no writes will occur');
  }

  // --- Step 0: self-heal embed-flag drift ---
  if (!isDryRun) reconcileEmbedFlags();

  // --- Step 1: find topics with unembedded chunks ---
  const unembeddedTopics = db.prepare(`
    SELECT DISTINCT topic, COUNT(*) AS c
    FROM chunks
    WHERE embedded = 0 AND skip_embed = 0
    GROUP BY topic
    ORDER BY c DESC
  `).all();

  if (!unembeddedTopics.length) {
    console.log('[run-all] no unembedded chunks found — embedding step skipped');
  } else {
    console.log(`[run-all] topics with unembedded chunks: ${unembeddedTopics.length}`);
    for (const { topic, c } of unembeddedTopics) {
      console.log(`  - ${topic}: ${c} chunks`);
    }
  }

  if (isDryRun) {
    // Show what would happen for entity linking too
    const ceCount = db.prepare('SELECT COUNT(*) AS c FROM chunk_entities').get().c;
    const chunksTotal = db.prepare('SELECT COUNT(*) AS c FROM chunks WHERE source_type IN (\'email\',\'calendar\',\'imessage\')').get().c;
    console.log(`[run-all] --dry-run: would embed ${unembeddedTopics.reduce((s, r) => s + r.c, 0)} chunks across ${unembeddedTopics.length} topics`);
    console.log(`[run-all] --dry-run: chunk_entities currently has ${ceCount} rows; source chunks = ${chunksTotal}`);
    console.log('[run-all] --dry-run: exiting without writes');
    process.exit(0);
  }

  // --- Step 1: embed unembedded chunks per topic ---
  //
  // Parallel pool: CONCURRENCY topics processed at once. Local embeddings run
  // on CPU, so concurrency is an operator tuning knob rather than a spend knob.
  //
  // Topic-level retry-with-backoff survives transient SQLite locks. A single
  // bad topic does not abort the rest — partial progress > stall.
  const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY || 4);
  const RETRY_ATTEMPTS = 3;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function embedWithRetry(topic) {
    let lastErr = null;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try { return await embedChunks(topic); }
      catch (err) {
        lastErr = err;
        const isTransient = /database is locked|429|rate limit/i.test(err.message || '');
        if (!isTransient || attempt === RETRY_ATTEMPTS) throw err;
        const wait = Math.min(60000, 5000 * 2 ** (attempt - 1));
        console.warn(`[run-all] topic="${topic}" attempt ${attempt} ${err.message} — backoff ${wait}ms`);
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  const queue = [...unembeddedTopics];
  let embedTotal = 0;
  let embedErrors = 0;
  console.log(`[run-all] embedding ${unembeddedTopics.length} topics with concurrency=${CONCURRENCY}`);
  const workers = Array.from({ length: CONCURRENCY }, async (_, w) => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      const { topic, c: targetCount } = job;
      const tStart = Date.now();
      try {
        const { embedded, skipped } = await embedWithRetry(topic);
        const dt = ((Date.now() - tStart) / 1000).toFixed(1);
        embedTotal += embedded;
        if (skipped) {
          console.warn(`[run-all][w${w}] topic="${topic}" embedded=${embedded} skipped=${skipped} in ${dt}s`);
          embedErrors++;
        } else {
          console.log(`[run-all][w${w}] topic="${topic}" embedded=${embedded} in ${dt}s`);
        }
      } catch (err) {
        console.error(`[run-all][w${w}] topic="${topic}" failed:`, err.message);
        embedErrors++;
      }
    }
  });
  await Promise.all(workers);

  console.log(`[run-all] embedding complete: ${embedTotal} chunks embedded, ${embedErrors} topic errors`);

  // --- Step 2: link chunk entities ---
  try {
    console.log('[run-all] linking chunk entities...');
    linkChunkEntities();
  } catch (err) {
    console.error('[run-all] link-chunk-entities failed:', err.message);
  }

  // Fire entity context regen for all entities flagged needs_regen=1 by link-chunk-entities
  const regenProc = spawn(process.execPath, [new URL('../../scripts/regen-entities.js', import.meta.url).pathname], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env }
  });
  regenProc.unref();
  console.log('[run-all] regen-entities fired (background)');

  console.log('[run-all] done');
}

main().catch(err => {
  console.error('[run-all] fatal error:', err.message);
  process.exit(1);
});
