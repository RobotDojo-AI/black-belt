#!/usr/bin/env node
/**
 * Audit the post-reclassification residue around Personal and Needs Routing.
 *
 * This does not pretend to semantically certify every remaining Personal chunk.
 * It makes the final review auditable: counts, source breakdowns, forbidden
 * fallback aliases, pending Personal embeddings, and small content samples.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import db from '../../lib/db.js';
import {
  openSplitVectorStore,
  readVecRowForTopic,
} from '../../lib/split-vector-store.js';
import {
  NEEDS_ROUTING_TOPIC,
  PERSONAL_SCOPE_REVIEW_SOURCE_TYPES,
  PERSONAL_TOPIC,
  UNKNOWN_TOPIC_ALIASES,
} from '../../lib/topic-routing-policy.js';

const FORBIDDEN_FALLBACK_TOPICS = [...UNKNOWN_TOPIC_ALIASES]
  .filter(Boolean)
  .filter((slug) => slug !== NEEDS_ROUTING_TOPIC);
const RECLASSIFY_THRESHOLD = Number(process.env.RECLASSIFY_THRESHOLD || 0.55);

function deserializeEmbedding(buf) {
  if (!buf || !(buf instanceof Buffer || buf instanceof Uint8Array)) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a?.length || 0, b?.length || 0);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

function hasTable(database, table) {
  try {
    return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

function hasColumn(database, table, column) {
  try {
    return database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

function countRows(database, sql, ...params) {
  try {
    return database.prepare(sql).get(...params)?.n || 0;
  } catch {
    return 0;
  }
}

function chunkCount(database, topic) {
  if (!hasTable(database, 'chunks')) return 0;
  return countRows(database, 'SELECT COUNT(*) AS n FROM chunks WHERE topic = ?', topic);
}

function pendingChunkCount(database, topic) {
  if (!hasTable(database, 'chunks')) return 0;
  const hasSkip = hasColumn(database, 'chunks', 'skip_embed');
  const skipClause = hasSkip ? 'AND COALESCE(skip_embed, 0) = 0' : '';
  return countRows(database, `
    SELECT COUNT(*) AS n
    FROM chunks
    WHERE topic = ?
      AND COALESCE(embedded, 0) = 0
      ${skipClause}
  `, topic);
}

function sourceBreakdown(database, topic, limit) {
  if (!hasTable(database, 'chunks') || !hasColumn(database, 'chunks', 'source_type')) return [];
  return database.prepare(`
    SELECT COALESCE(source_type, 'unknown') AS source_type, COUNT(*) AS chunks
    FROM chunks
    WHERE topic = ?
    GROUP BY COALESCE(source_type, 'unknown')
    ORDER BY chunks DESC, source_type
    LIMIT ?
  `).all(topic, limit);
}

function chunkSamples(database, topic, limit) {
  if (!hasTable(database, 'chunks')) return [];
  const cols = new Set(database.prepare('PRAGMA table_info(chunks)').all().map((row) => row.name));
  const select = [
    cols.has('id') ? 'id' : 'rowid AS id',
    cols.has('source_type') ? 'source_type' : 'NULL AS source_type',
    cols.has('source_id') ? 'source_id' : 'NULL AS source_id',
    cols.has('chunk_index') ? 'chunk_index' : 'NULL AS chunk_index',
    cols.has('embedded') ? 'embedded' : 'NULL AS embedded',
    cols.has('content') ? "substr(replace(replace(content, char(10), ' '), char(13), ' '), 1, 220) AS sample" : 'NULL AS sample',
  ].join(', ');
  return database.prepare(`
    SELECT ${select}
    FROM chunks
    WHERE topic = ?
    ORDER BY COALESCE(embedded, 0) ASC, id ASC
    LIMIT ?
  `).all(topic, limit);
}

function personalScopeReview(database, limit) {
  if (!hasTable(database, 'chunks') || !hasColumn(database, 'chunks', 'source_type')) {
    return {
      source_types_requiring_route: [...PERSONAL_SCOPE_REVIEW_SOURCE_TYPES],
      unexplained_import_chunks: 0,
      by_source_type: [],
      samples: [],
    };
  }
  const placeholders = PERSONAL_SCOPE_REVIEW_SOURCE_TYPES.map(() => '?').join(',');
  const params = [PERSONAL_TOPIC, ...PERSONAL_SCOPE_REVIEW_SOURCE_TYPES];
  const bySourceType = database.prepare(`
    SELECT source_type, COUNT(*) AS chunks
    FROM chunks
    WHERE topic = ?
      AND source_type IN (${placeholders})
    GROUP BY source_type
    ORDER BY chunks DESC, source_type
  `).all(...params);
  const total = bySourceType.reduce((sum, row) => sum + Number(row.chunks || 0), 0);
  const samples = total > 0
    ? database.prepare(`
      SELECT id, source_type, source_id, chunk_index, embedded,
             substr(replace(replace(content, char(10), ' '), char(13), ' '), 1, 220) AS sample
      FROM chunks
      WHERE topic = ?
        AND source_type IN (${placeholders})
      ORDER BY source_type, id
      LIMIT ?
    `).all(...params, limit)
    : [];
  return {
    source_types_requiring_route: [...PERSONAL_SCOPE_REVIEW_SOURCE_TYPES],
    unexplained_import_chunks: total,
    by_source_type: bySourceType,
    samples,
  };
}

function personalSourceMetadataReview(database, limit) {
  const rows = [];
  const samples = [];
  if (hasTable(database, 'drive_files') && hasColumn(database, 'drive_files', 'topic')) {
    const count = countRows(database, `
      SELECT COUNT(*) AS n
      FROM drive_files
      WHERE topic = ?
    `, PERSONAL_TOPIC);
    if (count > 0) {
      rows.push({ source: 'drive_files.topic', topic: PERSONAL_TOPIC, rows: count });
      const cols = new Set(database.prepare('PRAGMA table_info(drive_files)').all().map((row) => row.name));
      const select = [
        cols.has('id') ? 'id' : 'rowid AS id',
        cols.has('drive_file_id') ? 'drive_file_id' : 'NULL AS drive_file_id',
        cols.has('name') ? 'name' : 'NULL AS name',
        cols.has('mime_type') ? 'mime_type' : 'NULL AS mime_type',
        cols.has('modified_at') ? 'modified_at' : 'NULL AS modified_at',
      ].join(', ');
      samples.push(...database.prepare(`
        SELECT 'drive_files.topic' AS source, ${select}
        FROM drive_files
        WHERE topic = ?
        ORDER BY COALESCE(modified_at, ''), id
        LIMIT ?
      `).all(PERSONAL_TOPIC, limit));
    }
  }
  if (hasTable(database, 'transcripts') && hasColumn(database, 'transcripts', 'topic')) {
    const count = countRows(database, `
      SELECT COUNT(*) AS n
      FROM transcripts
      WHERE topic = ?
    `, PERSONAL_TOPIC);
    if (count > 0) {
      rows.push({ source: 'transcripts.topic', topic: PERSONAL_TOPIC, rows: count });
      const cols = new Set(database.prepare('PRAGMA table_info(transcripts)').all().map((row) => row.name));
      const select = [
        cols.has('id') ? 'id' : 'rowid AS id',
        cols.has('meeting_id') ? 'meeting_id' : 'NULL AS meeting_id',
        cols.has('title') ? 'title' : 'NULL AS title',
        cols.has('meeting_date') ? 'meeting_date' : 'NULL AS meeting_date',
        cols.has('source') ? 'source' : 'NULL AS source_type',
      ].join(', ');
      samples.push(...database.prepare(`
        SELECT 'transcripts.topic' AS source, ${select}
        FROM transcripts
        WHERE topic = ?
        ORDER BY COALESCE(meeting_date, ''), id
        LIMIT ?
      `).all(PERSONAL_TOPIC, limit));
    }
  }
  if (hasTable(database, 'conversations') && hasColumn(database, 'conversations', 'topic_slug')) {
    const nonUserWhere = hasColumn(database, 'conversations', 'topic_set_method')
      ? "AND COALESCE(topic_set_method, '') != 'user'"
      : '';
    const count = countRows(database, `
      SELECT COUNT(*) AS n
      FROM conversations
      WHERE topic_slug = ?
        ${nonUserWhere}
    `, PERSONAL_TOPIC);
    if (count > 0) {
      rows.push({ source: 'conversations.topic_slug', topic: PERSONAL_TOPIC, rows: count });
      const cols = new Set(database.prepare('PRAGMA table_info(conversations)').all().map((row) => row.name));
      const select = [
        cols.has('id') ? 'id' : 'rowid AS id',
        cols.has('title') ? 'title' : 'NULL AS title',
        cols.has('topic_set_method') ? 'topic_set_method' : 'NULL AS topic_set_method',
        cols.has('updated_at') ? 'updated_at' : 'NULL AS updated_at',
      ].join(', ');
      const orderBy = cols.has('updated_at') ? "ORDER BY COALESCE(updated_at, ''), id" : 'ORDER BY id';
      samples.push(...database.prepare(`
        SELECT 'conversations.topic_slug' AS source, ${select}
        FROM conversations
        WHERE topic_slug = ?
          ${nonUserWhere}
        ${orderBy}
        LIMIT ?
      `).all(PERSONAL_TOPIC, limit));
    }
  }
  if (hasTable(database, 'conversation_topics') && hasColumn(database, 'conversation_topics', 'topic_slug')) {
    const nonUserWhere = hasColumn(database, 'conversation_topics', 'set_method')
      ? "AND COALESCE(set_method, '') != 'user'"
      : '';
    const count = countRows(database, `
      SELECT COUNT(*) AS n
      FROM conversation_topics
      WHERE topic_slug = ?
        ${nonUserWhere}
    `, PERSONAL_TOPIC);
    if (count > 0) {
      rows.push({ source: 'conversation_topics.topic_slug', topic: PERSONAL_TOPIC, rows: count });
      const cols = new Set(database.prepare('PRAGMA table_info(conversation_topics)').all().map((row) => row.name));
      const select = [
        cols.has('conversation_id') ? 'conversation_id' : 'NULL AS conversation_id',
        cols.has('is_primary') ? 'is_primary' : 'NULL AS is_primary',
        cols.has('set_method') ? 'set_method' : 'NULL AS set_method',
      ].join(', ');
      samples.push(...database.prepare(`
        SELECT 'conversation_topics.topic_slug' AS source, ${select}
        FROM conversation_topics
        WHERE topic_slug = ?
          ${nonUserWhere}
        ORDER BY conversation_id, topic_slug
        LIMIT ?
      `).all(PERSONAL_TOPIC, limit));
    }
  }
  return {
    personal_rows: rows.reduce((sum, row) => sum + Number(row.rows || 0), 0),
    by_source: rows,
    samples,
  };
}

function fallbackChunkTopics(database) {
  if (!hasTable(database, 'chunks') || !FORBIDDEN_FALLBACK_TOPICS.length) return [];
  const placeholders = FORBIDDEN_FALLBACK_TOPICS.map(() => '?').join(',');
  return database.prepare(`
    SELECT topic, COUNT(*) AS chunks
    FROM chunks
    WHERE topic IN (${placeholders})
    GROUP BY topic
    ORDER BY chunks DESC, topic
  `).all(...FORBIDDEN_FALLBACK_TOPICS);
}

function memoryTopicCounts(database, topic) {
  if (!hasTable(database, 'memory_event_links')) {
    return {
      total: 0,
      current_unresolved: 0,
      needsRoutingRole: 0,
      scopeRole: 0,
      audit_links: 0,
    };
  }
  return {
    total: countRows(database, `
      SELECT COUNT(*) AS n
      FROM memory_event_links
      WHERE target_type = 'topic' AND target_id = ?
    `, topic),
    current_unresolved: countRows(database, `
      SELECT COUNT(*) AS n
      FROM memory_event_links
      WHERE target_type = 'topic' AND target_id = ? AND role IN ('needs-routing', 'scope')
    `, topic),
    needsRoutingRole: countRows(database, `
      SELECT COUNT(*) AS n
      FROM memory_event_links
      WHERE target_type = 'topic' AND target_id = ? AND role = 'needs-routing'
    `, topic),
    scopeRole: countRows(database, `
      SELECT COUNT(*) AS n
      FROM memory_event_links
      WHERE target_type = 'topic' AND target_id = ? AND role = 'scope'
    `, topic),
    audit_links: countRows(database, `
      SELECT COUNT(*) AS n
      FROM memory_event_links
      WHERE target_type = 'topic' AND target_id = ? AND role NOT IN ('needs-routing', 'scope')
    `, topic),
  };
}

function fallbackMemoryTargets(database) {
  if (!hasTable(database, 'memory_event_links') || !FORBIDDEN_FALLBACK_TOPICS.length) return [];
  const placeholders = FORBIDDEN_FALLBACK_TOPICS.map(() => '?').join(',');
  return database.prepare(`
    SELECT target_id, role, COUNT(*) AS links
    FROM memory_event_links
    WHERE target_type = 'topic'
      AND target_id IN (${placeholders})
      AND role IN ('needs-routing', 'scope')
    GROUP BY target_id, role
    ORDER BY links DESC, target_id, role
  `).all(...FORBIDDEN_FALLBACK_TOPICS);
}

function fallbackSourceTopics(database) {
  if (!FORBIDDEN_FALLBACK_TOPICS.length) return [];
  const rows = [];
  const placeholders = FORBIDDEN_FALLBACK_TOPICS.map(() => '?').join(',');
  if (hasTable(database, 'transcripts') && hasColumn(database, 'transcripts', 'topic')) {
    rows.push(...database.prepare(`
      SELECT 'transcripts.topic' AS source, topic, COUNT(*) AS rows
      FROM transcripts
      WHERE topic IN (${placeholders})
      GROUP BY topic
      ORDER BY rows DESC, topic
    `).all(...FORBIDDEN_FALLBACK_TOPICS));
  }
  if (hasTable(database, 'drive_files') && hasColumn(database, 'drive_files', 'topic')) {
    rows.push(...database.prepare(`
      SELECT 'drive_files.topic' AS source, topic, COUNT(*) AS rows
      FROM drive_files
      WHERE topic IN (${placeholders})
      GROUP BY topic
      ORDER BY rows DESC, topic
    `).all(...FORBIDDEN_FALLBACK_TOPICS));
  }
  if (hasTable(database, 'conversations') && hasColumn(database, 'conversations', 'topic_slug')) {
    const nonUserWhere = hasColumn(database, 'conversations', 'topic_set_method')
      ? "AND COALESCE(topic_set_method, '') != 'user'"
      : '';
    rows.push(...database.prepare(`
      SELECT 'conversations.topic_slug' AS source, topic_slug AS topic, COUNT(*) AS rows
      FROM conversations
      WHERE topic_slug IN (${placeholders})
        ${nonUserWhere}
      GROUP BY topic_slug
      ORDER BY rows DESC, topic_slug
    `).all(...FORBIDDEN_FALLBACK_TOPICS));
  }
  if (hasTable(database, 'conversation_topics') && hasColumn(database, 'conversation_topics', 'topic_slug')) {
    const nonUserWhere = hasColumn(database, 'conversation_topics', 'set_method')
      ? "AND COALESCE(set_method, '') != 'user'"
      : '';
    rows.push(...database.prepare(`
      SELECT 'conversation_topics.topic_slug' AS source, topic_slug AS topic, COUNT(*) AS rows
      FROM conversation_topics
      WHERE topic_slug IN (${placeholders})
        ${nonUserWhere}
      GROUP BY topic_slug
      ORDER BY rows DESC, topic_slug
    `).all(...FORBIDDEN_FALLBACK_TOPICS));
  }
  return rows;
}

function classifiableTopicCandidates(database) {
  if (!hasTable(database, 'user_topics')) return [];
  return database.prepare(`
    SELECT slug, label, description_embedding
    FROM user_topics
    WHERE parent_slug IS NOT NULL
      AND slug != ?
      AND description_embedding IS NOT NULL
  `).all(NEEDS_ROUTING_TOPIC)
    .map((row) => ({
      slug: row.slug,
      label: row.label,
      vec: deserializeEmbedding(row.description_embedding),
    }))
    .filter((row) => row.vec);
}

function needsRoutingResolutionReview(database, {
  required = false,
  limit = 1000,
  threshold = RECLASSIFY_THRESHOLD,
} = {}) {
  const base = {
    required,
    ok: true,
    complete: true,
    threshold,
    candidate_topics: 0,
    total_embedded_chunks: 0,
    scanned_chunks: 0,
    resolvable_chunks: 0,
    missing_vectors: 0,
    samples: [],
  };
  if (!required) return { ...base, skipped: true };
  if (!hasTable(database, 'chunks')) return base;

  const totalEmbedded = countRows(database, `
    SELECT COUNT(*) AS n
    FROM chunks
    WHERE topic = ?
      AND COALESCE(embedded, 0) = 1
  `, NEEDS_ROUTING_TOPIC);
  const rows = database.prepare(`
    SELECT id, source_type, source_id, chunk_index,
           substr(replace(replace(content, char(10), ' '), char(13), ' '), 1, 220) AS sample
    FROM chunks
    WHERE topic = ?
      AND COALESCE(embedded, 0) = 1
    ORDER BY id
    LIMIT ?
  `).all(NEEDS_ROUTING_TOPIC, limit);
  const candidates = classifiableTopicCandidates(database);
  const review = {
    ...base,
    total_embedded_chunks: totalEmbedded,
    scanned_chunks: rows.length,
    complete: totalEmbedded <= limit,
    candidate_topics: candidates.length,
  };
  if (totalEmbedded === 0) return review;
  if (candidates.length === 0) {
    return { ...review, ok: false, reason: 'no_classifiable_topic_embeddings' };
  }

  let embeddingsDb = null;
  try {
    embeddingsDb = openSplitVectorStore();
    for (const row of rows) {
      const vecRow = readVecRowForTopic(NEEDS_ROUTING_TOPIC, row.id, {
        database,
        embeddingsDb,
        requireReadable: true,
      });
      const vec = deserializeEmbedding(vecRow?.embedding);
      if (!vec) {
        review.missing_vectors += 1;
        continue;
      }
      let best = { slug: null, label: null, sim: -1 };
      for (const candidate of candidates) {
        const sim = cosine(vec, candidate.vec);
        if (sim > best.sim) best = { slug: candidate.slug, label: candidate.label, sim };
      }
      if (best.slug && best.sim >= threshold) {
        review.resolvable_chunks += 1;
        if (review.samples.length < 8) {
          review.samples.push({
            chunk_id: row.id,
            source_type: row.source_type,
            source_id: row.source_id,
            chunk_index: row.chunk_index,
            target_slug: best.slug,
            target_label: best.label,
            similarity: Number(best.sim.toFixed(4)),
            sample: row.sample,
          });
        }
      }
    }
  } catch (err) {
    return {
      ...review,
      ok: false,
      reason: 'needs_routing_resolution_review_error',
      error: String(err?.message || err).slice(0, 500),
    };
  } finally {
    try { embeddingsDb?.close?.(); } catch {}
  }

  if (!review.complete) review.ok = false;
  if (review.missing_vectors > 0) review.ok = false;
  if (review.resolvable_chunks > 0) review.ok = false;
  return review;
}

export function auditRoutingResidue(database, {
  sampleLimit = 8,
  breakdownLimit = 12,
  maxPersonalPending = null,
  maxPersonalUnexplainedImports = null,
  maxPersonalSourceMetadataRows = null,
  maxNeedsRoutingChunks = null,
  maxNeedsRoutingMemory = null,
  requireNeedsRoutingResolutionReview = false,
  needsRoutingReviewLimit = 1000,
} = {}) {
  const personal = {
    chunks: chunkCount(database, PERSONAL_TOPIC),
    pending_embeddings: pendingChunkCount(database, PERSONAL_TOPIC),
    source_breakdown: sourceBreakdown(database, PERSONAL_TOPIC, breakdownLimit),
    samples: chunkSamples(database, PERSONAL_TOPIC, sampleLimit),
  };
  personal.scope_review = personalScopeReview(database, sampleLimit);
  personal.source_metadata_review = personalSourceMetadataReview(database, sampleLimit);
  const needsRouting = {
    chunks: chunkCount(database, NEEDS_ROUTING_TOPIC),
    pending_embeddings: pendingChunkCount(database, NEEDS_ROUTING_TOPIC),
    memory_links: memoryTopicCounts(database, NEEDS_ROUTING_TOPIC),
    source_breakdown: sourceBreakdown(database, NEEDS_ROUTING_TOPIC, breakdownLimit),
    samples: chunkSamples(database, NEEDS_ROUTING_TOPIC, sampleLimit),
  };
  needsRouting.resolution_review = needsRoutingResolutionReview(database, {
    required: requireNeedsRoutingResolutionReview,
    limit: needsRoutingReviewLimit,
  });
  const fallbackResidue = {
    chunk_topics: fallbackChunkTopics(database),
    memory_targets: fallbackMemoryTargets(database),
    source_topics: fallbackSourceTopics(database),
  };
  const failures = [];
  if (fallbackResidue.chunk_topics.length) failures.push('forbidden fallback chunk topics remain');
  if (fallbackResidue.memory_targets.length) failures.push('forbidden fallback memory topic links remain');
  if (fallbackResidue.source_topics.length) failures.push('forbidden fallback source topics remain');
  if (maxPersonalPending !== null && personal.pending_embeddings > maxPersonalPending) {
    failures.push(`personal pending embeddings ${personal.pending_embeddings} > ${maxPersonalPending}`);
  }
  if (maxPersonalUnexplainedImports !== null && personal.scope_review.unexplained_import_chunks > maxPersonalUnexplainedImports) {
    failures.push(`personal unexplained import/container chunks ${personal.scope_review.unexplained_import_chunks} > ${maxPersonalUnexplainedImports}`);
  }
  if (maxPersonalSourceMetadataRows !== null && personal.source_metadata_review.personal_rows > maxPersonalSourceMetadataRows) {
    failures.push(`personal source metadata rows ${personal.source_metadata_review.personal_rows} > ${maxPersonalSourceMetadataRows}`);
  }
  if (maxNeedsRoutingChunks !== null && needsRouting.chunks > maxNeedsRoutingChunks) {
    failures.push(`needs-routing chunks ${needsRouting.chunks} > ${maxNeedsRoutingChunks}`);
  }
  if (maxNeedsRoutingMemory !== null && needsRouting.memory_links.current_unresolved > maxNeedsRoutingMemory) {
    failures.push(`needs-routing current memory links ${needsRouting.memory_links.current_unresolved} > ${maxNeedsRoutingMemory}`);
  }
  if (requireNeedsRoutingResolutionReview) {
    if (needsRouting.resolution_review.ok !== true) {
      failures.push(`needs-routing resolution review failed: ${needsRouting.resolution_review.reason || 'resolvable_or_unreviewed_chunks'}`);
    }
    if (needsRouting.resolution_review.complete !== true) {
      failures.push('needs-routing resolution review did not scan every embedded chunk');
    }
    if (needsRouting.resolution_review.missing_vectors > 0) {
      failures.push(`needs-routing resolution review missing vectors ${needsRouting.resolution_review.missing_vectors}`);
    }
    if (needsRouting.resolution_review.resolvable_chunks > 0) {
      failures.push(`needs-routing contains ${needsRouting.resolution_review.resolvable_chunks} strongly classifiable chunk(s)`);
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    personal,
    needs_routing: needsRouting,
    fallback_residue: fallbackResidue,
  };
}

function parseArgs(argv) {
  const out = { json: false, strict: false };
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

function numberOrNull(value) {
  if (value === undefined || value === null || value === false) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function atomicWriteJson(path, payload) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
}

function printText(result) {
  console.log(`[routing-residue] ok=${result.ok}`);
  if (result.failures.length) console.log(`[routing-residue] failures=${result.failures.join('; ')}`);
  console.log(`[routing-residue] personal chunks=${result.personal.chunks} pending_embeddings=${result.personal.pending_embeddings}`);
  console.log(`[routing-residue] personal unexplained_import_chunks=${result.personal.scope_review.unexplained_import_chunks}`);
  console.log(`[routing-residue] personal source_metadata_rows=${result.personal.source_metadata_review.personal_rows}`);
  console.log(`[routing-residue] needs-routing chunks=${result.needs_routing.chunks} pending_embeddings=${result.needs_routing.pending_embeddings} current_memory_links=${result.needs_routing.memory_links.current_unresolved} audit_links=${result.needs_routing.memory_links.audit_links} total_memory_links=${result.needs_routing.memory_links.total}`);
  if (result.needs_routing.resolution_review.required) {
    const review = result.needs_routing.resolution_review;
    console.log(`[routing-residue] needs-routing resolution_review ok=${review.ok} complete=${review.complete} scanned=${review.scanned_chunks}/${review.total_embedded_chunks} resolvable=${review.resolvable_chunks} missing_vectors=${review.missing_vectors}`);
  }
  if (result.fallback_residue.chunk_topics.length) {
    console.log('[routing-residue] forbidden chunk topics:');
    for (const row of result.fallback_residue.chunk_topics) console.log(`  ${row.topic}: ${row.chunks}`);
  }
  if (result.fallback_residue.memory_targets.length) {
    console.log('[routing-residue] forbidden memory targets:');
    for (const row of result.fallback_residue.memory_targets) console.log(`  ${row.target_id} (${row.role}): ${row.links}`);
  }
  if (result.fallback_residue.source_topics.length) {
    console.log('[routing-residue] forbidden source topics:');
    for (const row of result.fallback_residue.source_topics) console.log(`  ${row.source} ${row.topic}: ${row.rows}`);
  }
  console.log('[routing-residue] personal source breakdown:');
  for (const row of result.personal.source_breakdown) console.log(`  ${row.source_type}: ${row.chunks}`);
  if (result.personal.scope_review.by_source_type.length) {
    console.log('[routing-residue] personal source types requiring explicit route:');
    for (const row of result.personal.scope_review.by_source_type) console.log(`  ${row.source_type}: ${row.chunks}`);
  }
  if (result.personal.source_metadata_review.by_source.length) {
    console.log('[routing-residue] personal source metadata rows:');
    for (const row of result.personal.source_metadata_review.by_source) console.log(`  ${row.source} ${row.topic}: ${row.rows}`);
  }
  console.log('[routing-residue] needs-routing source breakdown:');
  for (const row of result.needs_routing.source_breakdown) console.log(`  ${row.source_type}: ${row.chunks}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const thresholds = {
    maxPersonalPending: numberOrNull(args.maxPersonalPending),
    maxPersonalUnexplainedImports: numberOrNull(args.maxPersonalUnexplainedImports),
    maxPersonalSourceMetadataRows: numberOrNull(args.maxPersonalSourceMetadataRows),
    maxNeedsRoutingChunks: numberOrNull(args.maxNeedsRoutingChunks),
    maxNeedsRoutingMemory: numberOrNull(args.maxNeedsRoutingMemory),
  };
  const needsRoutingReviewLimit = Number(args.needsRoutingReviewLimit || args.maxNeedsRoutingChunks || 1000);
  const result = {
    ...auditRoutingResidue(db, {
      sampleLimit: Number(args.sampleLimit || 8),
      breakdownLimit: Number(args.breakdownLimit || 12),
      requireNeedsRoutingResolutionReview: args.requireNeedsRoutingResolutionReview === true,
      needsRoutingReviewLimit: Number.isFinite(needsRoutingReviewLimit) && needsRoutingReviewLimit > 0
        ? Math.floor(needsRoutingReviewLimit)
        : 1000,
      ...thresholds,
    }),
    checked_at: new Date().toISOString(),
    strict: args.strict === true,
    thresholds,
  };
  const resultFile = args.resultFile || process.env.ROBOTDOJO_ROUTING_RESIDUE_AUDIT_RESULT_FILE || null;
  atomicWriteJson(resultFile, result);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printText(result);
  if (args.strict && !result.ok) process.exit(1);
}
