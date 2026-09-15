import dbDefault, { openEmbeddingsDb } from './db.js';
import { EMBED_DIM } from './rag.js';

export function safeVecTableName(topic) {
  return `chunk_vec_${String(topic || '').replace(/[^a-z0-9_]/g, '_')}`;
}

export function tableExists(database, tableName) {
  try {
    return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName));
  } catch {
    return false;
  }
}

export function vec0TableNames(database) {
  try {
    return database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name LIKE 'chunk_vec_%'
        AND sql LIKE '%USING vec0%'
      ORDER BY name
    `).all()
      .map((row) => String(row.name || ''))
      .filter((name) => /^chunk_vec_[A-Za-z0-9_]+$/.test(name));
  } catch {
    return [];
  }
}

export function topicRequiresSplitVecStore(topic, database = dbDefault) {
  try {
    return Boolean(database.prepare('SELECT 1 FROM topic_vec_migrations WHERE topic = ?').get(topic));
  } catch {
    return false;
  }
}

export function pruneStaleVectorRows(database = dbDefault, {
  stores = [{ name: 'main', database }],
  dryRun = false,
  ambientTopic = 'general',
  onlyTables = null,
} = {}) {
  const ambientTable = safeVecTableName(ambientTopic);
  const selectedTables = onlyTables ? new Set([...onlyTables].map(String)) : null;
  const chunkById = database.prepare('SELECT id, topic, embedded FROM chunks WHERE id = ?');
  const byTable = [];
  let staleVectors = 0;
  let malformedTables = 0;
  let pruned = 0;
  let tablesChecked = 0;

  for (const store of stores) {
    if (!store?.database) continue;
    for (const tableName of vec0TableNames(store.database)) {
      if (selectedTables && !selectedTables.has(tableName)) continue;
      tablesChecked += 1;
      let rows = [];
      try {
        rows = store.database.prepare(`SELECT chunk_id FROM ${tableName}`).all();
      } catch (err) {
        malformedTables += 1;
        byTable.push({
          store: store.name,
          table: tableName,
          vectors: null,
          stale_vectors: null,
          pruned: 0,
          malformed: true,
          error: err?.message || String(err),
        });
        continue;
      }

      const staleIds = [];
      for (const row of rows) {
        const chunkId = Number(row.chunk_id);
        if (!Number.isSafeInteger(chunkId)) {
          staleIds.push(String(row.chunk_id));
          continue;
        }
        const chunk = chunkById.get(chunkId);
        const chunkTable = chunk ? safeVecTableName(chunk.topic) : null;
        const liveForTable = Boolean(
          chunk
            && Number(chunk.embedded) === 1
            && (tableName === ambientTable || chunkTable === tableName)
        );
        if (!liveForTable) staleIds.push(String(row.chunk_id));
      }

      if (!dryRun && staleIds.length > 0) {
        const write = store.database.transaction((ids) => {
          const del = store.database.prepare(`DELETE FROM ${tableName} WHERE chunk_id = ?`);
          for (const id of ids) del.run(id);
        });
        write(staleIds);
        pruned += staleIds.length;
      }

      staleVectors += staleIds.length;
      byTable.push({
        store: store.name,
        table: tableName,
        vectors: rows.length,
        stale_vectors: staleIds.length,
        pruned: dryRun ? 0 : staleIds.length,
        malformed: false,
      });
    }
  }

  return {
    ok: staleVectors === 0 && malformedTables === 0,
    dry_run: dryRun,
    tables_checked: tablesChecked,
    stale_vectors: staleVectors,
    malformed_tables: malformedTables,
    pruned,
    by_table: byTable,
  };
}

export function migratedVectorTopics(database = dbDefault) {
  try {
    return database.prepare('SELECT topic FROM topic_vec_migrations ORDER BY topic')
      .all()
      .map((row) => row.topic);
  } catch {
    return [];
  }
}

export function openSplitVectorStore({ busyTimeoutMs = null } = {}) {
  try {
    const conn = openEmbeddingsDb();
    const timeout = Number(busyTimeoutMs);
    if (conn && Number.isFinite(timeout) && timeout > 0) {
      conn.pragma(`busy_timeout = ${Math.floor(timeout)}`);
    }
    return conn;
  } catch {
    return null;
  }
}

export function ensureVecTable(database, tableName, dim = EMBED_DIM) {
  const existing = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  const currentDim = existing?.sql?.match(/embedding\s+float\[(\d+)\]/i)?.[1];
  if (currentDim && Number(currentDim) !== dim) {
    throw new Error(`${tableName} has dimension ${currentDim}, expected ${dim}`);
  }
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName}
    USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${dim}])
  `);
}

