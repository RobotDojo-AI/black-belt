#!/usr/bin/env node
/**
 * Repair legacy memory/topic routing after the fallback policy changed.
 *
 * Safe-by-default:
 *   - dry-run unless --apply is passed
 *   - does not rewrite immutable memory_events
 *   - does not move chunks or vector rows; the embedding/reclassify pipeline owns that
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import db from '../lib/db.js';
import { appendMemoryEvent } from '../lib/memory-events.js';
import {
  NEEDS_ROUTING_TOPIC,
  NEEDS_ROUTING_T2,
  UNCATEGORIZED_T1,
} from '../lib/topic-routing-policy.js';

const APPLY = process.argv.includes('--apply');
const RESULT_FILE = argValue('--result-file') || process.env.ROBOTDOJO_MEMORY_ROUTING_REPAIR_RESULT_FILE || null;

const LEGACY_UNKNOWN_TOPIC_IDS = [
  'personal/learning',
  'uncategorized/needs-routing',
  NEEDS_ROUTING_T2,
  'general',
  'other',
  'misc',
  'miscellaneous',
  'unknown',
  'unclassified',
];

const AMBIGUOUS_DOC_TYPES = [
  'archive',
  'contacts_csv',
  'csv',
  'document',
  'email_archive',
  'email_mbox',
  'google_takeout',
  'linkedin_export',
  'llm_export',
  'other',
];

const AMBIGUOUS_PERSONAL_T2 = [
  'learning',
  'general',
  'other',
  'misc',
  'unknown',
  'unclassified',
  'needs-routing',
  'personal/learning',
];

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnExists(table, column) {
  if (!tableExists(table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function count(sql, params = []) {
  return db.prepare(sql).get(params)?.n || 0;
}

function argValue(name) {
  const prefix = `${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function atomicWriteJson(path, payload) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

function countDropFolderLegacy() {
  if (!tableExists('drop_folder_files')) return 0;
  return count(`
    SELECT COUNT(*) AS n
      FROM drop_folder_files
     WHERE (
        (topic_t1 = 'personal' AND topic_t2 IN (${placeholders(AMBIGUOUS_PERSONAL_T2)}))
        OR (topic_t1 = ? AND topic_t2 = ?)
      )
       AND doc_type IN (${placeholders(AMBIGUOUS_DOC_TYPES)})
  `, [...AMBIGUOUS_PERSONAL_T2, UNCATEGORIZED_T1, NEEDS_ROUTING_T2, ...AMBIGUOUS_DOC_TYPES]);
}

function countMemoryAliasLinks() {
  if (!tableExists('memory_event_links')) return 0;
  return count(`
    SELECT COUNT(*) AS n
      FROM memory_event_links
     WHERE target_type = 'topic'
       AND target_id IN (${placeholders(LEGACY_UNKNOWN_TOPIC_IDS)})
  `, LEGACY_UNKNOWN_TOPIC_IDS);
}

function countImportTopicLinks() {
  if (!tableExists('memory_event_links')) return 0;
  return count(`
    SELECT COUNT(*) AS n
      FROM memory_event_links
     WHERE target_type = 'topic'
       AND (target_id = 'local-chat-transcript' OR target_id LIKE 'import-%')
  `);
}

function countPersonalChunkBacklog() {
  if (!tableExists('chunks')) return 0;
  return count(`
    SELECT COUNT(*) AS n
      FROM chunks
     WHERE topic = 'personal'
       AND skip_embed = 0
  `);
}

function countUnembeddedPersonalChunkBacklog() {
  if (!tableExists('chunks')) return 0;
  return count(`
    SELECT COUNT(*) AS n
      FROM chunks
     WHERE topic = 'personal'
       AND embedded = 0
       AND skip_embed = 0
  `);
}

function ensureRoutingTopics() {
  if (!tableExists('user_topics')) return { inserted: 0 };
  const now = new Date().toISOString();
  let inserted = 0;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO user_topics (
      slug, label, description, icon, parent_slug, visible, sort_order,
      needs_regen, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  inserted += insert.run(
    UNCATEGORIZED_T1,
    'Uncategorized',
    'Ambiguous intake and data that still needs routing before it becomes durable memory.',
    'inbox',
    null,
    0,
    99,
    now,
    now,
  ).changes;
  return { inserted };
}

function repairDropFolderRouting() {
  if (!tableExists('drop_folder_files')) return { changed: 0 };
  const info = db.prepare(`
    UPDATE drop_folder_files
       SET topic_t1 = ?,
           topic_t2 = ?,
           topic_t3 = NULL
     WHERE (
        (topic_t1 = 'personal' AND topic_t2 IN (${placeholders(AMBIGUOUS_PERSONAL_T2)}))
        OR (topic_t1 = ? AND topic_t2 = ?)
      )
       AND doc_type IN (${placeholders(AMBIGUOUS_DOC_TYPES)})
  `).run(UNCATEGORIZED_T1, null, ...AMBIGUOUS_PERSONAL_T2, UNCATEGORIZED_T1, NEEDS_ROUTING_T2, ...AMBIGUOUS_DOC_TYPES);
  return { changed: info.changes };
}

function repairMemoryAliasLinks() {
  if (!tableExists('memory_event_links')) return { inserted: 0, deleted: 0 };
  const insertInfo = db.prepare(`
    INSERT OR IGNORE INTO memory_event_links (event_id, target_type, target_id, role)
    SELECT DISTINCT event_id, 'topic', ?, 'needs-routing'
      FROM memory_event_links
     WHERE target_type = 'topic'
       AND target_id IN (${placeholders(LEGACY_UNKNOWN_TOPIC_IDS)})
  `).run(NEEDS_ROUTING_TOPIC, ...LEGACY_UNKNOWN_TOPIC_IDS);
  const deleteInfo = db.prepare(`
    DELETE FROM memory_event_links
     WHERE target_type = 'topic'
       AND target_id IN (${placeholders(LEGACY_UNKNOWN_TOPIC_IDS)})
  `).run(...LEGACY_UNKNOWN_TOPIC_IDS);
  return { inserted: insertInfo.changes, deleted: deleteInfo.changes };
}

function normalizeImportTopicLinks() {
  if (!tableExists('memory_event_links')) return { preserved: 0, deleted: 0 };
  const preserveInfo = db.prepare(`
    INSERT OR IGNORE INTO memory_event_links (event_id, target_type, target_id, role)
    SELECT DISTINCT event_id, 'import_source', target_id, 'source'
      FROM memory_event_links
     WHERE target_type = 'topic'
       AND (target_id = 'local-chat-transcript' OR target_id LIKE 'import-%')
  `).run();
  const deleteInfo = db.prepare(`
    DELETE FROM memory_event_links
     WHERE target_type = 'topic'
       AND (target_id = 'local-chat-transcript' OR target_id LIKE 'import-%')
  `).run();
  return { preserved: preserveInfo.changes, deleted: deleteInfo.changes };
}

function markRoutingTopicsStale() {
  if (!tableExists('user_topics') || !columnExists('user_topics', 'needs_regen')) return { changed: 0 };
  const info = db.prepare(`
    UPDATE user_topics
       SET needs_regen = 1,
           updated_at = datetime('now')
     WHERE slug IN (?, ?, 'personal', 'learning')
  `).run(UNCATEGORIZED_T1, NEEDS_ROUTING_T2);
  return { changed: info.changes };
}

function audit() {
  return {
    drop_folder_personal_learning: countDropFolderLegacy(),
    memory_unknown_topic_alias_links: countMemoryAliasLinks(),
    memory_import_tags_as_topics: countImportTopicLinks(),
    personal_chunks_pipeline_owned: countPersonalChunkBacklog(),
    personal_chunks_unembedded_pipeline_owned: countUnembeddedPersonalChunkBacklog(),
  };
}

const before = audit();
let applied = null;

if (APPLY) {
  applied = db.transaction(() => {
    const topics = ensureRoutingTopics();
    const dropFolder = repairDropFolderRouting();
    const memoryAliases = repairMemoryAliasLinks();
    const importLinks = normalizeImportTopicLinks();
    const staleTopics = markRoutingTopicsStale();
    const event = appendMemoryEvent(db, {
      streamType: 'system',
      streamId: 'memory-routing',
      eventType: 'memory.routing.repaired',
      actor: 'codex',
      source: 'memory-routing-repair',
      subjectType: 'topic',
      subjectId: NEEDS_ROUTING_TOPIC,
      validAt: new Date().toISOString(),
      idempotencyKey: `memory-routing-repair:${JSON.stringify(before)}`,
      payload: {
        before,
        topics,
        drop_folder: dropFolder,
        memory_aliases: memoryAliases,
        import_links: importLinks,
        stale_topics: staleTopics,
        chunks_not_moved: {
          reason: 'chunk topic/vector moves are owned by the embedding and reclassify pipeline',
          personal_chunks: before.personal_chunks_pipeline_owned,
          personal_chunks_unembedded: before.personal_chunks_unembedded_pipeline_owned,
        },
      },
      links: [
        { targetType: 'topic', targetId: NEEDS_ROUTING_TOPIC, role: 'needs-routing' },
        { targetType: 'topic', targetId: 'personal', role: 'previous_scope' },
      ],
    }, { useTransaction: false });
    return { topics, dropFolder, memoryAliases, importLinks, staleTopics, event_inserted: !!event?.inserted };
  })();
}

const after = audit();

const output = {
  ok: true,
  action: 'memory_routing_repair',
  mode: APPLY ? 'apply' : 'dry-run',
  checked_at: new Date().toISOString(),
  before,
  applied,
  after,
  note: 'chunks.topic=personal is reported but not moved by this script; reroute those through embedding/reclassify once the data pipeline is healthy.',
};

if (RESULT_FILE) atomicWriteJson(RESULT_FILE, output);
console.log(JSON.stringify(output, null, 2));

db.close?.();
