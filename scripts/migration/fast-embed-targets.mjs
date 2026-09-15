#!/usr/bin/env node
/**
 * scripts/migration/fast-embed-targets.mjs — st_1cfe9061
 *
 * One-time targeted fast-embed: drains all non-personal pending topics into
 * embeddings.db at night-mode throughput (2 lanes, nightShortBatchSize=16,
 * unlimited batches per topic).
 *
 * Steps:
 *  1. Fix orphans on any already-migrated topic: chunks with embedded=1 in
 *     robotdojo.db but no corresponding vec in embeddings.db are reset to
 *     embedded=0 (restore-same-content trigger dropped/recreated around the
 *     reset to prevent the guard loop), then re-embedded.
 *  2. Embed all non-personal topics with any pending > 0.
 *     Topics are processed small-first (ascending pending count) so short topics
 *     drain first and health+career run last.
 *
 * "Personal" is the only excluded topic — it has hundreds of thousands of
 * pending chunks and is handled by the follow-on story.
 *
 * Run with the chunk-embed-daemon STOPPED. This script is the sole writer to
 * embeddingsDb during execution.
 *
 * Usage:
 *   ROBOTDOJO_MMAP_SIZE=0 node scripts/migration/fast-embed-targets.mjs
 *
 * Optional: ROBOTDOJO_EMBED_LANES=N (default 2) to control lane count.
 *           ROBOTDOJO_NIGHT_BATCH=N (default 16) to control short-tier batch.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(homedir(), 'robotdojo');
const { default: db, openEmbeddingsDb } = await import(resolve(ROOT, 'lib/db.js'));
const { embedChunks } = await import(resolve(ROOT, 'lib/rag/embed.js'));
const { setEmbedProfile } = await import(resolve(ROOT, 'lib/rag/local-embed.js'));
const { LanePool } = await import(resolve(ROOT, 'lib/rag/lane-pool.js'));

// Wider busy_timeout: this script is sole writer during migration.
db.pragma('busy_timeout = 30000');

const embeddingsDb = openEmbeddingsDb();
if (!embeddingsDb) {
  console.error('[fast-embed] embeddings.db not available — aborting');
  process.exit(1);
}
embeddingsDb.pragma('busy_timeout = 30000');

// Night mode: widens the short-tier batch to nightShortBatchSize.
setEmbedProfile('night');
const NIGHT_SHORT_BATCH = Number(process.env.ROBOTDOJO_NIGHT_BATCH) || 16;
console.log(`[fast-embed] profile=night, nightShortBatchSize=${NIGHT_SHORT_BATCH}`);

// 2-lane pool mirrors the daemon's night-mode config.
const LANE_COUNT = Math.min(3, Number(process.env.ROBOTDOJO_EMBED_LANES) || 2);
const LANE_INTRA_THREADS = 2;
const lanePool = new LanePool({
  laneCount: LANE_COUNT,
  sliceTimeoutMs: 600_000, // 10 min per slice — no chat turn to protect
  env: {
    ROBOTDOJO_LANE_INTRA_THREADS: String(LANE_INTRA_THREADS),
    ROBOTDOJO_EMBED_ORT_INTRA_THREADS: String(LANE_INTRA_THREADS),
    ROBOTDOJO_MMAP_SIZE: '0',
  },
});
console.log(`[fast-embed] lane pool ready (${LANE_COUNT} lanes × ${LANE_INTRA_THREADS} intra-op threads)`);

// -- Helpers --

function getPending(topic) {
  return db.prepare(
    'SELECT COUNT(*) as n FROM chunks WHERE topic=? AND embedded=0 AND skip_embed=0'
  ).get(topic).n;
}

function isAlreadyMigrated(topic) {
  return db.prepare('SELECT 1 FROM topic_vec_migrations WHERE topic=?').get(topic) != null;
}

function markMigrated(topic) {
  try {
    db.prepare('INSERT OR IGNORE INTO topic_vec_migrations (topic) VALUES (?)').run(topic);
    console.log(`[fast-embed] [${topic}] marked migrated`);
  } catch (err) {
    console.log(`[fast-embed] [${topic}] warn markMigrated: ${err?.message}`);
  }
}

const RESTORE_TRIGGER_SQL = `
  CREATE TRIGGER chunks_embedding_restore_same_content_au
  AFTER UPDATE OF embedded ON chunks
  WHEN OLD.embedded = 1
   AND NEW.embedded = 0
   AND OLD.content IS NEW.content
   AND OLD.topic IS NEW.topic
   AND OLD.skip_embed IS NEW.skip_embed
  BEGIN
    UPDATE chunks
       SET embedded = OLD.embedded,
           content_hash = OLD.content_hash,
           embedding_model_id = OLD.embedding_model_id,
           embedding_dim = OLD.embedding_dim,
           embedding_signature = OLD.embedding_signature,
           embedded_at = OLD.embedded_at
     WHERE id = NEW.id;
  END
`;

/**
 * Fix orphans for a topic: chunks with embedded=1 in robotdojo.db but no
 * corresponding vec row in embeddingsDb's chunk_vec_{topic} table.
 * Returns the count of orphans reset.
 */
