#!/usr/bin/env node
/**
 * Repair migrated-topic split vector tables without re-embedding:
 *   - copy live embedded vectors that still exist in the legacy main DB into embeddings.db
 *   - prune stale split vectors whose chunks are no longer embedded/live
 */

export const INTELLIGENCE_TIER = 'extraction';

import db from '../../lib/db.js';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  migratedVectorTopics,
  openSplitVectorStore,
  pruneStaleVectorRows,
  repairVectorPlacement,
  repairSplitVectorParity,
  safeVecTableName,
} from '../../lib/split-vector-store.js';

const dryRun = process.argv.includes('--dry-run');
const onlyTopicArg = process.argv.find((arg) => arg.startsWith('--topic='));
const onlyTopic = onlyTopicArg ? onlyTopicArg.slice('--topic='.length) : null;
const resultFileArg = process.argv.find((arg) => arg.startsWith('--result-file='));
const resultFileFlagIndex = process.argv.indexOf('--result-file');
const resultFile = resultFileArg
  ? resultFileArg.slice('--result-file='.length)
  : resultFileFlagIndex >= 0 && process.argv[resultFileFlagIndex + 1] && !process.argv[resultFileFlagIndex + 1].startsWith('--')
    ? process.argv[resultFileFlagIndex + 1]
    : process.env.ROBOTDOJO_SPLIT_VEC_REPAIR_RESULT_FILE || null;

function atomicWriteJson(path, payload) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
}

function writeResult(payload) {
  atomicWriteJson(resultFile, {
    action: 'split_vector_repair',
    checked_at: new Date().toISOString(),
    dry_run: dryRun,
    topic: onlyTopic || null,
    ...payload,
  });
}

const embeddingsDb = openSplitVectorStore();
if (!embeddingsDb) {
  writeResult({
    ok: false,
    reason: 'embeddings_db_unavailable',
  });
  console.error('[repair-split-vec-orphans] embeddings.db not open');
  process.exit(1);
}

const migratedTopics = migratedVectorTopics(db)
  .filter((topic) => !onlyTopic || topic === onlyTopic);

if (onlyTopic && migratedTopics.length === 0) {
  writeResult({
    ok: false,
    reason: 'topic_not_migrated',
    migrated_topics: 0,
  });
  console.error(`[repair-split-vec-orphans] topic is not migrated: ${onlyTopic}`);
  process.exit(1);
}

const placementRepair = repairVectorPlacement(db, {
  embeddingsDb,
  topics: onlyTopic ? [onlyTopic] : null,
  dryRun,
});
const result = repairSplitVectorParity(db, {
  embeddingsDb,
  topics: migratedTopics,
  dryRun,
});
const stalePrune = pruneStaleVectorRows(db, {
  stores: [
    { name: 'main', database: db },
    { name: 'embeddings', database: embeddingsDb },
  ],
  dryRun,
  onlyTables: onlyTopic ? [safeVecTableName(onlyTopic)] : null,
});

for (const topicResult of placementRepair.by_topic.filter((row) => row.missing || row.copyable || row.missing_source)) {
  console.log(
    `[repair-split-vec-orphans] placement topic="${topicResult.topic}" missing=${topicResult.missing}` +
    ` copyable=${topicResult.copyable}` +
    ` exact_source=${topicResult.exact_source ?? 'unknown'}` +
    ` relocated_source=${topicResult.ambient_source ?? 'unknown'}` +
    ` missing_source=${topicResult.missing_source}` +
    ` target=${topicResult.store}:${topicResult.table}`
  );
}

for (const topicResult of result.by_topic) {
  if (topicResult.missing === 0 && topicResult.stale === 0) {
    console.log(`[repair-split-vec-orphans] topic="${topicResult.topic}" ok`);
    continue;
  }
  console.log(
    `[repair-split-vec-orphans] topic="${topicResult.topic}" missing=${topicResult.missing}` +
    ` copyable=${topicResult.copyable}` +
    ` exact_source=${topicResult.exact_source ?? 'unknown'}` +
    ` ambient_source=${topicResult.ambient_source ?? 'unknown'}` +
    ` missing_source=${topicResult.missing_source} stale=${topicResult.stale}`
  );
}

for (const tableResult of stalePrune.by_table.filter((row) => row.stale_vectors || row.malformed)) {
  console.log(
    `[repair-split-vec-orphans] table="${tableResult.store}:${tableResult.table}"` +
    ` stale=${tableResult.stale_vectors ?? 'unknown'}` +
    ` pruned=${tableResult.pruned}` +
    ` malformed=${tableResult.malformed ? 'true' : 'false'}`
  );
}

console.log(
  `[repair-split-vec-orphans] ${dryRun ? 'dry_run ' : ''}` +
  `copied=${placementRepair.placed + result.copied}` +
  ` placement_copyable=${placementRepair.copyable}` +
  ` split_pruned=${result.pruned}` +
  ` placement_requeued=${placementRepair.requeued_missing_source || 0}` +
  ` exact_source=${(placementRepair.exact_source || 0) + (result.exact_source || 0)}` +
  ` ambient_source=${(placementRepair.ambient_source || 0) + (result.ambient_source || 0)}` +
  ` stale_pruned=${stalePrune.pruned}` +
  ` stale_vectors=${stalePrune.stale_vectors}` +
  ` malformed_tables=${stalePrune.malformed_tables}` +
  ` missing_source=${placementRepair.missing_source + (dryRun ? 0 : result.missing_source)}`
);
const combinedCopied = placementRepair.placed + result.copied;
const combinedExactSource = (placementRepair.exact_source || 0) + (result.exact_source || 0);
const combinedAmbientSource = (placementRepair.ambient_source || 0) + (result.ambient_source || 0);
const combinedMissingSource = placementRepair.missing_source + (dryRun ? 0 : result.missing_source);
const ok = combinedMissingSource === 0 && stalePrune.malformed_tables === 0;
writeResult({
  ok,
  reason: ok ? 'split_vector_repair_ok' : 'split_vector_repair_failed',
  migrated_topics: migratedTopics.length,
  copied: combinedCopied,
  placement_copyable: placementRepair.copyable,
  placement_requeued: placementRepair.requeued_missing_source || 0,
  placement_repair: placementRepair,
  split_pruned: result.pruned,
  exact_source: combinedExactSource,
  ambient_source: combinedAmbientSource,
  missing_source: combinedMissingSource,
  stale_pruned: stalePrune.pruned,
  stale_vectors: stalePrune.stale_vectors,
  malformed_tables: stalePrune.malformed_tables,
  by_topic: result.by_topic,
  vector_table_repair: stalePrune,
});
process.exit(ok ? 0 : 1);
