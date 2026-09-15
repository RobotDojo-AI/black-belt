/**
 * Import user-owned Markdown chat transcripts into the DB index.
 *
 * Source of truth: user/transcripts/chat/*.md.
 * Derived state: conversations, messages, and llm_export chunks.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import db from './db.js';
import { USER_TRANSCRIPTS_DIR } from './robotdojo-paths.js';
import { stableId } from './drop-folder/route-llm-export.js';
import { appendMemoryEvent } from './memory-events.js';
import { insertTimelineEvent } from './timeline-schema.js';
import { topicForDocType } from './taxonomy.js';
import { memoryTopicLink } from './topic-routing-policy.js';

const MAX_CHUNK_CHARS = 1500;

function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n')) return { fields: {}, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return { fields: {}, body: raw };
  const block = raw.slice(4, end).trim();
  const fields = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2].trim().replace(/^"|"$/g, '').replace(/\\"/g, '"');
  }
  return { fields, body: raw.slice(end + 5).trim() };
}

function parseTurns(body) {
  const turns = [];
  const re = /^\*\*(user|assistant|system|tool):\*\*\s*/gmi;
  const matches = [...body.matchAll(re)];
  if (!matches.length) {
    const content = body.trim();
    return content ? [{ role: 'assistant', content, created_at: null }] : [];
  }
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const next = matches[i + 1];
    const role = match[1].toLowerCase();
    const start = match.index + match[0].length;
    const end = next ? next.index : body.length;
    const content = body.slice(start, end).trim();
    if (content) turns.push({ role, content, created_at: null });
  }
  return turns;
}

function sourceFromFileName(filePath) {
  const name = basename(filePath);
  return name.match(/^\d{4}-\d{2}-\d{2}-\d{4}-([a-z0-9]+)-/i)?.[1]?.toLowerCase() || 'unknown';
}

function providerModel(source) {
  const s = String(source || '').toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku/.test(s)) return { provider: 'claude', model: 'claude' };
  if (/gpt|openai|chatgpt|o1|o3|o4/.test(s)) return { provider: 'chatgpt', model: 'gpt' };
  if (/gemini|google/.test(s)) return { provider: 'gemini', model: 'gemini' };
  if (/grok|xai/.test(s)) return { provider: 'grok', model: 'grok' };
  if (/ollama|llama|qwen|mistral/.test(s)) return { provider: 'ollama', model: s || 'ollama' };
  return { provider: s || 'unknown', model: s || 'unknown' };
}

function sha256(text) {
  return createHash('sha256').update(String(text || '')).digest('hex');
}

