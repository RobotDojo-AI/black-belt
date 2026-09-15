import db, { openEmbeddingsDb } from './db.js';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import config from './config.js';
import { buildLayeredContext } from './chat-context.js';
import {
  migratedVectorTopics,
  splitVectorParity,
} from './split-vector-store.js';

function proofSlug(value) {
  return String(value || 'qa-live-data-plane-proof')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'qa-live-data-plane-proof';
}

const PROOF_NAMESPACE = process.env.ROBOTDOJO_DATA_PLANE_PROOF_NAMESPACE || 'qa:live-data-plane-proof';
const PROOF_SLUG = proofSlug(PROOF_NAMESPACE);
const PROOF_ID = PROOF_SLUG.replace(/-/g, '_');

export const DATA_PLANE_PROOF = Object.freeze({
  namespace: PROOF_NAMESPACE,
  topic: 'general',
  sourceType: 'qa_data_plane_proof',
  sourceId: `${PROOF_NAMESPACE}:chunk`,
  importOriginalName: `${PROOF_SLUG}-import.unknown`,
  personId: `${PROOF_ID}_person`,
  personName: 'Robot Dojo Proof Entity',
  token: 'rdjliveproof16858d1f',
  jobId: `${PROOF_ID}_job`,
  jobType: 'qa.data_plane_proof',
  jobUniqueKey: `${PROOF_NAMESPACE}:job`,
});

export const REQUIRED_DATA_PLANE_BOUNDARIES = Object.freeze([
  'db',
  'passive_jobs',
  'import_classification',
  'raw_source',
  'search',
  'embedding',
  'first_use_context',
  'semantic_retrieval',
  'entity_enrichment',
  'chat_context',
]);

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function proofContent(stamp) {
  return [
    `Robot Dojo live data plane proof token ${DATA_PLANE_PROOF.token}.`,
    `Namespace ${DATA_PLANE_PROOF.namespace}.`,
    `Entity ${DATA_PLANE_PROOF.personName}.`,
    `Generated ${stamp}.`,
    'Synthetic fact: chat context and entity enrichment can consume local data-plane rows.',
  ].join(' ');
}

function proofQuery() {
  return [
    'Use private Robot Dojo context for',
    DATA_PLANE_PROOF.personName,
    DATA_PLANE_PROOF.token,
  ].join(' ');
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function importProofDir() {
  return join(config.configDir, 'runtime', 'data-plane-proof');
}

function importProofPath() {
  return join(importProofDir(), DATA_PLANE_PROOF.importOriginalName);
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?"
  ).get(name));
}