export function vectorStoreForTopic(topic, {
  database = dbDefault,
  embeddingsDb = null,
  requireWritable = false,
} = {}) {
  const split = topicRequiresSplitVecStore(topic, database);
  if (split && !embeddingsDb) {
    if (requireWritable) {
      throw new Error(`topic "${topic}" is migrated to embeddings.db but no embeddingsDb connection is available`);
    }
    return {
      database: null,
      tableName: safeVecTableName(topic),
      split: true,
      missing: true,
    };
  }
  return {
    database: split ? embeddingsDb : database,
    tableName: safeVecTableName(topic),
    split,
    missing: false,
  };
}

export function readVecRowForTopic(topic, chunkId, options = {}) {
  const store = vectorStoreForTopic(topic, {
    ...options,
    requireWritable: options.requireWritable === true || options.requireReadable === true,
  });
  if (!store.database || !tableExists(store.database, store.tableName)) return null;
  try {
    return store.database.prepare(`SELECT embedding FROM ${store.tableName} WHERE chunk_id = ?`)
      .get(String(chunkId)) || null;
  } catch {
    return null;
  }
}

export function upsertVecRowForTopic(topic, chunkId, embedding, options = {}) {
  const store = vectorStoreForTopic(topic, { ...options, requireWritable: true });
  ensureVecTable(store.database, store.tableName, options.dim || EMBED_DIM);
  store.database.prepare(`DELETE FROM ${store.tableName} WHERE chunk_id = ?`).run(String(chunkId));
  store.database.prepare(`INSERT INTO ${store.tableName}(chunk_id, embedding) VALUES (?, ?)`)
    .run(String(chunkId), embedding);
  return true;
}

export function deleteVecRowForTopic(topic, chunkId, options = {}) {
  const store = vectorStoreForTopic(topic, { ...options, requireWritable: true });
  const stores = [{ database: store.database, tableName: store.tableName }];
  if (options.embeddingsDb && options.embeddingsDb !== store.database) {
    stores.push({ database: options.embeddingsDb, tableName: store.tableName });
  }
  if (options.database && options.database !== store.database) {
    stores.push({ database: options.database, tableName: store.tableName });
  }
  let deleted = 0;
  for (const candidate of stores) {
    if (!candidate?.database) continue;
    if (!tableExists(candidate.database, candidate.tableName)) continue;
    deleted += candidate.database.prepare(`DELETE FROM ${candidate.tableName} WHERE chunk_id = ?`).run(String(chunkId)).changes || 0;
  }
  return deleted > 0;
}

export function splitVectorParity(database = dbDefault, topics = migratedVectorTopics(database), {
  embeddingsDb = null,
} = {}) {
  if (!topics.length) {
    return {
      ok: true,
      split_embeddings_open: true,
      topics_checked: 0,
      missing_vectors: 0,
      stale_vectors: 0,
      by_topic: [],
    };
  }
  if (!embeddingsDb) {
    return {
      ok: false,
      split_embeddings_open: false,
      topics_checked: 0,
      missing_vectors: null,
      stale_vectors: null,
      by_topic: [],
      error: 'embeddings_db_unavailable',
    };
  }

  let missingVectors = 0;
  let staleVectors = 0;
  const byTopic = [];
  for (const topic of topics) {
    const tableName = safeVecTableName(topic);
    let vecIds = new Set();
    try {
      vecIds = new Set(
        embeddingsDb.prepare(`SELECT chunk_id FROM ${tableName}`)
          .all()
          .map((row) => String(row.chunk_id)),
      );
    } catch {
      vecIds = new Set();
    }
    const embeddedIds = database.prepare(`
      SELECT id
      FROM chunks
      WHERE topic = ? AND embedded = 1
    `).all(topic).map((row) => String(row.id));
    const embeddedSet = new Set(embeddedIds);
    const missing = embeddedIds.filter((id) => !vecIds.has(id));
    const stale = [...vecIds].filter((id) => !embeddedSet.has(id));
    byTopic.push({
      topic,
      embedded: embeddedIds.length,
      vectors: vecIds.size,
      missing_vectors: missing.length,
      stale_vectors: stale.length,
    });
    missingVectors += missing.length;
    staleVectors += stale.length;
  }

  return {
    ok: missingVectors === 0 && staleVectors === 0,
    split_embeddings_open: true,
    topics_checked: topics.length,
    missing_vectors: missingVectors,
    stale_vectors: staleVectors,
    by_topic: byTopic,
  };
}