function createdAtFromFields(fields) {
  if (fields.date && fields.time) {
    const iso = `${fields.date}T${fields.time}:00`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (fields.date) {
    const d = new Date(`${fields.date}T00:00:00`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function chunkConversation(conv) {
  const chunks = [];
  const meta = JSON.stringify({
    provider: conv.provider,
    model: conv.model,
    title: conv.title,
    file_path: conv.filePath,
    date: conv.createdAt.slice(0, 10),
  });
  const prefix = `[${conv.createdAt.slice(0, 10)} | ${conv.model} | ${conv.title.slice(0, 60)}]`;
  const firstUser = conv.turns.find((t) => t.role === 'user')?.content?.slice(0, 200) || '';
  const lastUser = [...conv.turns].reverse().find((t) => t.role === 'user')?.content?.slice(0, 200) || '';
  chunks.push({ index: 0, content: `${prefix}\n\nFirst: ${firstUser}\nLast: ${lastUser}`, meta });

  for (let i = 0; i < conv.turns.length; i++) {
    const turn = conv.turns[i];
    if (turn.role !== 'user') {
      chunks.push({
        index: chunks.length,
        content: `${prefix}\n${turn.role}: ${turn.content.slice(0, MAX_CHUNK_CHARS)}`.slice(0, MAX_CHUNK_CHARS),
        meta,
      });
      continue;
    }
    const next = conv.turns[i + 1];
    const content = next?.role === 'assistant'
      ? `${prefix}\nUser: ${turn.content.slice(0, MAX_CHUNK_CHARS)}\nAssistant: ${next.content.slice(0, MAX_CHUNK_CHARS)}`
      : `${prefix}\nUser: ${turn.content.slice(0, MAX_CHUNK_CHARS)}`;
    chunks.push({ index: chunks.length, content: content.slice(0, MAX_CHUNK_CHARS), meta });
    if (next?.role === 'assistant') i++;
  }
  return chunks;
}

const insertConv = db.prepare(`
  INSERT OR IGNORE INTO conversations
    (id, title, model, tags, chat_type, archived, file_path, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'chat', 0, ?, ?, datetime('now'))
`);

const updateConv = db.prepare(`
  UPDATE conversations
     SET title = ?,
         model = ?,
         tags = ?,
         file_path = COALESCE(file_path, ?),
         updated_at = datetime('now')
   WHERE id = ?
`);

const countMessages = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE conversation_id=?`);

const insertMsg = db.prepare(`
  INSERT INTO messages (conversation_id, role, content, seq, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

const insertChunk = db.prepare(`
  INSERT INTO chunks
    (topic, source_type, source_id, chunk_index, content, metadata, token_count, embedded, skip_embed, created_at)
  VALUES (?, 'llm_export', ?, ?, ?, ?, ?, 0, 0, datetime('now'))
  ON CONFLICT(topic, source_type, source_id, chunk_index) DO UPDATE SET
    content = excluded.content,
    metadata = excluded.metadata,
    embedded = CASE WHEN chunks.content IS excluded.content THEN chunks.embedded ELSE 0 END,
    content_hash = CASE WHEN chunks.content IS excluded.content THEN chunks.content_hash ELSE NULL END,
    embedding_model_id = CASE WHEN chunks.content IS excluded.content THEN chunks.embedding_model_id ELSE NULL END,
    embedding_dim = CASE WHEN chunks.content IS excluded.content THEN chunks.embedding_dim ELSE NULL END,
    embedding_signature = CASE WHEN chunks.content IS excluded.content THEN chunks.embedding_signature ELSE NULL END,
    embedded_at = CASE WHEN chunks.content IS excluded.content THEN chunks.embedded_at ELSE NULL END
`);

export function parseChatTranscriptFile(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const { fields, body } = parseFrontmatter(raw);
  const source = fields.source || sourceFromFileName(filePath);
  const { provider, model } = providerModel(source);
  const turns = parseTurns(body);
  const id = fields.id && /^[a-z0-9._:-]{8,}$/i.test(fields.id)
    ? fields.id
    : stableId('local-chat-transcript', createHash('sha256').update(filePath).digest('hex'));
  return {
    id,
    title: fields.title || basename(filePath).replace(/\.md$/i, ''),
    provider,
    model,
    createdAt: createdAtFromFields(fields),
    filePath,
    turns,
  };
}

export function importChatTranscriptFile(filePath) {
  const conv = parseChatTranscriptFile(filePath);
  if (!conv.turns.length) return { imported: 0, skipped: 1, chunks: 0, id: conv.id };
  const fallbackTopic = topicForDocType('llm_export');
  const fallbackSlug = fallbackTopic.t2 || fallbackTopic.t1;
  const fallbackTag = fallbackTopic.t2 ? `${fallbackTopic.t1}/${fallbackTopic.t2}` : fallbackTopic.t1;
  const tags = JSON.stringify([`import-${conv.provider}`, 'local-chat-transcript', fallbackTag]);
  const inserted = insertConv.run(
    conv.id,
    conv.title.slice(0, 200),
    conv.model,
    tags,
    conv.filePath,
    conv.createdAt,
  ).changes;
  updateConv.run(conv.title.slice(0, 200), conv.model, tags, conv.filePath, conv.id);
  insertTimelineEvent({
    sourceType: 'chat',
    sourceId: conv.id,
    eventDate: conv.createdAt,
    eventType: 'chat',
    summary: conv.title.slice(0, 220),
    content: `${conv.title}\n${conv.turns.map((turn) => `${turn.role}: ${turn.content}`).join('\n')}`,
    metadata: {
      provider: conv.provider,
      model: conv.model,
      file_path: conv.filePath,
      source: 'chat-transcript-import',
      turn_count: conv.turns.length,
    },
  });

  if ((countMessages.get(conv.id)?.c || 0) === 0) {
    conv.turns.forEach((turn, seq) => {
      const result = insertMsg.run(conv.id, turn.role, turn.content, seq, turn.created_at || conv.createdAt);
      appendMemoryEvent(db, {
        streamType: 'chat',
        streamId: conv.id,
        eventType: `chat.message.${turn.role}`,
        actor: turn.role,
        source: 'chat-transcript-import',
        subjectType: 'conversation',
        subjectId: conv.id,
        validAt: turn.created_at || conv.createdAt,
        idempotencyKey: `chat-import-message:${conv.id}:${seq}:${turn.role}:${sha256(turn.content)}`,
        payload: {
          message_id: String(result.lastInsertRowid),
          role: turn.role,
          seq,
          content_hash: sha256(turn.content),
          content_chars: String(turn.content || '').length,
          file_path: conv.filePath,
          provider: conv.provider,
          model: conv.model,
        },
        links: [
          { targetType: 'conversation', targetId: conv.id, role: 'source' },
          memoryTopicLink(fallbackSlug, { fallback: true }),
        ].filter(Boolean),
      });
    });
  }

  const chunks = chunkConversation(conv);
  for (const chunk of chunks) {
    insertChunk.run(fallbackSlug, conv.id, chunk.index, chunk.content, chunk.meta, Math.ceil(chunk.content.length / 4));
  }

  return { imported: inserted ? 1 : 0, skipped: inserted ? 0 : 1, chunks: chunks.length, id: conv.id };
}

export function importChatTranscriptDirectory(dir = resolve(USER_TRANSCRIPTS_DIR, 'chat')) {
  const files = [];
  const walk = (current) => {
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(path);
    }
  };
  walk(dir);

  const totals = { files: files.length, imported: 0, skipped: 0, chunks: 0, errors: [] };
  for (const file of files) {
    try {
      const result = importChatTranscriptFile(file);
      totals.imported += result.imported;
      totals.skipped += result.skipped;
      totals.chunks += result.chunks;
    } catch (err) {
      totals.errors.push({ file, error: err.message });
    }
  }
  return totals;
}