function columnSet(database, table) {
  try {
    return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

function boundary(checks = {}, counts = {}, extra = {}) {
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    counts,
    ...extra,
  };
}

function failedBoundary(error, checks = {}, counts = {}) {
  return {
    ok: false,
    checks,
    counts,
    error: String(error?.message || error || 'unknown_error').slice(0, 500),
  };
}

function runOptionalColumnUpdate(database, table, idColumn, idValue, values) {
  const columns = columnSet(database, table);
  const entries = Object.entries(values).filter(([column]) => columns.has(column));
  if (!entries.length) return;
  const set = entries.map(([column]) => `${column} = ?`).join(', ');
  const params = entries.map(([, value]) => value);
  params.push(idValue);
  database.prepare(`UPDATE ${table} SET ${set} WHERE ${idColumn} = ?`).run(...params);
}

function upsertPerson(database, stamp) {
  database.prepare(`
    INSERT INTO people (
      id, display_name, short_name, tier, notes, score, archived,
      first_seen, last_seen, created_at, updated_at
    )
    VALUES (?, ?, ?, 'core', ?, 99, 0, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      short_name = excluded.short_name,
      tier = excluded.tier,
      notes = excluded.notes,
      score = excluded.score,
      archived = 0,
      last_seen = excluded.last_seen,
      updated_at = excluded.updated_at
  `).run(
    DATA_PLANE_PROOF.personId,
    DATA_PLANE_PROOF.personName,
    'Proof Entity',
    DATA_PLANE_PROOF.namespace,
    stamp,
    stamp,
    stamp,
    stamp,
  );

  runOptionalColumnUpdate(database, 'people', 'id', DATA_PLANE_PROOF.personId, {
    n1: 'Business',
    n2: 'Network',
    business_tier: 'network',
    class: 'business',
    subcategory: 'qa',
    class_confidence: 1,
    class_sources: json([DATA_PLANE_PROOF.namespace]),
    needs_regen: 0,
  });
}

function upsertChunk(database, stamp) {
  const content = proofContent(stamp);
  const metadata = {
    namespace: DATA_PLANE_PROOF.namespace,
    proof_token: DATA_PLANE_PROOF.token,
    title: 'Live data plane proof',
    event_time: stamp,
    synthetic: true,
  };

  database.prepare(`
    INSERT INTO chunks (
      topic, source_type, source_id, chunk_index, content, metadata,
      token_count, embedded, skip_embed, created_at
    )
    VALUES (?, ?, ?, 0, ?, ?, ?, 0, 0, ?)
    ON CONFLICT(topic, source_type, source_id, chunk_index) DO UPDATE SET
      content = excluded.content,
      metadata = excluded.metadata,
      token_count = excluded.token_count,
      embedded = 0,
      skip_embed = 0,
      created_at = excluded.created_at
  `).run(
    DATA_PLANE_PROOF.topic,
    DATA_PLANE_PROOF.sourceType,
    DATA_PLANE_PROOF.sourceId,
    content,
    json(metadata),
    Math.ceil(content.length / 4),
    stamp,
  );

  runOptionalColumnUpdate(database, 'chunks', 'source_id', DATA_PLANE_PROOF.sourceId, {
    event_time: stamp,
    quality_score: 1,
    embedding_model_id: null,
    embedding_dim: null,
    embedding_signature: null,
  });

  return database.prepare(`
    SELECT id, content
    FROM chunks
    WHERE topic = ?
      AND source_type = ?
      AND source_id = ?
      AND chunk_index = 0
  `).get(DATA_PLANE_PROOF.topic, DATA_PLANE_PROOF.sourceType, DATA_PLANE_PROOF.sourceId);
}

function upsertChunkEntity(database, chunkId) {
  database.prepare(`
    INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id, entity_type)
    VALUES (?, ?, 'person')
  `).run(chunkId, DATA_PLANE_PROOF.personId);
}

function upsertEntityFact(database, stamp) {
  const sourceEventIds = json([DATA_PLANE_PROOF.sourceId]);
  const factValue = [
    `Proof namespace ${DATA_PLANE_PROOF.namespace}.`,
    `Proof token ${DATA_PLANE_PROOF.token}.`,
    'Synthetic current fact for data-plane QA.',
  ].join(' ');

  const existing = database.prepare(`
    SELECT id
    FROM entity_facts
    WHERE entity_id = ?
      AND entity_type = 'person'
      AND fact_type = 'general'
      AND source_event_ids = ?
      AND invalid_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `).get(DATA_PLANE_PROOF.personId, sourceEventIds);

  if (existing?.id) {
    database.prepare(`
      UPDATE entity_facts
      SET fact_value = ?, valid_at = ?, extracted_at = ?, model_tier = 'free'
      WHERE id = ?
    `).run(factValue, stamp, stamp, existing.id);
    return existing.id;
  }

  const info = database.prepare(`
    INSERT INTO entity_facts (
      entity_id, entity_type, fact_type, fact_value,
      source_event_ids, valid_at, invalid_at, extracted_at, model_tier
    )
    VALUES (?, 'person', 'general', ?, ?, ?, NULL, ?, 'free')
  `).run(DATA_PLANE_PROOF.personId, factValue, sourceEventIds, stamp, stamp);
  return info.lastInsertRowid;
}

function upsertPassiveJob(database, stamp) {
  database.prepare(`
    INSERT INTO passive_jobs (
      id, queue, job_type, unique_key, target_type, target_id, payload, status,
      priority, attempts, max_attempts, retry_count, run_after, timeout_ms,
      last_success_at, metadata, created_at, finished_at, updated_at
    )
    VALUES (?, 'qa', ?, ?, 'qa_namespace', ?, ?, 'done',
      100, 1, 1, 0, ?, 30000, ?, ?, ?, ?, ?)
    ON CONFLICT(unique_key) DO UPDATE SET
      payload = excluded.payload,
      status = 'done',
      attempts = 1,
      retry_count = 0,
      last_success_at = excluded.last_success_at,
      last_error = NULL,
      quarantine_reason = NULL,
      metadata = excluded.metadata,
      finished_at = excluded.finished_at,
      updated_at = excluded.updated_at
  `).run(
    DATA_PLANE_PROOF.jobId,
    DATA_PLANE_PROOF.jobType,
    DATA_PLANE_PROOF.jobUniqueKey,
    DATA_PLANE_PROOF.namespace,
    json({ namespace: DATA_PLANE_PROOF.namespace, proof_token: DATA_PLANE_PROOF.token }),
    stamp,
    stamp,
    json({ synthetic: true, namespace: DATA_PLANE_PROOF.namespace }),
    stamp,
    stamp,
    stamp,
  );
}

function writeProofRows(database, stamp) {
  let chunk;
  database.transaction(() => {
    upsertPerson(database, stamp);
    chunk = upsertChunk(database, stamp);
    upsertChunkEntity(database, chunk.id);
    upsertEntityFact(database, stamp);
    upsertPassiveJob(database, stamp);
  })();
  return { chunkId: chunk.id };
}

export function cleanupDataPlaneProofRows({ database = db } = {}) {
  const counts = {};
  const runDelete = (key, sql, params = []) => {
    try {
      counts[key] = database.prepare(sql).run(...params).changes;
    } catch {
      counts[key] = 0;
    }
  };

  database.transaction(() => {
    runDelete('entity_facts', `
      DELETE FROM entity_facts
      WHERE entity_id = ?
        AND entity_type = 'person'
        AND source_event_ids = ?
    `, [DATA_PLANE_PROOF.personId, json([DATA_PLANE_PROOF.sourceId])]);
    runDelete('chunk_entities', `
      DELETE FROM chunk_entities
      WHERE entity_id = ?
        OR chunk_id IN (
          SELECT id FROM chunks
          WHERE source_type = ? AND source_id = ?
        )
    `, [DATA_PLANE_PROOF.personId, DATA_PLANE_PROOF.sourceType, DATA_PLANE_PROOF.sourceId]);
    runDelete('chunks', `
      DELETE FROM chunks
      WHERE source_type = ? AND source_id = ?
    `, [DATA_PLANE_PROOF.sourceType, DATA_PLANE_PROOF.sourceId]);
    runDelete('people', 'DELETE FROM people WHERE id = ?', [DATA_PLANE_PROOF.personId]);
    runDelete('passive_jobs', `
      DELETE FROM passive_jobs
      WHERE id = ? OR unique_key = ? OR target_id = ?
    `, [DATA_PLANE_PROOF.jobId, DATA_PLANE_PROOF.jobUniqueKey, DATA_PLANE_PROOF.namespace]);
    runDelete('drop_folder_files_fts', `
      DELETE FROM drop_folder_files_fts
      WHERE path = ?
         OR path IN (
        SELECT path FROM drop_folder_files
        WHERE path = ? OR original_name = ?
      )
    `, [importProofPath(), importProofPath(), DATA_PLANE_PROOF.importOriginalName]);
    runDelete('drop_folder_files', `
      DELETE FROM drop_folder_files
      WHERE path = ? OR original_name = ?
    `, [importProofPath(), DATA_PLANE_PROOF.importOriginalName]);
  })();
  try {
    if (existsSync(importProofPath())) {
      unlinkSync(importProofPath());
      counts.import_file = 1;
    } else {
      counts.import_file = 0;
    }
  } catch {
    counts.import_file = 0;
  }

  return counts;
}

export function countDataPlaneProofRows({ database = db } = {}) {
  const counts = {};
  const runCount = (key, sql, params = []) => {
    try {
      counts[key] = Number(database.prepare(sql).get(...params)?.count || 0);
    } catch {
      counts[key] = 0;
    }
  };

  runCount('entity_facts', `
    SELECT COUNT(*) AS count
    FROM entity_facts
    WHERE entity_id = ?
      AND entity_type = 'person'
      AND source_event_ids = ?
  `, [DATA_PLANE_PROOF.personId, json([DATA_PLANE_PROOF.sourceId])]);
  runCount('chunk_entities', `
    SELECT COUNT(*) AS count
    FROM chunk_entities
    WHERE entity_id = ?
      OR chunk_id IN (
        SELECT id FROM chunks
        WHERE source_type = ? AND source_id = ?
      )
  `, [DATA_PLANE_PROOF.personId, DATA_PLANE_PROOF.sourceType, DATA_PLANE_PROOF.sourceId]);
  runCount('chunks', `
    SELECT COUNT(*) AS count
    FROM chunks
    WHERE source_type = ? AND source_id = ?
  `, [DATA_PLANE_PROOF.sourceType, DATA_PLANE_PROOF.sourceId]);
  runCount('people', 'SELECT COUNT(*) AS count FROM people WHERE id = ?', [DATA_PLANE_PROOF.personId]);
  runCount('passive_jobs', `
    SELECT COUNT(*) AS count
    FROM passive_jobs
    WHERE id = ? OR unique_key = ? OR target_id = ?
  `, [DATA_PLANE_PROOF.jobId, DATA_PLANE_PROOF.jobUniqueKey, DATA_PLANE_PROOF.namespace]);
  runCount('drop_folder_files', `
    SELECT COUNT(*) AS count
    FROM drop_folder_files
    WHERE path = ? OR original_name = ?
  `, [importProofPath(), DATA_PLANE_PROOF.importOriginalName]);
  runCount('drop_folder_files_fts', `
    SELECT COUNT(*) AS count
    FROM drop_folder_files_fts
    WHERE path = ?
       OR path IN (
      SELECT path FROM drop_folder_files
      WHERE path = ? OR original_name = ?
    )
  `, [importProofPath(), importProofPath(), DATA_PLANE_PROOF.importOriginalName]);
  counts.import_file = existsSync(importProofPath()) ? 1 : 0;

  return counts;
}

function allZero(counts) {
  return Object.values(counts || {}).every((value) => Number(value) === 0);
}

function proveDb(database, writeInfo) {
  try {
    const one = database.prepare('SELECT 1 AS ok').get();
    const chunk = database.prepare('SELECT id FROM chunks WHERE id = ?').get(writeInfo.chunkId);
    return boundary(
      { opened: one?.ok === 1, proof_rows_written: Boolean(chunk?.id) },
      { proof_chunks: chunk?.id ? 1 : 0 },
    );
  } catch (err) {
    return failedBoundary(err);
  }
}

function provePassiveJobs(database) {
  try {
    const row = database.prepare(`
      SELECT status, job_type, target_id
      FROM passive_jobs
      WHERE unique_key = ?
      LIMIT 1
    `).get(DATA_PLANE_PROOF.jobUniqueKey);
    const totals = database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM passive_jobs
      GROUP BY status
    `).all();
    return boundary(
      {
        table_readable: tableExists(database, 'passive_jobs'),
        proof_job_readable: row?.status === 'done',
      },
      {
        proof_jobs: row ? 1 : 0,
        statuses_seen: totals.length,
      },
    );
  } catch (err) {
    return failedBoundary(err, { table_readable: false, proof_job_readable: false });
  }
}

async function proveImportClassification(database, stamp) {
  const filePath = importProofPath();
  try {
    mkdirSync(importProofDir(), { recursive: true });
    writeFileSync(filePath, [
      `Robot Dojo live import classification proof token ${DATA_PLANE_PROOF.token}.`,
      `Namespace ${DATA_PLANE_PROOF.namespace}.`,
      `Generated ${stamp}.`,
      'This intentionally ambiguous file must remain unresolved until evidence routes it.',
    ].join('\n'));

    const { processOne } = await import('./drop-folder/watcher.js');
    await processOne(filePath, {
      _shouldSkipUpload: (name) => name === DATA_PLANE_PROOF.importOriginalName,
      _uploadArchive: async () => {
        throw new Error('data plane proof should not upload archive');
      },
    });

    const row = database.prepare(`
      SELECT path, original_name, topic_t1, topic_t2, doc_type, source, status
      FROM drop_folder_files
      WHERE path = ?
      LIMIT 1
    `).get(filePath);
    const fts = database.prepare(`
      SELECT 1 AS ok
      FROM drop_folder_files_fts
      WHERE path = ?
      LIMIT 1
    `).get(filePath);

    return boundary(
      {
        file_ingested: Boolean(row?.path),
        source_row_indexed: fts?.ok === 1,
        classifier_routed_unknown: row?.doc_type === 'other',
        unknown_started_uncategorized: row?.topic_t1 === 'uncategorized',
        unknown_not_personal: row?.topic_t1 !== 'personal' && row?.topic_t2 !== 'personal',
        upload_did_not_delete_unarchived_source: row?.status === 'upload_pending' && existsSync(filePath),
      },
      {
        rows: row ? 1 : 0,
        fts_rows: fts?.ok === 1 ? 1 : 0,
      },
      {
        evidence: {
          path: 'drop-folder processOne -> classifyFile -> routeGeneric -> drop_folder_files',
          original_name: DATA_PLANE_PROOF.importOriginalName,
          topic_t1: row?.topic_t1 || null,
          topic_t2: row?.topic_t2 || null,
          doc_type: row?.doc_type || null,
          source: row?.source || null,
          status: row?.status || null,
          redacted: true,
        },
      },
    );
  } catch (err) {
    return failedBoundary(err, {
      file_ingested: false,
      source_row_indexed: false,
      classifier_routed_unknown: false,
      unknown_started_uncategorized: false,
      unknown_not_personal: false,
      upload_did_not_delete_unarchived_source: false,
    });
  }
}

function proveRawSource(database) {
  try {
    const row = database.prepare(`
      SELECT id, content
      FROM chunks
      WHERE source_type = ? AND source_id = ?
      LIMIT 1
    `).get(DATA_PLANE_PROOF.sourceType, DATA_PLANE_PROOF.sourceId);
    return boundary(
      {
        proof_chunk_present: Boolean(row?.id),
        proof_token_present: Boolean(row?.content?.includes(DATA_PLANE_PROOF.token)),
        proof_namespace_present: Boolean(row?.content?.includes(DATA_PLANE_PROOF.namespace)),
      },
      { proof_chunks: row ? 1 : 0 },
    );
  } catch (err) {
    return failedBoundary(err);
  }
}

function proveSearch(database) {
  try {
    const rows = database.prepare(`
      SELECT c.id
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.rowid
      WHERE chunks_fts MATCH ?
        AND c.source_type = ?
        AND c.source_id = ?
      LIMIT 5
    `).all(DATA_PLANE_PROOF.token, DATA_PLANE_PROOF.sourceType, DATA_PLANE_PROOF.sourceId);
    return boundary(
      { fts_hit: rows.length > 0 },
      { hits: rows.length },
    );
  } catch (err) {
    return failedBoundary(err, { fts_hit: false });
  }
}

function proveEmbeddingFreshness(database, stamp) {
  try {
    const columns = columnSet(database, 'chunks');
    const select = [
      'id',
      'created_at',
      'embedded',
      'skip_embed',
      columns.has('event_time') ? 'event_time' : "created_at AS event_time",
      columns.has('embedding_model_id') ? 'embedding_model_id' : 'NULL AS embedding_model_id',
      columns.has('embedding_dim') ? 'embedding_dim' : 'NULL AS embedding_dim',
      columns.has('embedding_signature') ? 'embedding_signature' : 'NULL AS embedding_signature',
    ].join(', ');
    const row = database.prepare(`
      SELECT ${select}
      FROM chunks
      WHERE source_type = ? AND source_id = ?
      LIMIT 1
    `).get(DATA_PLANE_PROOF.sourceType, DATA_PLANE_PROOF.sourceId);
    const proofTime = Date.parse(row?.event_time || row?.created_at || '');
    const generatedTime = Date.parse(stamp);
    const ageMs = Number.isFinite(proofTime) && Number.isFinite(generatedTime)
      ? Math.abs(generatedTime - proofTime)
      : Number.POSITIVE_INFINITY;
    const pending = row?.embedded === 0 && row?.skip_embed === 0;
    const embedded = row?.embedded === 1;
    const queue = database.prepare(`
      SELECT COUNT(*) AS count
      FROM chunks
      WHERE embedded = 0 AND skip_embed = 0
    `).get();
    return boundary(
      {
        proof_chunk_present: Boolean(row?.id),
        embedding_state_measurable: row?.embedded != null && row?.skip_embed != null,
        proof_chunk_fresh: ageMs <= 5 * 60 * 1000,
        proof_chunk_indexable: pending || embedded,
      },
      {
        proof_chunks: row ? 1 : 0,
        pending_embedding_chunks: queue.count,
      },
      {
        evidence: {
          state: embedded ? 'embedded' : (pending ? 'pending' : 'skipped_or_unknown'),
          has_embedding_signature: Boolean(row?.embedding_signature),
          embedding_dim: row?.embedding_dim ?? null,
          redacted: true,
        },
      },
    );
  } catch (err) {
    return failedBoundary(err);
  }
}

async function defaultLocalEmbeddingModelStatus() {
  const { localEmbeddingModelStatus } = await import('./rag/local-embed.js');
  return localEmbeddingModelStatus();
}

async function defaultGlobalDiskStatus() {
  const { getGlobalDiskStatus } = await import('./ann/usearch-adapter.js');
  return getGlobalDiskStatus();
}

async function defaultLoadGlobalIndex(database, opts) {
  const { loadGlobalIndex } = await import('./ann/usearch-adapter.js');
  return loadGlobalIndex(database, opts);
}

function migratedTopics(database) {
  return migratedVectorTopics(database);
}

function countRows(database, sql, ...params) {
  return Number(database.prepare(sql).get(...params)?.count || 0);
}

function annGrowthThreshold(builtFrom) {
  const driftRaw = Number(process.env.ROBOTDOJO_DATA_PLANE_ANN_DRIFT || process.env.ROBOTDOJO_ANN_REBUILD_DRIFT || 0.005);
  const minRaw = Number(process.env.ROBOTDOJO_DATA_PLANE_ANN_MIN_CHUNKS || process.env.ROBOTDOJO_ANN_REBUILD_MIN_CHUNKS || 64);
  const drift = Number.isFinite(driftRaw) && driftRaw >= 0 ? driftRaw : 0.005;
  const minChunks = Number.isFinite(minRaw) && minRaw > 0 ? Math.floor(minRaw) : 64;
  const count = Number(builtFrom) || 0;
  if (count <= 0) return 1;
  return Math.max(minChunks, Math.ceil(count * drift));
}

function proveSplitVectorParity(database, topics, {
  openEmbeddingsDbFn = openEmbeddingsDb,
} = {}) {
  let embeddingsDb = null;
  try {
    embeddingsDb = openEmbeddingsDbFn();
    if (!embeddingsDb) {
      return {
        ok: false,
        split_embeddings_open: false,
        topics_checked: 0,
        missing_vectors: null,
        stale_vectors: null,
        error: 'embeddings_db_unavailable',
      };
    }

    return splitVectorParity(database, topics, { embeddingsDb });
  } catch (err) {
    return {
      ok: false,
      split_embeddings_open: Boolean(embeddingsDb),
      topics_checked: 0,
      missing_vectors: null,
      stale_vectors: null,
      error: String(err?.message || err).slice(0, 500),
    };
  } finally {
    try { embeddingsDb?.close?.(); } catch {}
  }
}

async function proveSemanticRetrieval(database, {
  requireSemanticReadiness = process.env.ROBOTDOJO_DB !== ':memory:',
  semanticDeps = {},
} = {}) {
  try {
    const embeddedChunks = countRows(database, 'SELECT COUNT(*) AS count FROM chunks WHERE embedded = 1');
    const pendingEmbeddingChunks = countRows(database, 'SELECT COUNT(*) AS count FROM chunks WHERE embedded = 0 AND skip_embed = 0');
    const modelStatus = await (semanticDeps.localEmbeddingModelStatusFn || defaultLocalEmbeddingModelStatus)();
    const embeddingModelInstalled = modelStatus?.installed === true;

    if (!requireSemanticReadiness) {
      return boundary(
        {
          fixture_semantic_readiness_not_required: true,
          semantic_state_measurable: true,
        },
        { embedded_chunks: embeddedChunks, pending_embedding_chunks: pendingEmbeddingChunks },
        {
          evidence: {
            state: 'fixture_not_required',
            embedding_model_state: modelStatus?.state || null,
            redacted: true,
          },
        },
      );
    }

    if (embeddedChunks <= 0) {
      return boundary(
        {
          embedding_model_installed: embeddingModelInstalled,
          no_embedded_corpus_yet: true,
          pending_embedding_queue_visible: pendingEmbeddingChunks > 0,
        },
        { embedded_chunks: embeddedChunks, pending_embedding_chunks: pendingEmbeddingChunks },
        {
          evidence: {
            state: 'pending_first_embedding',
            embedding_model_state: modelStatus?.state || null,
            redacted: true,
          },
        },
      );
    }

    const topics = migratedTopics(database);
    const parity = await (semanticDeps.vectorParityFn || proveSplitVectorParity)(database, topics, semanticDeps);
    const disk = await (semanticDeps.getGlobalDiskStatusFn || defaultGlobalDiskStatus)();
    const ann = await (semanticDeps.loadGlobalIndexFn || defaultLoadGlobalIndex)(database, { repairMode: 'none' });
    const annFullSize = Number(ann?.full_size || 0);
    const diskFullSize = Number(disk?.full_size || 0);
    const diskBuiltFromCount = Number(disk?.built_from_count || 0);
    const diskSourceEmbeddedCount = Number(disk?.source_embedded_count || 0);
    const annDriftChunks = embeddedChunks - diskBuiltFromCount;
    const annDriftThreshold = annGrowthThreshold(diskBuiltFromCount);
    const annDriftWithinThreshold = annDriftChunks >= 0 && annDriftChunks < annDriftThreshold;
    const annCorpusExactlyIndexed = annDriftChunks === 0;
    const annSourceCountMatchesBuilt = diskSourceEmbeddedCount > 0 && diskSourceEmbeddedCount === diskBuiltFromCount;
    const semanticState = ann?.loaded
      ? (annCorpusExactlyIndexed ? 'semantic_ready' : 'semantic_ann_drift')
      : 'semantic_unavailable';

    return boundary(
      {
        embedding_model_installed: embeddingModelInstalled,
        embedded_corpus_present: embeddedChunks > 0,
        migrated_topics_present: topics.length > 0,
        split_vectors_match_embedded_chunks: parity.ok === true,
        ann_artifacts_compatible: disk?.compatible === true,
        ann_loaded_without_repair: ann?.loaded === true,
        ann_full_size_matches_disk: annFullSize > 0 && annFullSize === diskFullSize,
        ann_built_from_count_matches_full_size: diskFullSize > 0 && diskFullSize === diskBuiltFromCount,
        ann_source_count_matches_built_count: annSourceCountMatchesBuilt,
        ann_corpus_drift_nonnegative: annDriftChunks >= 0,
        ann_corpus_drift_within_rebuild_threshold: annDriftWithinThreshold,
        ann_corpus_exactly_indexed: annCorpusExactlyIndexed,
      },
      {
        embedded_chunks: embeddedChunks,
        pending_embedding_chunks: pendingEmbeddingChunks,
        migrated_topics: topics.length,
        missing_vectors: parity.missing_vectors,
        stale_vectors: parity.stale_vectors,
        ann_full_size: annFullSize,
        ann_built_from_count: diskBuiltFromCount,
        ann_source_embedded_count: diskSourceEmbeddedCount,
        ann_drift_chunks: annDriftChunks,
        ann_growth_threshold: annDriftThreshold,
      },
      {
        evidence: {
          state: semanticState,
          embedding_model_state: modelStatus?.state || null,
          vector_parity: {
            ok: parity.ok === true,
            split_embeddings_open: parity.split_embeddings_open === true,
            topics_checked: parity.topics_checked ?? null,
          },
          ann: {
            loaded: ann?.loaded === true,
            reason: ann?.reason || null,
            disk_compatible: disk?.compatible === true,
            disk_sidecar: disk?.sidecar === true,
            disk_hot: disk?.hot === true,
            disk_full: disk?.full === true,
          },
          redacted: true,
        },
      },
    );
  } catch (err) {
    return failedBoundary(err);
  }
}

async function proveFirstUseContext(database, buildContextFn) {
  try {
    const row = database.prepare(`
      SELECT id, embedded, skip_embed
      FROM chunks
      WHERE source_type = ?
        AND source_id = ?
      LIMIT 1
    `).get(DATA_PLANE_PROOF.sourceType, DATA_PLANE_PROOF.sourceId);
    const pending = row?.embedded === 0 && row?.skip_embed === 0;
    const context = await buildContextFn(proofQuery(), {
      topic: DATA_PLANE_PROOF.topic,
      belt: 'black',
    });
    const text = String(context || '');
    const tokenConsumed = text.includes(DATA_PLANE_PROOF.token);
    return boundary(
      {
        proof_chunk_present: Boolean(row?.id),
        proof_chunk_pending_embedding: pending,
        bounded_context_before_embedding: pending && tokenConsumed,
        proof_entity_consumed: text.includes(DATA_PLANE_PROOF.personName),
      },
      { context_chars: text.length },
      {
        evidence: {
          path: 'buildLayeredContext',
          state: 'bounded_local_context_before_embedding',
          vector_backfill_required: false,
          redacted: true,
        },
      },
    );
  } catch (err) {
    return failedBoundary(err, {
      proof_chunk_present: false,
      proof_chunk_pending_embedding: false,
      bounded_context_before_embedding: false,
      proof_entity_consumed: false,
    });
  }
}

function proveEntityEnrichment(database) {
  try {
    const person = database.prepare('SELECT id, score, archived FROM people WHERE id = ?')
      .get(DATA_PLANE_PROOF.personId);
    const link = database.prepare(`
      SELECT COUNT(*) AS count
      FROM chunk_entities ce
      JOIN chunks c ON c.id = ce.chunk_id
      WHERE ce.entity_type = 'person'
        AND (ce.entity_id = ? OR CAST(ce.entity_id AS TEXT) = ?)
        AND c.source_type = ?
        AND c.source_id = ?
    `).get(
      DATA_PLANE_PROOF.personId,
      DATA_PLANE_PROOF.personId,
      DATA_PLANE_PROOF.sourceType,
      DATA_PLANE_PROOF.sourceId,
    );
    const fact = database.prepare(`
      SELECT COUNT(*) AS count
      FROM entity_facts
      WHERE entity_id = ?
        AND entity_type = 'person'
        AND fact_type = 'general'
        AND invalid_at IS NULL
        AND fact_value LIKE ?
    `).get(DATA_PLANE_PROOF.personId, `%${DATA_PLANE_PROOF.token}%`);
    return boundary(
      {
        person_active: Boolean(person?.id && person.archived === 0 && person.score > 0),
        chunk_entity_linked: link.count > 0,
        current_fact_present: fact.count > 0,
      },
      {
        links: link.count,
        current_facts: fact.count,
      },
    );
  } catch (err) {
    return failedBoundary(err);
  }
}

async function proveChatContext(buildContextFn) {
  try {
    const context = await buildContextFn(proofQuery(), {
      topic: DATA_PLANE_PROOF.topic,
      belt: 'black',
    });
    const text = String(context || '');
    return boundary(
      {
        product_context_path_called: true,
        proof_token_consumed: text.includes(DATA_PLANE_PROOF.token),
        proof_namespace_consumed: text.includes(DATA_PLANE_PROOF.namespace),
        proof_entity_consumed: text.includes(DATA_PLANE_PROOF.personName),
      },
      { context_chars: text.length },
      {
        evidence: {
          path: 'buildLayeredContext',
          redacted: true,
          query_namespace: DATA_PLANE_PROOF.namespace,
        },
      },
    );
  } catch (err) {
    return failedBoundary(err, { product_context_path_called: false });
  }
}

export async function runDataPlaneProof({
  database = db,
  cleanup = false,
  buildContextFn = buildLayeredContext,
  requireSemanticReadiness = process.env.ROBOTDOJO_DB !== ':memory:',
  semanticDeps = {},
  now = new Date(),
} = {}) {
  const stamp = iso(now);
  const cleanupReport = {
    requested: Boolean(cleanup),
    ok: true,
    // Back-compat aliases. Prefer the clearer names below.
    before: {},
    after: {},
    pre_existing_removed: {},
    proof_rows_removed: {},
    remaining_after_cleanup: {},
  };

  if (cleanup) {
    try {
      cleanupReport.pre_existing_removed = cleanupDataPlaneProofRows({ database });
      cleanupReport.before = cleanupReport.pre_existing_removed;
    } catch (err) {
      cleanupReport.ok = false;
      cleanupReport.error = String(err.message || err).slice(0, 500);
    }
  }

  const boundaries = {};
  let writeInfo = { chunkId: null };
  try {
    writeInfo = writeProofRows(database, stamp);
    boundaries.db = proveDb(database, writeInfo);
  } catch (err) {
    boundaries.db = failedBoundary(err, { opened: false, proof_rows_written: false });
  }

  boundaries.passive_jobs = provePassiveJobs(database);
  boundaries.import_classification = await proveImportClassification(database, stamp);
  boundaries.raw_source = proveRawSource(database);
  boundaries.search = proveSearch(database);
  boundaries.embedding = proveEmbeddingFreshness(database, stamp);
  boundaries.first_use_context = await proveFirstUseContext(database, buildContextFn);
  boundaries.semantic_retrieval = await proveSemanticRetrieval(database, { requireSemanticReadiness, semanticDeps });
  boundaries.entity_enrichment = proveEntityEnrichment(database);
  boundaries.chat_context = await proveChatContext(buildContextFn);

  if (cleanup) {
    try {
      cleanupReport.proof_rows_removed = cleanupDataPlaneProofRows({ database });
      cleanupReport.after = cleanupReport.proof_rows_removed;
      cleanupReport.remaining_after_cleanup = countDataPlaneProofRows({ database });
      cleanupReport.ok = cleanupReport.ok && allZero(cleanupReport.remaining_after_cleanup);
    } catch (err) {
      cleanupReport.ok = false;
      cleanupReport.error = String(err.message || err).slice(0, 500);
    }
  }

  const requiredOk = REQUIRED_DATA_PLANE_BOUNDARIES.every((name) => boundaries[name]?.ok === true);
  return {
    ok: requiredOk && cleanupReport.ok,
    namespace: DATA_PLANE_PROOF.namespace,
    proof_id: DATA_PLANE_PROOF.token,
    generated_at: stamp,
    redacted: true,
    required_boundaries: [...REQUIRED_DATA_PLANE_BOUNDARIES],
    boundaries,
    cleanup: cleanupReport,
  };
}
