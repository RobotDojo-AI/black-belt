/**
 * lib/topic-lifecycle.js — st_8c7b7a6b
 *
 * Mechanical topic lifecycle helpers. These do NOT classify or
 * re-categorize — they handle the structural plumbing that travels
 * with a topic CRUD operation:
 *
 *   renameTopic   slug change, no content reshuffle. UPDATE chunks.topic
 *                 + ALTER TABLE chunk_vec_<old> RENAME TO chunk_vec_<new>
 *                 in one transaction. No needs_regen flag — content
 *                 didn't move semantically.
 *
 *   deleteTopic   reassign chunks to parent T1, or the catch-all
 *                 (NEEDS_ROUTING_TOPIC, slug 'uncategorized', displayed as
 *                 "Unfiled" — see lib/topic-routing-policy.js's
 *                 UNCATEGORIZED_LABEL) when a root topic is deleted, then
 *                 DROP TABLE chunk_vec_<slug> + DELETE
 *                 FROM user_topics. Optional regen of the target is set via
 *                 needs_regen=1 so the watcher picks it up after 5 min (the
 *                 absorbed content may shift the target's centroid).
 *
 *   addTopic      INSERT user_topics row + ensure chunk_vec_<slug> exists
 *                 + set needs_regen=1 so the watcher classifies eligible
 *                 chunks into the new topic on the next debounced pass.
 *
 *   editDescription      UPDATE user_topics.description + set needs_regen=1.
 *                        The watcher takes it from there.
 *
 * Why this exists separately from routes/topics.js: route files should be
 * HTTP plumbing; the lifecycle logic is shared between routes, the
 * topic-edit-watcher, and any future CLI/admin tools. Thin-facade pattern.
 *
 * All helpers are atomic — each runs inside db.transaction() so a crash
 * mid-rename can never leave chunks.topic out of sync with
 * chunk_vec_<slug>.
 */

import db from './db.js';
import {
  ensureDefaultTopicWorkbench,
  rehomeTopicWorkbenches,
  repointTopicWorkbenches,
  topicContextPath,
} from './workbenches.js';
import { topicContextPathForSlugs } from './context-paths.js';
import { markMaintenanceDirty, recordMaintenanceLedger } from './maintenance.js';
import {
  createTopic,
  deleteTopicRow,
  markTopicNeedsRegen,
  renameTopicSlug,
  reparentTopicChildren,
  updateTopic,
} from './topics.js';
import { EMBED_DIM, EMBED_MODEL, contentHash, embeddingSignature } from './rag.js';
import {
  ensureVecTable,
  openSplitVectorStore,
  safeVecTableName,
  tableExists,
  topicRequiresSplitVecStore,
} from './split-vector-store.js';
import { NEEDS_ROUTING_TOPIC } from './topic-routing-policy.js';

const slugToTable = safeVecTableName;

let splitVectorDb;
function getSplitVectorDb() {
  if (splitVectorDb !== undefined) return splitVectorDb;
  splitVectorDb = openSplitVectorStore();
  return splitVectorDb;
}

function vecStoreForTopic(slug) {
  const split = topicRequiresSplitVecStore(slug, db);
  const database = split ? getSplitVectorDb() : db;
  if (split && !database) {
    throw new Error(`topic "${slug}" is migrated to embeddings.db but no embeddingsDb connection is available`);
  }
  return { database, tableName: slugToTable(slug), split };
}

function moveAllVectors(sourceSlug, targetSlug) {
  const source = vecStoreForTopic(sourceSlug);
  const target = vecStoreForTopic(targetSlug);
  ensureVecTable(target.database, target.tableName, EMBED_DIM);
  if (!tableExists(source.database, source.tableName)) {
    return { moved: 0, movedIds: [], skippedStale: 0, missingSource: [] };
  }
  const liveIds = db.prepare('SELECT id FROM chunks WHERE topic = ? AND embedded = 1')
    .all(sourceSlug)
    .map((row) => String(row.id));
  const liveSet = new Set(liveIds);
  const rows = source.database.prepare(`SELECT chunk_id, embedding FROM ${source.tableName}`).all();
  const delTarget = target.database.prepare(`DELETE FROM ${target.tableName} WHERE chunk_id = ?`);
  const insTarget = target.database.prepare(`INSERT INTO ${target.tableName}(chunk_id, embedding) VALUES (?, ?)`);
  const movedIds = new Set();
  let skippedStale = 0;
  for (const row of rows) {
    const chunkId = String(row.chunk_id);
    if (!liveSet.has(chunkId)) {
      skippedStale += 1;
      continue;
    }
    delTarget.run(chunkId);
    insTarget.run(chunkId, row.embedding);
    movedIds.add(chunkId);
  }
  return {
    moved: movedIds.size,
    movedIds: [...movedIds],
    skippedStale,
    missingSource: liveIds.filter((id) => !movedIds.has(id)),
  };
}

