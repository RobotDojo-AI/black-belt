#!/usr/bin/env node
/**
 * scripts/qa/check-vec-orphans.js — st_1cfe9061
 *
 * Cross-DB consistency check: migrated split-vector tables must match the live
 * embedded chunk set exactly. It finds both directions:
 *   - chunks where embedded=1 in robotdojo.db but no vec0 row exists
 *   - stale vec0 rows in embeddings.db for chunks no longer embedded/live
 *
 * Exits 0 if no orphans. Exits 1 with a count if orphans found.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import db from '../../lib/db.js';
import {
  migratedVectorTopics,
  openSplitVectorStore,
  pruneStaleVectorRows,
  splitVectorParity,
} from '../../lib/split-vector-store.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const resultFile = args.resultFile || process.env.ROBOTDOJO_VEC_ORPHAN_CHECK_RESULT_FILE || null;

function atomicWriteJson(path, payload) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
}

function writeResult(payload) {
  atomicWriteJson(resultFile, {
    checked_at: new Date().toISOString(),
    ...payload,
  });
}

// Orphan check is scoped to topics the daemon has declared migrated (topic_vec_migrations).
// Pre-migration (0 rows in topic_vec_migrations), there are no orphans by definition —
// chunks marked embedded=1 in the old robotdojo.db vec0 tables are just un-migrated, not orphans.
// An orphan is only meaningful when a topic row exists in topic_vec_migrations but the
// corresponding vec0 rows are absent from embeddings.db (daemon marked done but write failed).
const migratedTopics = migratedVectorTopics(db);

if (migratedTopics.length === 0) {
  const vectorTableAudit = pruneStaleVectorRows(db, {
    stores: [{ name: 'main', database: db }],
    dryRun: true,
  });
  if (!vectorTableAudit.ok) {
    writeResult({
      ok: false,
      reason: 'vector_table_stale_rows',
      migrated_topics: 0,
      missing_vectors: 0,
      stale_vectors: vectorTableAudit.stale_vectors,
      malformed_tables: vectorTableAudit.malformed_tables,
      vector_table_audit: vectorTableAudit,
      by_topic: [],
    });
    console.error(
      `[check-vec-orphans] FAIL: stale_vectors=${vectorTableAudit.stale_vectors}` +
      ` malformed_tables=${vectorTableAudit.malformed_tables}`
    );
    process.exit(1);
  }
  writeResult({
    ok: true,
    reason: 'no_migrated_topics',
    migrated_topics: 0,
    missing_vectors: 0,
    stale_vectors: 0,
    malformed_tables: 0,
    vector_table_audit: vectorTableAudit,
    by_topic: [],
  });
  console.log('[check-vec-orphans] no migrated topics yet — migration not started, no orphans possible');
  process.exit(0);
}

const embeddingsDb = openSplitVectorStore();
if (!embeddingsDb) {
  writeResult({
    ok: false,
    reason: 'embeddings_db_unavailable',
    migrated_topics: migratedTopics.length,
    topics: migratedTopics,
  });
  console.error(`[check-vec-orphans] FAIL: embeddings.db not open but ${migratedTopics.length} topic(s) are marked migrated`);
  process.exit(1);
}

const parity = splitVectorParity(db, migratedTopics, { embeddingsDb });
const vectorTableAudit = pruneStaleVectorRows(db, {
  stores: [
    { name: 'main', database: db },
    { name: 'embeddings', database: embeddingsDb },
  ],
  dryRun: true,
});
for (const topicResult of parity.by_topic) {
  console.log(
    `[check-vec-orphans] topic="${topicResult.topic}": ${topicResult.embedded} embedded in robotdojo.db, ${topicResult.vectors} in embeddings.db` +
    ` — missing_vectors=${topicResult.missing_vectors} stale_vectors=${topicResult.stale_vectors}`
  );
}

if (vectorTableAudit.by_table.length) {
  for (const tableResult of vectorTableAudit.by_table.filter((row) => row.stale_vectors || row.malformed)) {
    console.log(
      `[check-vec-orphans] table="${tableResult.store}:${tableResult.table}":` +
      ` stale_vectors=${tableResult.stale_vectors ?? 'unknown'}` +
      ` malformed=${tableResult.malformed ? 'true' : 'false'}`
    );
  }
}

if (!parity.ok || !vectorTableAudit.ok) {
  writeResult({
    ok: false,
    reason: parity.ok ? 'vector_table_stale_rows' : 'split_vector_parity_failed',
    migrated_topics: migratedTopics.length,
    missing_vectors: parity.missing_vectors,
    stale_vectors: vectorTableAudit.stale_vectors,
    split_stale_vectors: parity.stale_vectors,
    malformed_tables: vectorTableAudit.malformed_tables,
    by_topic: parity.by_topic,
    vector_table_audit: vectorTableAudit,
  });
  console.error(
    `[check-vec-orphans] FAIL: missing_vectors=${parity.missing_vectors}` +
    ` stale_vectors=${vectorTableAudit.stale_vectors}` +
    ` malformed_tables=${vectorTableAudit.malformed_tables}`
  );
  process.exit(1);
}

writeResult({
  ok: true,
  reason: 'split_vector_parity_ok',
  migrated_topics: migratedTopics.length,
  missing_vectors: parity.missing_vectors,
  stale_vectors: vectorTableAudit.stale_vectors,
  split_stale_vectors: parity.stale_vectors,
  malformed_tables: vectorTableAudit.malformed_tables,
  by_topic: parity.by_topic,
  vector_table_audit: vectorTableAudit,
});
console.log(
  `[check-vec-orphans] ok — ${migratedTopics.length} topic(s) checked,` +
  ` split vectors match embedded chunks and ${vectorTableAudit.tables_checked} vec0 table(s) have no stale rows`
);
process.exit(0);