function readVectorRowFromTable(database, tableName, chunkId) {
  if (!tableExists(database, tableName)) return null;
  try {
    const row = database.prepare(`SELECT embedding FROM ${tableName} WHERE chunk_id = ?`)
      .get(String(chunkId));
    return row?.embedding ? { tableName, embedding: row.embedding } : null;
  } catch {
    return null;
  }
}

function readVectorRowFromAnyTable(chunkId, {
  stores = [],
  preferredTable = null,
} = {}) {
  const seen = new Set();
  const tableNamesForStore = (store) => {
    const names = Array.isArray(store.tableNames) ? store.tableNames : vec0TableNames(store.database);
    if (preferredTable && names.includes(preferredTable)) {
      return [preferredTable, ...names.filter((name) => name !== preferredTable)];
    }
    return names;
  };

  for (const store of stores) {
    if (!store?.database) continue;
    for (const tableName of tableNamesForStore(store)) {
      const key = `${store.name || 'store'}:${tableName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let row = null;
      try {
        let stmt = store.statements?.get(tableName);
        if (!stmt) {
          stmt = store.database.prepare(`SELECT embedding FROM ${tableName} WHERE chunk_id = ?`);
          store.statements?.set(tableName, stmt);
        }
        const found = stmt.get(String(chunkId));
        row = found?.embedding ? { tableName, embedding: found.embedding } : null;
      } catch {
        row = readVectorRowFromTable(store.database, tableName, chunkId);
      }
      if (row?.embedding) {
        return {
          ...row,
          store: store.name || 'store',
          source_kind: tableName === preferredTable ? 'exact_topic' : 'relocated_topic',
        };
      }
    }
  }
  return null;
}

function findRepairSourceVectorRow(topic, chunkId, {
  database = dbDefault,
  embeddingsDb = null,
  ambientTopic = 'general',
} = {}) {
  const tableName = safeVecTableName(topic);
  const ambientTable = safeVecTableName(ambientTopic);
  const exactLegacy = readVectorRowFromTable(database, tableName, chunkId);
  if (exactLegacy) return { ...exactLegacy, store: 'main', source_kind: 'exact_topic' };
  if (ambientTable !== tableName) {
    const ambientLegacy = readVectorRowFromTable(database, ambientTable, chunkId);
    if (ambientLegacy) return { ...ambientLegacy, store: 'main', source_kind: 'ambient' };
  }
  if (embeddingsDb) {
    const exactSplit = readVectorRowFromTable(embeddingsDb, tableName, chunkId);
    if (exactSplit) return { ...exactSplit, store: 'embeddings', source_kind: 'exact_topic' };
    if (ambientTable !== tableName) {
      const ambientSplit = readVectorRowFromTable(embeddingsDb, ambientTable, chunkId);
      if (ambientSplit) return { ...ambientSplit, store: 'embeddings', source_kind: 'ambient' };
    }
  }
  return readVectorRowFromAnyTable(chunkId, {
    stores: [
      { name: 'main', database },
      ...(embeddingsDb ? [{ name: 'embeddings', database: embeddingsDb }] : []),
    ],
    preferredTable: tableName,
  });
}

export function repairVectorPlacement(database = dbDefault, {
  embeddingsDb = null,
  topics = null,
  dryRun = false,
} = {}) {
  const selectedTopics = topics
    ? [...topics]
    : database.prepare(`
      SELECT DISTINCT topic
      FROM chunks
      WHERE embedded = 1
        AND topic IS NOT NULL
      ORDER BY topic
    `).all().map((row) => row.topic);
  const stores = [
    { name: 'main', database, tableNames: vec0TableNames(database), statements: new Map() },
    ...(embeddingsDb ? [{ name: 'embeddings', database: embeddingsDb, tableNames: vec0TableNames(embeddingsDb), statements: new Map() }] : []),
  ];
  let placed = 0;
  let copyable = 0;
  let missingSource = 0;
  let requeuedMissingSource = 0;
  let exactSource = 0;
  let ambientSource = 0;
  const byTopic = [];
  const markMissingVectorSkipped = database.prepare(`
    UPDATE chunks
       SET skip_embed = 1,
           embedded = 0,
           content_hash = NULL,
           embedding_model_id = NULL,
           embedding_dim = NULL,
           embedding_signature = NULL,
           embedded_at = NULL
     WHERE id = ?
  `);
  const restoreMissingVectorEmbeddable = database.prepare(`
    UPDATE chunks
       SET skip_embed = 0
     WHERE id = ?
  `);

  for (const topic of selectedTopics) {
    const target = vectorStoreForTopic(topic, {
      database,
      embeddingsDb,
      requireWritable: !dryRun,
    });
    const tableName = safeVecTableName(topic);
    const targetDb = target.database || (target.split ? embeddingsDb : database);
    let missing = [];
    if (targetDb === database && tableExists(database, tableName)) {
      try {
        missing = database.prepare(`
          SELECT c.id
          FROM chunks c
          LEFT JOIN ${tableName} vec ON vec.chunk_id = CAST(c.id AS TEXT)
          WHERE c.topic = ?
            AND c.embedded = 1
            AND vec.chunk_id IS NULL
        `).all(topic).map((row) => String(row.id));
      } catch { /* malformed tables are audited by prune/check paths */ }
    } else {
      const present = new Set();
      if (targetDb && tableExists(targetDb, tableName)) {
        try {
          for (const row of targetDb.prepare(`SELECT chunk_id FROM ${tableName}`).all()) {
            present.add(String(row.chunk_id));
          }
        } catch { /* malformed tables are audited by prune/check paths */ }
      }
      const embeddedIds = database.prepare('SELECT id FROM chunks WHERE topic = ? AND embedded = 1')
        .all(topic)
        .map((row) => String(row.id));
      missing = embeddedIds.filter((id) => !present.has(id));
    }
    const embeddedCount = Number(database.prepare('SELECT COUNT(*) AS n FROM chunks WHERE topic = ? AND embedded = 1')
      .get(topic)?.n || 0);
    const rowsToPlace = [];
    const missingSourceIds = [];
    let topicExactSource = 0;
    let topicAmbientSource = 0;

    for (const chunkId of missing) {
      const row = readVectorRowFromAnyTable(chunkId, { stores, preferredTable: tableName });
      if (!row?.embedding) {
        missingSourceIds.push(chunkId);
        continue;
      }
      rowsToPlace.push({ chunkId, embedding: row.embedding, source_kind: row.source_kind });
      if (row.source_kind === 'exact_topic') {
        exactSource += 1;
        topicExactSource += 1;
      } else {
        ambientSource += 1;
        topicAmbientSource += 1;
      }
    }

    const stillMissing = missing.length - rowsToPlace.length;
    let topicRequeuedMissingSource = 0;
    if (!dryRun && missingSourceIds.length > 0) {
      const requeue = database.transaction((ids) => {
        let changed = 0;
        for (const id of ids) {
          const skipped = markMissingVectorSkipped.run(id).changes || 0;
          restoreMissingVectorEmbeddable.run(id);
          changed += skipped;
        }
        return changed;
      });
      topicRequeuedMissingSource = requeue(missingSourceIds);
      requeuedMissingSource += topicRequeuedMissingSource;
    }
    const unresolvedMissingSource = dryRun ? stillMissing : Math.max(0, stillMissing - topicRequeuedMissingSource);
    copyable += rowsToPlace.length;
    missingSource += unresolvedMissingSource;
    byTopic.push({
      topic,
      embedded: embeddedCount,
      missing: missing.length,
      copyable: rowsToPlace.length,
      missing_source: unresolvedMissingSource,
      original_missing_source: stillMissing,
      requeued_missing_source: topicRequeuedMissingSource,
      exact_source: topicExactSource,
      ambient_source: topicAmbientSource,
      table: tableName,
      store: target.split ? 'embeddings' : 'main',
    });

    if (!dryRun && rowsToPlace.length > 0) {
      const writeDb = targetDb;
      ensureVecTable(writeDb, tableName);
      const write = writeDb.transaction((copyRows) => {
        const del = writeDb.prepare(`DELETE FROM ${tableName} WHERE chunk_id = ?`);
        const ins = writeDb.prepare(`INSERT INTO ${tableName}(chunk_id, embedding) VALUES (?, ?)`);
        for (const row of copyRows) {
          del.run(row.chunkId);
          ins.run(row.chunkId, row.embedding);
        }
      });
      write(rowsToPlace);
      placed += rowsToPlace.length;
    }
  }

  return {
    ok: missingSource === 0,
    dry_run: dryRun,
    topics_checked: selectedTopics.length,
    copyable,
    placed: dryRun ? 0 : placed,
    missing_source: missingSource,
    requeued_missing_source: requeuedMissingSource,
    exact_source: exactSource,
    ambient_source: ambientSource,
    by_topic: byTopic,
  };
}

export function repairSplitVectorParity(database = dbDefault, {
  embeddingsDb = null,
  topics = migratedVectorTopics(database),
  dryRun = false,
  onlyTopic = null,
} = {}) {
  if (!embeddingsDb) {
    throw new Error('embeddings.db not open');
  }
  const selectedTopics = topics.filter((topic) => !onlyTopic || topic === onlyTopic);
  let copied = 0;
  let pruned = 0;
  let missingSource = 0;
  let exactSource = 0;
  let ambientSource = 0;
  const byTopic = [];

  for (const topic of selectedTopics) {
    const tableName = safeVecTableName(topic);
    ensureVecTable(embeddingsDb, tableName);
    const present = new Set(
      embeddingsDb.prepare(`SELECT chunk_id FROM ${tableName}`)
        .all()
        .map((row) => String(row.chunk_id)),
    );
    const embedded = database.prepare('SELECT id FROM chunks WHERE topic = ? AND embedded = 1')
      .all(topic)
      .map((row) => String(row.id));
    const embeddedSet = new Set(embedded);
    const stale = [...present].filter((id) => !embeddedSet.has(id));
    const missing = embedded.filter((id) => !present.has(id));
    const rowsToCopy = [];
    let topicExactSource = 0;
    let topicAmbientSource = 0;
    for (const chunkId of missing) {
      const row = findRepairSourceVectorRow(topic, chunkId, { database, embeddingsDb });
      if (row?.embedding) {
        rowsToCopy.push({ chunkId, embedding: row.embedding, source_kind: row.source_kind });
        if (row.source_kind === 'ambient') {
          ambientSource += 1;
          topicAmbientSource += 1;
        } else {
          exactSource += 1;
          topicExactSource += 1;
        }
      }
    }
    const stillMissing = missing.length - rowsToCopy.length;
    missingSource += stillMissing;
    byTopic.push({
      topic,
      missing: missing.length,
      copyable: rowsToCopy.length,
      missing_source: stillMissing,
      exact_source: topicExactSource,
      ambient_source: topicAmbientSource,
      stale: stale.length,
    });

    if (!dryRun && (rowsToCopy.length > 0 || stale.length > 0)) {
      const write = embeddingsDb.transaction((copyRows, staleIds) => {
        const del = embeddingsDb.prepare(`DELETE FROM ${tableName} WHERE chunk_id = ?`);
        const ins = embeddingsDb.prepare(`INSERT INTO ${tableName}(chunk_id, embedding) VALUES (?, ?)`);
        for (const chunkId of staleIds) del.run(chunkId);
        for (const row of copyRows) {
          del.run(row.chunkId);
          ins.run(row.chunkId, row.embedding);
        }
      });
      write(rowsToCopy, stale);
      copied += rowsToCopy.length;
      pruned += stale.length;
    }
  }

  return {
    copied,
    pruned,
    missing_source: missingSource,
    exact_source: exactSource,
    ambient_source: ambientSource,
    by_topic: byTopic,
  };
}
