#!/usr/bin/env node
/**
 * Repair source metadata topic fields after chunk reclassification.
 *
 * Chunks are the retrieval truth. Source metadata tables feed timeline and UI.
 * After broad-source chunks move out of Personal, source metadata must follow
 * the dominant reclassified chunk topic instead of preserving the legacy
 * Personal catch-all.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import db from '../lib/db.js';
import {
  NEEDS_ROUTING_T2,
  NEEDS_ROUTING_TOPIC,
  PERSONAL_SCOPE_REVIEW_SOURCE_TYPES,
  PERSONAL_TOPIC,
  UNCATEGORIZED_T1,
  UNKNOWN_TOPIC_ALIASES,
} from '../lib/topic-routing-policy.js';

const ROUTING_QUEUE_TOPICS = new Set([
  PERSONAL_TOPIC,
  NEEDS_ROUTING_TOPIC,
  ...UNKNOWN_TOPIC_ALIASES,
]);

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

function safeJson(value) {
  try {
    if (!value) return {};
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function contentHash(content) {
  return createHash('sha256').update(String(content || '')).digest('hex');
}

function topicKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isRoutingQueueTopic(value) {
  return ROUTING_QUEUE_TOPICS.has(topicKey(value));
}

function bestChunkTopic(database, sourceType, sourceId, currentTopic) {
  if (!hasTable(database, 'chunks')) {
    return isRoutingQueueTopic(currentTopic) ? NEEDS_ROUTING_TOPIC : currentTopic;
  }
  const rows = database.prepare(`
    SELECT topic, COUNT(*) AS chunks
    FROM chunks
    WHERE source_type = ?
      AND source_id = ?
      AND COALESCE(topic, '') != ''
    GROUP BY topic
    ORDER BY
      CASE
        WHEN topic NOT IN (?, ?, ?) THEN 0
        WHEN topic = ? THEN 1
        ELSE 2
      END ASC,
      chunks DESC,
      topic ASC
  `).all(sourceType, sourceId, PERSONAL_TOPIC, NEEDS_ROUTING_TOPIC, NEEDS_ROUTING_T2, NEEDS_ROUTING_TOPIC);
  const best = rows[0]?.topic || currentTopic;
  if (!best || isRoutingQueueTopic(best)) return NEEDS_ROUTING_TOPIC;
  return best;
}

function shouldUpdateMetadataTopic(currentTopic, targetTopic) {
  return !!targetTopic
    && targetTopic !== currentTopic
    && (isRoutingQueueTopic(currentTopic) || !isRoutingQueueTopic(targetTopic));
}

function conversationRepairWhere(database) {
  const conditions = [];
  if (hasColumn(database, 'conversations', 'topic_set_method')) {
    conditions.push("COALESCE(topic_set_method, '') != 'user'");
  }
  if (hasTable(database, 'conversation_topics') && hasColumn(database, 'conversation_topics', 'set_method')) {
    conditions.push(`
      NOT EXISTS (
        SELECT 1
        FROM conversation_topics ct
        WHERE ct.conversation_id = conversations.id
          AND ct.set_method = 'user'
      )
    `);
  }
  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
}

// st_1169bfc7 — the transcript pin guard, mirroring conversationRepairWhere.
// A Granola call whose topic was set from its folder carries
// topic_set_method='folder' and must survive the reclassification repair
// untouched (AC4). Excluding those rows from every repair SELECT keeps them out
// of transcriptUpdates AND out of the resolvable-queue / completeness counts, so
// a folder-pinned personal row neither gets overwritten nor false-fails the
// gate. hasColumn guard: an old DB without the column returns '' → prior
// behavior, no guard.
function transcriptRepairWhere(database) {
  if (hasColumn(database, 'transcripts', 'topic_set_method')) {
    return "WHERE COALESCE(topic_set_method, '') != 'folder'";
  }
  return '';
}

function updateDriveTimeline(database, row, targetTopic) {
  if (!hasTable(database, 'timeline_events')) return 0;
  const existing = database.prepare(`
    SELECT id, metadata
    FROM timeline_events
    WHERE source_type = 'drive' AND source_id = ?
  `).get(row.drive_file_id);
  if (!existing) return 0;
  const metadata = {
    ...safeJson(existing.metadata),
    topic: targetTopic,
    mime_type: row.mime_type || null,
    account_id: row.account_id || null,
  };
  const content = `${row.name || ''}\n${targetTopic || ''}`;
  return database.prepare(`
    UPDATE timeline_events
    SET content_hash = ?, metadata = ?
    WHERE id = ?
  `).run(contentHash(content), JSON.stringify(metadata), existing.id).changes;
}

function driveMetadataCounts(database) {
  return {
    personal: countRows(database, "SELECT COUNT(*) AS n FROM drive_files WHERE topic = ?", PERSONAL_TOPIC),
    needs_routing: countRows(database, "SELECT COUNT(*) AS n FROM drive_files WHERE topic = ?", NEEDS_ROUTING_TOPIC),
  };
}

function transcriptMetadataCounts(database) {
  // st_1169bfc7 — personal_non_folder excludes folder-pinned rows, mirroring
  // conversationMetadataCounts.personal_non_user. The success gate reads this so
  // AC1/AC6 folder-pinned personal rows don't count as unrouted.
  const repairAnd = transcriptRepairWhere(database).replace(/^\s*WHERE\s+/, 'AND ');
  return {
    personal: countRows(database, "SELECT COUNT(*) AS n FROM transcripts WHERE topic = ?", PERSONAL_TOPIC),
    personal_non_folder: countRows(database, `
      SELECT COUNT(*) AS n
      FROM transcripts
      WHERE topic = ?
        ${repairAnd}
    `, PERSONAL_TOPIC),
    needs_routing: countRows(database, "SELECT COUNT(*) AS n FROM transcripts WHERE topic = ?", NEEDS_ROUTING_TOPIC),
  };
}

function conversationMetadataCounts(database) {
  const repairAnd = conversationRepairWhere(database).replace(/^\s*WHERE\s+/, 'AND ');
  return {
    personal: countRows(database, "SELECT COUNT(*) AS n FROM conversations WHERE topic_slug = ?", PERSONAL_TOPIC),
    personal_non_user: countRows(database, `
      SELECT COUNT(*) AS n
      FROM conversations
      WHERE topic_slug = ?
        ${repairAnd}
    `, PERSONAL_TOPIC),
    needs_routing: countRows(database, "SELECT COUNT(*) AS n FROM conversations WHERE topic_slug = ?", NEEDS_ROUTING_TOPIC),
    null_topic: countRows(database, "SELECT COUNT(*) AS n FROM conversations WHERE topic_slug IS NULL"),
    null_topic_non_user: countRows(database, `
      SELECT COUNT(*) AS n
      FROM conversations
      WHERE topic_slug IS NULL
        ${repairAnd}
    `),
  };
}

function chunkTopicResidueCounts(database) {
  if (!hasTable(database, 'chunks') || !hasColumn(database, 'chunks', 'topic')) {
    return {
      needs_routing_alias: 0,
      personal_import_container: 0,
    };
  }
  const placeholders = PERSONAL_SCOPE_REVIEW_SOURCE_TYPES.map(() => '?').join(',');
  return {
    needs_routing_alias: countRows(database, 'SELECT COUNT(*) AS n FROM chunks WHERE topic = ?', NEEDS_ROUTING_T2),
    personal_import_container: placeholders
      ? countRows(database, `
        SELECT COUNT(*) AS n
        FROM chunks
        WHERE topic = ?
          AND source_type IN (${placeholders})
      `, PERSONAL_TOPIC, ...PERSONAL_SCOPE_REVIEW_SOURCE_TYPES)
      : 0,
  };
}

function repairChunkTopicResidue(database, { apply = false } = {}) {
  const before = chunkTopicResidueCounts(database);
  const updated = {
    needs_routing_alias: 0,
    personal_import_container: 0,
  };
  if (!hasTable(database, 'chunks') || !hasColumn(database, 'chunks', 'topic')) {
    return {
      before,
      after: before,
      updated,
    };
  }
  const placeholders = PERSONAL_SCOPE_REVIEW_SOURCE_TYPES.map(() => '?').join(',');
  if (apply) {
    const tx = database.transaction(() => {
      updated.needs_routing_alias += database.prepare(`
        UPDATE chunks
           SET topic = ?
         WHERE topic = ?
      `).run(UNCATEGORIZED_T1, NEEDS_ROUTING_T2).changes;
      if (placeholders) {
        updated.personal_import_container += database.prepare(`
          UPDATE chunks
             SET topic = ?
           WHERE topic = ?
             AND source_type IN (${placeholders})
        `).run(UNCATEGORIZED_T1, PERSONAL_TOPIC, ...PERSONAL_SCOPE_REVIEW_SOURCE_TYPES).changes;
      }
    });
    tx();
  } else {
    updated.needs_routing_alias = before.needs_routing_alias;
    updated.personal_import_container = before.personal_import_container;
  }
  return {
    before,
    after: chunkTopicResidueCounts(database),
    updated,
  };
}

function resolvableQueueMetadata(database, { sampleLimit = 20 } = {}) {
  const rows = [];
  if (hasTable(database, 'drive_files') && hasColumn(database, 'drive_files', 'topic')) {
    const driveRows = database.prepare(`
      SELECT id, drive_file_id, name, topic
      FROM drive_files
      ORDER BY id
    `).all();
    for (const row of driveRows) {
      const targetTopic = bestChunkTopic(database, 'drive', row.drive_file_id, row.topic);
      if (isRoutingQueueTopic(row.topic) && !isRoutingQueueTopic(targetTopic)) {
        rows.push({
          source_table: 'drive_files',
          id: row.id,
          source_id: row.drive_file_id,
          name: row.name,
          from: row.topic,
          to: targetTopic,
        });
      }
    }
  }
  if (hasTable(database, 'transcripts') && hasColumn(database, 'transcripts', 'topic')) {
    const transcriptRows = database.prepare(`
      SELECT id, meeting_id, title, topic
      FROM transcripts
      ${transcriptRepairWhere(database)}
      ORDER BY id
    `).all();
    for (const row of transcriptRows) {
      const targetTopic = bestChunkTopic(database, 'transcript', `transcript:${row.id}`, row.topic);
      if (isRoutingQueueTopic(row.topic) && !isRoutingQueueTopic(targetTopic)) {
        rows.push({
          source_table: 'transcripts',
          id: row.id,
          source_id: row.meeting_id || row.id,
          name: row.title,
          from: row.topic,
          to: targetTopic,
        });
      }
    }
  }
  if (hasTable(database, 'conversations') && hasColumn(database, 'conversations', 'topic_slug')) {
    const where = conversationRepairWhere(database);
    const conversationRows = database.prepare(`
      SELECT id, title, topic_slug AS topic
      FROM conversations
      ${where}
      ORDER BY id
    `).all();
    for (const row of conversationRows) {
      const llmTarget = bestChunkTopic(database, 'llm_export', row.id, row.topic);
      const conversationTarget = bestChunkTopic(database, 'conversation', row.id, row.topic);
      const targetTopic = !isRoutingQueueTopic(llmTarget) ? llmTarget : conversationTarget;
      if (isRoutingQueueTopic(row.topic) && !isRoutingQueueTopic(targetTopic)) {
        rows.push({
          source_table: 'conversations',
          id: row.id,
          source_id: row.id,
          name: row.title,
          from: row.topic,
          to: targetTopic,
        });
      }
    }
  }
  const bySource = new Map();
  for (const row of rows) bySource.set(row.source_table, (bySource.get(row.source_table) || 0) + 1);
  return {
    rows: rows.length,
    by_source: [...bySource.entries()].map(([source, count]) => ({ source, rows: count })),
    samples: rows.slice(0, sampleLimit),
  };
}

function updateTranscriptTimeline(database, row, targetTopic) {
  if (!hasTable(database, 'timeline_events')) return 0;
  const existing = database.prepare(`
    SELECT id, metadata
    FROM timeline_events
    WHERE source_type = 'granola' AND source_id = ?
  `).get(row.id);
  if (!existing) return 0;
  const metadata = {
    ...safeJson(existing.metadata),
    topic: targetTopic,
    meeting_id: row.meeting_id || safeJson(existing.metadata).meeting_id || null,
    source: row.source || 'granola',
  };
  return database.prepare(`
    UPDATE timeline_events
    SET metadata = ?
    WHERE id = ?
  `).run(JSON.stringify(metadata), existing.id).changes;
}

function updateConversationTimeline(database, row, targetTopic) {
  if (!hasTable(database, 'timeline_events')) return 0;
  const existing = database.prepare(`
    SELECT id, metadata
    FROM timeline_events
    WHERE source_type = 'conversation' AND source_id = ?
  `).get(row.id);
  if (!existing) return 0;
  const metadata = {
    ...safeJson(existing.metadata),
    topic_slug: targetTopic,
    model: row.model || safeJson(existing.metadata).model || null,
    chat_type: row.chat_type || safeJson(existing.metadata).chat_type || 'chat',
  };
  const content = `${row.title || ''}\n${targetTopic || ''}`;
  return database.prepare(`
    UPDATE timeline_events
    SET content_hash = ?, metadata = ?
    WHERE id = ?
  `).run(contentHash(content), JSON.stringify(metadata), existing.id).changes;
}

function syncConversationTopicJunction(database, row, targetTopic) {
  if (!hasTable(database, 'conversation_topics')) return;
  const hasSetMethod = hasColumn(database, 'conversation_topics', 'set_method');
  const hasPrimary = hasColumn(database, 'conversation_topics', 'is_primary');
  if (hasSetMethod) {
    database.prepare(`
      DELETE FROM conversation_topics
      WHERE conversation_id = ?
        AND COALESCE(set_method, '') != 'user'
    `).run(row.id);
  } else {
    database.prepare('DELETE FROM conversation_topics WHERE conversation_id = ?').run(row.id);
  }
  if (hasPrimary && hasSetMethod) {
    database.prepare(`
      INSERT OR REPLACE INTO conversation_topics (conversation_id, topic_slug, is_primary, set_method)
      VALUES (?, ?, 1, 'source-metadata-repair')
    `).run(row.id, targetTopic);
  } else if (hasPrimary) {
    database.prepare(`
      INSERT OR REPLACE INTO conversation_topics (conversation_id, topic_slug, is_primary)
      VALUES (?, ?, 1)
    `).run(row.id, targetTopic);
  } else if (hasSetMethod) {
    database.prepare(`
      INSERT OR REPLACE INTO conversation_topics (conversation_id, topic_slug, set_method)
      VALUES (?, ?, 'source-metadata-repair')
    `).run(row.id, targetTopic);
  } else {
    database.prepare(`
      INSERT OR REPLACE INTO conversation_topics (conversation_id, topic_slug)
      VALUES (?, ?)
    `).run(row.id, targetTopic);
  }
}

export function repairSourceTopicMetadata(database, { apply = false, sampleLimit = 20 } = {}) {
  const result = {
    ok: true,
    mode: apply ? 'apply' : 'dry-run',
    before: {},
    after: {},
    updated: {
      drive_files: 0,
      transcripts: 0,
      conversations: 0,
      timeline_events: 0,
      chunk_topics: {
        needs_routing_alias: 0,
        personal_import_container: 0,
      },
    },
    samples: [],
    skipped: [],
  };

  const canRepairDrive = hasTable(database, 'drive_files') && hasColumn(database, 'drive_files', 'topic');
  const canRepairTranscripts = hasTable(database, 'transcripts') && hasColumn(database, 'transcripts', 'topic');
  const canRepairConversations = hasTable(database, 'conversations') && hasColumn(database, 'conversations', 'topic_slug');

  if (!canRepairDrive) {
    result.skipped.push('drive_files.topic missing');
  }
  if (!canRepairTranscripts) {
    result.skipped.push('transcripts.topic missing');
  }
  if (!canRepairConversations) {
    result.skipped.push('conversations.topic_slug missing');
  }

  if (!canRepairDrive && !canRepairTranscripts && !canRepairConversations) return result;

  if (canRepairDrive) result.before.drive_files = driveMetadataCounts(database);
  if (canRepairTranscripts) result.before.transcripts = transcriptMetadataCounts(database);
  if (canRepairConversations) result.before.conversations = conversationMetadataCounts(database);
  result.before.chunk_topics = chunkTopicResidueCounts(database);
  result.before.resolvable_queue_metadata = resolvableQueueMetadata(database, { sampleLimit });

  const driveRows = canRepairDrive ? database.prepare(`
    SELECT id, drive_file_id, account_id, name, mime_type, modified_at, topic
    FROM drive_files
    ORDER BY COALESCE(modified_at, ''), id
  `).all() : [];

  const driveUpdates = driveRows.map((row) => ({
    ...row,
    source_table: 'drive_files',
    target_topic: bestChunkTopic(database, 'drive', row.drive_file_id, row.topic),
  })).filter((row) => shouldUpdateMetadataTopic(row.topic, row.target_topic));

  const transcriptRows = canRepairTranscripts ? database.prepare(`
    SELECT id, meeting_id, title, meeting_date, topic, source
    FROM transcripts
    ${transcriptRepairWhere(database)}
    ORDER BY COALESCE(meeting_date, ''), id
  `).all() : [];

  const transcriptUpdates = transcriptRows.map((row) => ({
    ...row,
    source_table: 'transcripts',
    target_topic: bestChunkTopic(database, 'transcript', `transcript:${row.id}`, row.topic),
  })).filter((row) => shouldUpdateMetadataTopic(row.topic, row.target_topic));

  const conversationRows = canRepairConversations ? database.prepare(`
    SELECT id,
           ${hasColumn(database, 'conversations', 'title') ? 'title' : 'NULL AS title'},
           ${hasColumn(database, 'conversations', 'model') ? 'model' : 'NULL AS model'},
           ${hasColumn(database, 'conversations', 'chat_type') ? 'chat_type' : 'NULL AS chat_type'},
           topic_slug AS topic
    FROM conversations
    ${conversationRepairWhere(database)}
    ${hasColumn(database, 'conversations', 'updated_at') ? "ORDER BY COALESCE(updated_at, ''), id" : 'ORDER BY id'}
  `).all() : [];

  const conversationUpdates = conversationRows.map((row) => {
    const llmTarget = bestChunkTopic(database, 'llm_export', row.id, row.topic);
    const conversationTarget = bestChunkTopic(database, 'conversation', row.id, row.topic);
    return {
      ...row,
      source_table: 'conversations',
      target_topic: !isRoutingQueueTopic(llmTarget) ? llmTarget : conversationTarget,
    };
  }).filter((row) => shouldUpdateMetadataTopic(row.topic, row.target_topic));

  if (apply && (driveUpdates.length > 0 || transcriptUpdates.length > 0 || conversationUpdates.length > 0)) {
    const updateDriveFile = database.prepare('UPDATE drive_files SET topic = ? WHERE id = ?');
    const updateTranscript = database.prepare('UPDATE transcripts SET topic = ? WHERE id = ?');
    const conversationAssignments = ['topic_slug = ?'];
    if (hasColumn(database, 'conversations', 'topic_set_method')) {
      conversationAssignments.push("topic_set_method = 'source-metadata-repair'");
    }
    if (hasColumn(database, 'conversations', 'updated_at')) {
      conversationAssignments.push("updated_at = datetime('now')");
    }
    const updateConversation = database.prepare(`
      UPDATE conversations
      SET ${conversationAssignments.join(', ')}
      WHERE id = ?
    `);
    const tx = database.transaction(() => {
      for (const row of driveUpdates) {
        result.updated.drive_files += updateDriveFile.run(row.target_topic, row.id).changes;
        result.updated.timeline_events += updateDriveTimeline(database, row, row.target_topic);
      }
      for (const row of transcriptUpdates) {
        result.updated.transcripts += updateTranscript.run(row.target_topic, row.id).changes;
        result.updated.timeline_events += updateTranscriptTimeline(database, row, row.target_topic);
      }
      for (const row of conversationUpdates) {
        result.updated.conversations += updateConversation.run(row.target_topic, row.id).changes;
        syncConversationTopicJunction(database, row, row.target_topic);
        result.updated.timeline_events += updateConversationTimeline(database, row, row.target_topic);
      }
    });
    tx();
  } else {
    result.updated.drive_files = driveUpdates.length;
    result.updated.transcripts = transcriptUpdates.length;
    result.updated.conversations = conversationUpdates.length;
  }

  const chunkTopicRepair = repairChunkTopicResidue(database, { apply });
  result.updated.chunk_topics = chunkTopicRepair.updated;

  result.samples = [...driveUpdates, ...transcriptUpdates, ...conversationUpdates].slice(0, sampleLimit).map((row) => ({
    source_table: row.source_table,
    id: row.id,
    source_id: row.drive_file_id || row.meeting_id || row.id,
    name: row.name || row.title || null,
    from: row.topic,
    to: row.target_topic,
  }));
  if (canRepairDrive) result.after.drive_files = driveMetadataCounts(database);
  if (canRepairTranscripts) result.after.transcripts = transcriptMetadataCounts(database);
  if (canRepairConversations) result.after.conversations = conversationMetadataCounts(database);
  result.after.chunk_topics = chunkTopicRepair.after;
  result.after.resolvable_queue_metadata = resolvableQueueMetadata(database, { sampleLimit });
  if (apply && Number(result.after.drive_files?.personal || 0) !== 0) {
    result.ok = false;
    result.failures = [`drive_files.topic personal rows remain: ${result.after.drive_files.personal}`];
  }
  // st_1169bfc7 — gate on personal_non_folder (folder-pinned personal rows are
  // authoritative, not unrouted), mirroring the conversations personal_non_user
  // gate below. Falls back to the raw personal count on a pre-migration DB.
  const remainingTranscriptPersonal = Number(
    result.after.transcripts?.personal_non_folder ?? result.after.transcripts?.personal ?? 0,
  );
  if (apply && remainingTranscriptPersonal !== 0) {
    result.ok = false;
    result.failures = [
      ...(result.failures || []),
      `transcripts.topic personal rows remain: ${remainingTranscriptPersonal}`,
    ];
  }
  const remainingConversationPersonal = Number(
    result.after.conversations?.personal_non_user ?? result.after.conversations?.personal ?? 0,
  );
  if (apply && remainingConversationPersonal !== 0) {
    result.ok = false;
    result.failures = [
      ...(result.failures || []),
      `conversations.topic_slug personal rows remain: ${remainingConversationPersonal}`,
    ];
  }
  const remainingConversationNull = Number(result.after.conversations?.null_topic_non_user || 0);
  if (apply && remainingConversationNull !== 0) {
    result.ok = false;
    result.failures = [
      ...(result.failures || []),
      `conversations.topic_slug null rows remain: ${remainingConversationNull}`,
    ];
  }
  if (apply && Number(result.after.resolvable_queue_metadata?.rows || 0) !== 0) {
    result.ok = false;
    result.failures = [
      ...(result.failures || []),
      `resolvable queue source metadata rows remain: ${result.after.resolvable_queue_metadata.rows}`,
    ];
  }
  if (apply && Number(result.after.chunk_topics?.needs_routing_alias || 0) !== 0) {
    result.ok = false;
    result.failures = [
      ...(result.failures || []),
      `needs-routing chunk aliases remain: ${result.after.chunk_topics.needs_routing_alias}`,
    ];
  }
  if (apply && Number(result.after.chunk_topics?.personal_import_container || 0) !== 0) {
    result.ok = false;
    result.failures = [
      ...(result.failures || []),
      `Personal import/container chunk rows remain: ${result.after.chunk_topics.personal_import_container}`,
    ];
  }
  return result;
}

function parseArgs(argv) {
  const out = { apply: false, json: false };
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

function atomicWriteJson(path, payload) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const result = {
    ...repairSourceTopicMetadata(db, {
      apply: args.apply === true,
      sampleLimit: Number(args.sampleLimit || 20),
    }),
    checked_at: new Date().toISOString(),
  };
  const resultFile = args.resultFile || process.env.ROBOTDOJO_SOURCE_TOPIC_METADATA_REPAIR_RESULT_FILE || null;
  atomicWriteJson(resultFile, result);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[source-topic-metadata] ok=${result.ok} mode=${result.mode}`);
    console.log(`[source-topic-metadata] drive_files personal ${result.before.drive_files?.personal ?? 0} -> ${result.after.drive_files?.personal ?? 0}`);
    console.log(`[source-topic-metadata] transcripts personal ${result.before.transcripts?.personal ?? 0} -> ${result.after.transcripts?.personal ?? 0}`);
    console.log(`[source-topic-metadata] conversations personal ${result.before.conversations?.personal ?? 0} -> ${result.after.conversations?.personal ?? 0}`);
    console.log(`[source-topic-metadata] chunks needs-routing ${result.before.chunk_topics?.needs_routing_alias ?? 0} -> ${result.after.chunk_topics?.needs_routing_alias ?? 0}`);
    console.log(`[source-topic-metadata] chunks Personal import/container ${result.before.chunk_topics?.personal_import_container ?? 0} -> ${result.after.chunk_topics?.personal_import_container ?? 0}`);
    console.log(`[source-topic-metadata] updated drive_files=${result.updated.drive_files} transcripts=${result.updated.transcripts} conversations=${result.updated.conversations} timeline_events=${result.updated.timeline_events}`);
  }
  if (!result.ok) process.exit(1);
}