function dropVectorTable(slug) {
  const store = vecStoreForTopic(slug);
  try { store.database.exec(`DROP TABLE IF EXISTS ${store.tableName}`); } catch { /* tolerable */ }
}

function resetMovedChunksWithMissingVectors(chunkIds) {
  const ids = [...new Set((chunkIds || []).map((id) => Number(id)).filter(Number.isFinite))];
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`
    UPDATE chunks
       SET embedded = 0,
           embedding_model_id = NULL,
           embedding_dim = NULL,
           embedding_signature = NULL,
           embedded_at = NULL
     WHERE id IN (${placeholders})
  `).run(...ids).changes;
}

function restoreMovedChunkEmbeddings(chunkIds, topic) {
  const ids = [...new Set((chunkIds || []).map((id) => Number(id)).filter(Number.isFinite))];
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT id, content, content_hash
    FROM chunks
    WHERE id IN (${placeholders})
  `).all(...ids);
  const restore = db.prepare(`
    UPDATE chunks
       SET embedded = 1,
           content_hash = ?,
           embedding_model_id = ?,
           embedding_dim = ?,
           embedding_signature = ?,
           embedded_at = datetime('now')
     WHERE id = ?
  `);
  let restored = 0;
  for (const row of rows) {
    const hash = row.content_hash || contentHash(row.content || '');
    const signature = embeddingSignature({
      content_hash: hash,
      topic,
      modelId: EMBED_MODEL,
      dim: EMBED_DIM,
    });
    restore.run(hash, EMBED_MODEL, EMBED_DIM, signature, row.id);
    restored += 1;
  }
  return restored;
}

function pruneVectorTableToLiveTopic(slug) {
  const store = vecStoreForTopic(slug);
  if (!tableExists(store.database, store.tableName)) return 0;
  const liveIds = new Set(
    db.prepare('SELECT id FROM chunks WHERE topic = ? AND embedded = 1')
      .all(slug)
      .map((row) => String(row.id)),
  );
  const staleIds = store.database.prepare(`SELECT chunk_id FROM ${store.tableName}`)
    .all()
    .map((row) => String(row.chunk_id))
    .filter((id) => !liveIds.has(id));
  if (staleIds.length === 0) return 0;
  const del = store.database.prepare(`DELETE FROM ${store.tableName} WHERE chunk_id = ?`);
  for (const id of staleIds) del.run(id);
  return staleIds.length;
}

function renameVectorTable(oldSlug, newSlug, oldWasMigrated) {
  const database = oldWasMigrated ? getSplitVectorDb() : db;
  if (oldWasMigrated && !database) {
    throw new Error(`topic "${oldSlug}" is migrated to embeddings.db but no embeddingsDb connection is available`);
  }
  const oldTable = slugToTable(oldSlug);
  const newTable = slugToTable(newSlug);
  if (!tableExists(database, oldTable)) {
    return { renamed: false, movedIds: [], skippedStale: 0, missingSource: [] };
  }
  const liveIds = db.prepare('SELECT id FROM chunks WHERE topic = ? AND embedded = 1')
    .all(oldSlug)
    .map((row) => String(row.id));
  const liveSet = new Set(liveIds);
  // sqlite-vec virtual tables have shadow tables; ALTER TABLE can rename the
  // visible table while leaving shadow rowid tables behind. Copy/drop is slower
  // but preserves vec0 integrity.
  ensureVecTable(database, newTable, EMBED_DIM);
  const rows = database.prepare(`SELECT chunk_id, embedding FROM ${oldTable}`).all();
  const delStmt = database.prepare(`DELETE FROM ${newTable} WHERE chunk_id = ?`);
  const ins = database.prepare(`INSERT INTO ${newTable}(chunk_id, embedding) VALUES (?, ?)`);
  const movedIds = new Set();
  let skippedStale = 0;
  for (const row of rows) {
    const chunkId = String(row.chunk_id);
    if (!liveSet.has(chunkId)) {
      skippedStale += 1;
      continue;
    }
    delStmt.run(chunkId);
    ins.run(chunkId, row.embedding);
    movedIds.add(chunkId);
  }
  database.exec(`DROP TABLE IF EXISTS ${oldTable}`);
  return {
    renamed: true,
    movedIds: [...movedIds],
    skippedStale,
    missingSource: liveIds.filter((id) => !movedIds.has(id)),
  };
}

function renameTopicMigration(oldSlug, newSlug) {
  db.prepare(`
    INSERT OR IGNORE INTO topic_vec_migrations (topic, migrated_at)
    SELECT ?, migrated_at FROM topic_vec_migrations WHERE topic = ?
  `).run(newSlug, oldSlug);
  db.prepare('DELETE FROM topic_vec_migrations WHERE topic = ?').run(oldSlug);
}

/**
 * Rename a topic. Mechanical: slug change in user_topics + propagate to
 * chunks.topic + ALTER TABLE rename of the sqlite-vec table. No
 * reclassification — content is unchanged semantically.
 *
 * Both arguments are slugs. The label is set elsewhere.
 *
 * @returns {{rowsUpdated: number, vecRenamed: boolean}}
 */
export function renameTopic(oldSlug, newSlug, options = {}) {
  if (!oldSlug || !newSlug || oldSlug === newSlug) {
    return { rowsUpdated: 0, vecRenamed: false };
  }

  const topicBefore = db.prepare('SELECT slug, parent_slug FROM user_topics WHERE slug = ?').get(oldSlug);
  const childTopicsBefore = db.prepare('SELECT slug FROM user_topics WHERE parent_slug = ?').all(oldSlug);
  const oldContextPath = topicContextPathForSlugs(topicBefore?.parent_slug || '', oldSlug);
  const newContextPath = topicContextPathForSlugs(topicBefore?.parent_slug || '', newSlug);

  const oldWasMigrated = topicRequiresSplitVecStore(oldSlug, db);

  let rowsUpdated = 0;
  let vecRenamed = false;
  let vecPruned = 0;
  let vectorsRestored = 0;
  let staleVectorsSkipped = 0;
  let missingVectorsReset = 0;

  const tx = db.transaction(() => {
    // 1. Update user_topics slug. Parent_slug references for child topics
    //    also need to update if anything refers to oldSlug as parent.
    renameTopicSlug(db, oldSlug, newSlug);

    // 2. Repoint chunks.
    const vectorMove = renameVectorTable(oldSlug, newSlug, oldWasMigrated);
    staleVectorsSkipped = vectorMove.skippedStale;

    const r = db.prepare('UPDATE chunks SET topic = ? WHERE topic = ?').run(newSlug, oldSlug);
    rowsUpdated = r.changes;
    if (oldWasMigrated) {
      renameTopicMigration(oldSlug, newSlug);
    }
    vectorsRestored = restoreMovedChunkEmbeddings(vectorMove.movedIds, newSlug);
    missingVectorsReset = resetMovedChunksWithMissingVectors(vectorMove.missingSource);

    // 3. Repoint conversations.
    db.prepare('UPDATE conversations SET topic_slug = ? WHERE topic_slug = ?').run(newSlug, oldSlug);
    db.prepare('UPDATE conversation_topics SET topic_slug = ? WHERE topic_slug = ?').run(newSlug, oldSlug);

    vecRenamed = vectorMove.renamed;
    vecPruned = pruneVectorTableToLiveTopic(newSlug);
  });
  tx();

  repointTopicWorkbenches(db, {
    fromSlug: oldSlug,
    toSlug: newSlug,
    fromContextPath: oldContextPath,
    toContextPath: newContextPath,
  }, options);
  for (const child of childTopicsBefore) {
    rehomeTopicWorkbenches(db, {
      topicSlug: child.slug,
      fromContextPath: topicContextPathForSlugs(oldSlug, child.slug),
      toContextPath: topicContextPathForSlugs(newSlug, child.slug),
    }, options);
  }
  markMaintenanceDirty(db, {
    targetType: 'topic',
    targetId: newSlug,
    reason: 'topic-renamed',
    priority: 85,
    metadata: { oldSlug },
  });
  recordMaintenanceLedger(db, {
    routineId: 'topic-lifecycle',
    targetType: 'topic',
    targetId: newSlug,
    action: 'rename-topic-cascade',
    status: 'done',
    metadata: { oldSlug, rowsUpdated, vecRenamed, vecPruned, vectorsRestored, staleVectorsSkipped, missingVectorsReset },
  });

  return { rowsUpdated, vecRenamed, vecPruned, vectorsRestored, staleVectorsSkipped, missingVectorsReset };
}

/**
 * Delete a topic. Chunks currently tagged with this slug are reassigned to the
 * parent T1, or to the catch-all (NEEDS_ROUTING_TOPIC — the SAME 'uncategorized'
 * slug lib/topic-routing-policy.js routes ambiguous content to, now displayed
 * as "Unfiled"; there is no separate "Uncategorized" topic) when the deleted
 * topic is itself a T1 with no parent. Their vectors are moved to the target's chunk_vec_<target> table.
 * The deleted topic's vec table is dropped. The target is marked
 * needs_regen=1 so the watcher refreshes its description_embedding +
 * context_md after 5 min.
 *
 * @returns {{rowsMoved: number, parent: string}}
 */
export function deleteTopic(slug, options = {}) {
  if (!slug) return { rowsMoved: 0, parent: null };

  const topic = db.prepare('SELECT slug, parent_slug FROM user_topics WHERE slug = ?').get(slug);
  if (!topic) return { rowsMoved: 0, parent: null };

  // Decide where the chunks land. T2 -> its parent. T1 -> the catch-all
  // (NEEDS_ROUTING_TOPIC, slug 'uncategorized' — displayed as "Unfiled").
  const target = topic.parent_slug || NEEDS_ROUTING_TOPIC;
  const fromContextPath = topicContextPathForSlugs(topic.parent_slug || '', slug);
  const targetContextPath = topicContextPath(db, target);

  let rowsMoved = 0;
  let vectorsMoved = 0;
  let vectorsRestored = 0;
  let staleVectorsSkipped = 0;
  let missingVectorsReset = 0;
  const tx = db.transaction(() => {
    const vectorMove = moveAllVectors(slug, target);
    vectorsMoved = vectorMove.moved;
    staleVectorsSkipped = vectorMove.skippedStale;

    // Repoint chunks + conversations.
    rowsMoved = db.prepare('UPDATE chunks SET topic = ? WHERE topic = ?').run(target, slug).changes;
    vectorsRestored = restoreMovedChunkEmbeddings(vectorMove.movedIds, target);
    missingVectorsReset = resetMovedChunksWithMissingVectors(vectorMove.missingSource);
    db.prepare('UPDATE conversations SET topic_slug = ? WHERE topic_slug = ?').run(target, slug);
    db.prepare('UPDATE conversation_topics SET topic_slug = ? WHERE topic_slug = ?').run(target, slug);

    // Drop old vec table + user_topics row.
    dropVectorTable(slug);
    db.prepare('DELETE FROM topic_vec_migrations WHERE topic = ?').run(slug);
    deleteTopicRow(db, slug);

    // Flag the parent for the watcher (description_embedding + context_md
    // may shift now that it absorbed orphaned content).
    if (target) {
      markTopicNeedsRegen(db, target);
    }
  });
  tx();

  repointTopicWorkbenches(db, {
    fromSlug: slug,
    toSlug: target,
    fromContextPath,
    toContextPath: targetContextPath,
  }, options);
  if (target) {
    markMaintenanceDirty(db, {
      targetType: 'topic',
      targetId: target,
      reason: 'topic-deleted-absorbed-content',
      priority: 85,
    metadata: { deletedSlug: slug, rowsMoved, vectorsMoved, vectorsRestored, staleVectorsSkipped, missingVectorsReset },
  });
  }
  recordMaintenanceLedger(db, {
    routineId: 'topic-lifecycle',
    targetType: 'topic',
    targetId: slug,
    action: 'delete-topic-cascade',
    status: 'done',
    metadata: { target, rowsMoved, vectorsMoved, vectorsRestored, staleVectorsSkipped, missingVectorsReset },
  });

  return { rowsMoved, parent: target, vectorsMoved, vectorsRestored, staleVectorsSkipped, missingVectorsReset };
}

/**
 * Merge a topic into an explicit surviving topic. Same mechanical rules as
 * deleteTopic, but the target is owner-selected instead of parent/default.
 * Workbenches attached to the absorbed topic move under the survivor.
 *
 * @returns {{rowsMoved: number, target: string}}
 */
export function mergeTopic(sourceSlug, targetSlug, options = {}) {
  if (!sourceSlug || !targetSlug || sourceSlug === targetSlug) return { rowsMoved: 0, target: targetSlug || null };

  const source = db.prepare('SELECT slug, parent_slug FROM user_topics WHERE slug = ?').get(sourceSlug);
  const target = db.prepare('SELECT slug, parent_slug FROM user_topics WHERE slug = ?').get(targetSlug);
  if (!source || !target) return { rowsMoved: 0, target: null };

  const fromContextPath = topicContextPathForSlugs(source.parent_slug || '', sourceSlug);
  const targetContextPath = topicContextPath(db, targetSlug);

  let rowsMoved = 0;
  let vectorsMoved = 0;
  let vectorsRestored = 0;
  let staleVectorsSkipped = 0;
  let missingVectorsReset = 0;
  const tx = db.transaction(() => {
    const vectorMove = moveAllVectors(sourceSlug, targetSlug);
    vectorsMoved = vectorMove.moved;
    staleVectorsSkipped = vectorMove.skippedStale;

    rowsMoved = db.prepare('UPDATE chunks SET topic = ? WHERE topic = ?').run(targetSlug, sourceSlug).changes;
    vectorsRestored = restoreMovedChunkEmbeddings(vectorMove.movedIds, targetSlug);
    missingVectorsReset = resetMovedChunksWithMissingVectors(vectorMove.missingSource);
    db.prepare('UPDATE conversations SET topic_slug = ? WHERE topic_slug = ?').run(targetSlug, sourceSlug);
    db.prepare('UPDATE conversation_topics SET topic_slug = ? WHERE topic_slug = ?').run(targetSlug, sourceSlug);
    reparentTopicChildren(db, sourceSlug, targetSlug);
    dropVectorTable(sourceSlug);
    db.prepare('DELETE FROM topic_vec_migrations WHERE topic = ?').run(sourceSlug);
    deleteTopicRow(db, sourceSlug);
    markTopicNeedsRegen(db, targetSlug);
  });
  tx();

  repointTopicWorkbenches(db, {
    fromSlug: sourceSlug,
    toSlug: targetSlug,
    fromContextPath,
    toContextPath: targetContextPath,
  }, options);
  markMaintenanceDirty(db, {
    targetType: 'topic',
    targetId: targetSlug,
    reason: 'topic-merged-absorbed-content',
    priority: 90,
    metadata: { sourceSlug, rowsMoved, vectorsMoved, vectorsRestored, staleVectorsSkipped, missingVectorsReset },
  });
  recordMaintenanceLedger(db, {
    routineId: 'topic-lifecycle',
    targetType: 'topic',
    targetId: targetSlug,
    action: 'merge-topic-cascade',
    status: 'done',
    metadata: { sourceSlug, rowsMoved, vectorsMoved, vectorsRestored, staleVectorsSkipped, missingVectorsReset },
  });

  return { rowsMoved, target: targetSlug, vectorsMoved, vectorsRestored, staleVectorsSkipped, missingVectorsReset };
}

/**
 * Add a new topic. Creates the user_topics row + chunk_vec_<slug>
 * virtual table + flags needs_regen=1 so the watcher classifies
 * candidate chunks into it on the next debounced pass.
 *
 * @returns {{created: boolean}}
 */
export function addTopic({ slug, label, description, parent_slug = null, visible = 1, icon = null }, options = {}) {
  if (!slug || !label) return { created: false };

  const existing = db.prepare('SELECT 1 FROM user_topics WHERE slug = ?').get(slug);
  if (existing) return { created: false };

  const tx = db.transaction(() => {
    const result = createTopic(db, { slug, label, description, parent_slug, visible, icon });
    if (result.error) throw new Error(result.message || result.error);
  });
  tx();
  ensureDefaultTopicWorkbench(db, slug, options);
  markMaintenanceDirty(db, {
    targetType: 'topic',
    targetId: slug,
    reason: 'topic-created',
    priority: 80,
    metadata: { parent_slug },
  });

  return { created: true };
}

/**
 * Edit a topic's description (the "seed" the model uses to understand
 * what the topic means). Sets needs_regen=1 so the watcher refreshes
 * description_embedding + reclassifies + regens context_md on the next
 * debounced pass.
 *
 * @returns {{updated: boolean}}
 */
export function editTopicDescription(slug, description) {
  if (!slug) return { updated: false };
  const result = updateTopic(db, slug, { description: description || null });
  if (result?.ok) {
    markMaintenanceDirty(db, {
      targetType: 'topic',
      targetId: slug,
      reason: 'topic-description-edited',
      priority: 75,
    });
  }
  return { updated: result?.ok === true };
}