function fixOrphans(topic) {
  const tableName = `chunk_vec_${topic.replace(/[^a-z0-9_]/g, '_')}`;

  let vecChunkIds;
  try {
    vecChunkIds = new Set(
      embeddingsDb.prepare(`SELECT chunk_id FROM ${tableName}`).all().map((r) => r.chunk_id)
    );
  } catch {
    console.log(`[fast-embed] [${topic}] no vec table in embeddingsDb — skipping orphan fix`);
    return 0;
  }

  const orphans = db
    .prepare('SELECT id FROM chunks WHERE topic=? AND embedded=1')
    .all(topic)
    .map((r) => r.id)
    .filter((id) => !vecChunkIds.has(String(id)));  // chunk_ids in embeddingsDb are TEXT

  if (orphans.length === 0) return 0;

  console.log(`[fast-embed] [${topic}] ${orphans.length} orphan(s) — resetting embedded=1→0`);

  // Drop the restore-same-content trigger so our UPDATE isn't instantly undone.
  db.exec('DROP TRIGGER IF EXISTS chunks_embedding_restore_same_content_au');

  const resetStmt = db.prepare(
    'UPDATE chunks SET embedded=0, embedding_signature=NULL, embedding_model_id=NULL, embedding_dim=NULL, embedded_at=NULL WHERE id=?'
  );
  db.transaction(() => { for (const id of orphans) resetStmt.run(id); })();

  // Recreate the trigger so normal protection resumes.
  db.exec(RESTORE_TRIGGER_SQL);
  console.log(`[fast-embed] [${topic}] reset ${orphans.length} orphans, trigger restored`);
  return orphans.length;
}

// -- Build target list from DB --
// 1. Fix orphans on already-migrated topics first.
const migratedTopics = db.prepare('SELECT topic FROM topic_vec_migrations').all().map((r) => r.topic);
let totalOrphansFixed = 0;
for (const topic of migratedTopics) {
  totalOrphansFixed += fixOrphans(topic);
}
if (totalOrphansFixed > 0) {
  console.log(`[fast-embed] orphan fix complete: ${totalOrphansFixed} chunk(s) reset across migrated topics`);
}

// 2. Collect all non-personal topics with pending > 0, sorted small-first.
const EXCLUDED_TOPICS = new Set(['personal']);
const pendingRows = db.prepare(`
  SELECT topic, COUNT(*) as n
    FROM chunks
   WHERE embedded=0 AND skip_embed=0
   GROUP BY topic
   ORDER BY n ASC
`).all();

const targets = pendingRows
  .filter((r) => !EXCLUDED_TOPICS.has(r.topic) && r.n > 0)
  .map((r) => ({ topic: r.topic, pending: r.n }));

if (targets.length === 0) {
  console.log('[fast-embed] no non-personal pending topics — done');
  try { lanePool.destroy(); } catch { /* ignore */ }
  process.exit(0);
}

console.log(`[fast-embed] ${targets.length} topic(s) to embed:`);
for (const { topic, pending } of targets) {
  console.log(`  ${topic}: ${pending} pending`);
}

// -- Main embed loop --
const runStart = Date.now();
let totalEmbedded = 0;

for (const { topic } of targets) {
  const pendingBefore = getPending(topic);
  if (pendingBefore === 0) {
    console.log(`[fast-embed] [${topic}] 0 pending — skip`);
    if (!isAlreadyMigrated(topic)) markMigrated(topic);
    continue;
  }

  const topicStart = Date.now();
  console.log(`[fast-embed] [${topic}] starting — ${pendingBefore} pending`);

  let result;
  const MAX_TOPIC_RETRIES = 20;
  let succeeded = false;
  for (let attempt = 0; attempt < MAX_TOPIC_RETRIES; attempt++) {
    try {
      result = await embedChunks(topic, null, {
        embeddingsDb,
        lanePool,
        maxBatches: 0,                          // unlimited — drain fully
        nightShortBatchSize: NIGHT_SHORT_BATCH,
      });
      succeeded = true;
      break;
    } catch (err) {
      const msg = err?.message || String(err);
      if ((msg.includes('locked') || msg.includes('busy')) && attempt < MAX_TOPIC_RETRIES - 1) {
        // Exponential backoff capped at 90s; maintenance jobs can hold the lock for 60-120s
        const delayMs = Math.min(3000 * Math.pow(2, attempt), 90000);
        console.log(`[fast-embed] [${topic}] DB lock (attempt ${attempt + 1}/${MAX_TOPIC_RETRIES}) — retry in ${Math.round(delayMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        console.error(`[fast-embed] [${topic}] ERROR: ${msg}`);
        break;
      }
    }
  }
  if (!succeeded && !result) continue;

  const elapsedS = ((Date.now() - topicStart) / 1000).toFixed(1);
  const ratePerHr = result.embedded > 0
    ? Math.round(result.embedded / ((Date.now() - topicStart) / 3_600_000))
    : 0;
  console.log(
    `[fast-embed] [${topic}] done: ${result.embedded} embedded, ${result.reused} reused, ${result.skipped} skipped — ${elapsedS}s (~${ratePerHr}/hr)`
  );
  totalEmbedded += result.embedded || 0;

  const pendingAfter = getPending(topic);
  if (pendingAfter === 0) {
    if (!isAlreadyMigrated(topic)) markMigrated(topic);
  } else {
    console.log(`[fast-embed] [${topic}] WARN: ${pendingAfter} chunk(s) still pending`);
  }
}

const totalMin = ((Date.now() - runStart) / 60_000).toFixed(1);
console.log(`\n[fast-embed] complete: ${totalEmbedded} total embedded in ${totalMin} min`);

try { lanePool.destroy(); } catch { /* ignore */ }
process.exit(0);
