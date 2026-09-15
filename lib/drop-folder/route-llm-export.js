/**
 * LLM export router.
 *
 * Handles: ChatGPT conversations.json, Claude conversations.jsonl,
 * Gemini per-conversation JSON, and non-conversation LLM export files
 * (memories.json, users.json, projects.json).
 *
 * WHY deterministic UUID: sha256(provider:providerUuid) → same conversation
 * always gets the same DB id, making re-import fully idempotent without a
 * separate tracking table or migration.
 *
 * WHY INSERT OR IGNORE: if the conversation already exists (changes===0),
 * skip messages and chunks entirely — avoids duplicate turns and re-embedding.
 *
 * Compute tier: Tier 0 only — structural parsing, no LLM calls.
 * Text extraction is mechanical; no signal prioritization needed here.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { inferTopicFromContent } from '../conversations.js';
import { topicForDocType } from '../taxonomy.js';

// --- Stable ID -----------------------------------------------------------------

/**
 * Deterministic UUID from provider + provider's conversation UUID.
 * Format: 8-4-4-4-12 hex from sha256 digest.
 * WHY: idempotent re-import without a new unique constraint or migration.
 */
export function stableId(provider, providerUuid) {
  const h = createHash('sha256').update(`${provider}:${providerUuid}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

// --- Provider detection --------------------------------------------------------

/**
 * Detect LLM provider from filename, then content probe if ambiguous.
 * Returns 'chatgpt' | 'claude' | 'gemini' | 'grok' | 'unknown'
 */
function detectProvider(originalName, content) {
  const name = originalName.toLowerCase();

  // Filename signals
  if (/chatgpt|openai/.test(name)) return 'chatgpt';
  if (/claude/.test(name)) return 'claude';
  if (/gemini|google/.test(name)) return 'gemini';
  if (/grok|xai/.test(name)) return 'grok';
  if (name.endsWith('.jsonl') || name === 'conversations.jsonl') return 'claude';

  // Content probe — inspect first 500 bytes
  const peek = content.slice(0, 500);
  if (peek.includes('"mapping"')) return 'chatgpt';
  if (peek.includes('"chat_messages"')) return 'claude';
  if (peek.includes('"conversations"') && peek.includes('"entries"')) return 'gemini';
  if (peek.includes('"uuid"') && peek.includes('"chat_messages"')) return 'claude';

  return 'chatgpt'; // best-effort fallback — conversations.json is most commonly ChatGPT
}

// --- ChatGPT parser ------------------------------------------------------------

/**
 * Traverse ChatGPT DAG: start at current_node, walk parent links backward,
 * reverse for chronological order.
 * WHY walk from current_node: deleted/regenerated branches exist in mapping
 * but are off the main path. Weight<1 filtering catches remaining off-path nodes.
 */
function traverseChatGPT(mapping, currentNode) {
  const turns = [];
  let nodeId = currentNode;
  const visited = new Set();

  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node = mapping[nodeId];
    if (!node) break;

    const msg = node.message;
    if (msg && msg.content && (msg.weight === undefined || msg.weight >= 1.0)) {
      const role = msg.author?.role;
      const contentType = msg.content.content_type;
      if ((role === 'user' || role === 'assistant') && contentType === 'text') {
        const parts = msg.content.parts || [];
        const text = parts.filter(p => typeof p === 'string').join('').trim();
        if (text) {
          turns.unshift({
            role,
            content: text,
            created_at: msg.create_time ? new Date(msg.create_time * 1000).toISOString() : null,
          });
        }
      }
    }
    nodeId = node.parent;
  }
  return turns;
}

function parseChatGPT(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];

  return data.map(conv => {
    const providerUuid = conv.conversation_id || conv.id || randomUUID();
    const turns = conv.mapping && conv.current_node
      ? traverseChatGPT(conv.mapping, conv.current_node)
      : [];
    return {
      providerUuid,
      title: conv.title || 'Imported conversation',
      model: conv.default_model_slug || 'gpt-4',
      createdAt: conv.create_time ? new Date(conv.create_time * 1000).toISOString() : new Date().toISOString(),
      turns,
    };
  }).filter(c => c.turns.length > 0);
}

// --- Claude parser -------------------------------------------------------------

function parseClaude(raw) {
  // Claude exports two formats:
  // 1. JSON array: conversations.json from claude.ai export (all on one line)
  // 2. JSONL: one conversation object per line
  // WHY try array first: the content probe already confirmed it's Claude — handle the
  // common export format before falling back to JSONL.
  let convObjects = [];
  const trimmed = raw.trim();

  if (trimmed.startsWith('[')) {
    // JSON array format
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) convObjects = arr;
    } catch { /* fall through to JSONL */ }
  }

  if (convObjects.length === 0) {
    // JSONL: one JSON object per line
    for (const line of trimmed.split('\n')) {
      if (!line.trim()) continue;
      try { convObjects.push(JSON.parse(line)); } catch { continue; }
    }
  }

  const conversations = [];
  for (const conv of convObjects) {
    if (!conv || typeof conv !== 'object' || Array.isArray(conv)) continue;

    const messages = Array.isArray(conv.chat_messages) ? conv.chat_messages : [];
    const turns = messages.map((m) => ({
      role: m.sender === 'human' ? 'user' : 'assistant',
      content: typeof m.text === 'string' ? m.text.trim() : '',
      created_at: m.created_at || null,
    })).filter(t => t.content);

    if (turns.length === 0) continue;

    conversations.push({
      providerUuid: conv.uuid || stableId('claude-fallback', JSON.stringify(conv).slice(0, 64)),
      title: conv.name || 'Imported Claude conversation',
      model: 'claude',
      createdAt: conv.created_at || new Date().toISOString(),
      turns,
    });
  }

  return conversations;
}

// --- Gemini parser -------------------------------------------------------------

function parseGemini(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return []; }

  const convList = Array.isArray(data?.conversations) ? data.conversations
    : Array.isArray(data) ? data : [];

  return convList.map(conv => {
    const entries = Array.isArray(conv.entries) ? conv.entries : [];
    const turns = entries.map(e => ({
      role: e.role === 'model' ? 'assistant' : 'user',
      content: typeof e.text === 'string' ? e.text.trim() : '',
      created_at: e.create_time || null,
    })).filter(t => t.content);

    if (turns.length === 0) return null;

    const providerUuid = conv.id ||
      stableId('gemini-fallback', (turns[0]?.content || '') + (conv.create_time || ''));

    return {
      providerUuid,
      title: conv.title || 'Imported Gemini conversation',
      model: 'gemini',
      createdAt: conv.create_time || new Date().toISOString(),
      turns,
    };
  }).filter(Boolean);
}

// --- Chunking ------------------------------------------------------------------

const MAX_CHUNK_CHARS = 1500;

function chunkConversation(convId, conv) {
  const chunks = [];
  const meta = JSON.stringify({
    provider: conv.provider,
    model: conv.model,
    title: conv.title,
    date: conv.createdAt?.slice(0, 10),
  });
  const prefix = `[${conv.createdAt?.slice(0,10) || '?'} | ${conv.model} | ${conv.title.slice(0,60)}]`;

  // Chunk 0: session summary
  const firstUser = conv.turns.find(t => t.role === 'user')?.content?.slice(0, 200) || '';
  const lastUser = [...conv.turns].reverse().find(t => t.role === 'user')?.content?.slice(0, 200) || '';
  const summaryContent = `${prefix}\n\nFirst: ${firstUser}\nLast: ${lastUser}`;
  chunks.push({ index: 0, content: summaryContent, meta });

  // Chunks 1..N: turn pairs
  const turns = conv.turns;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== 'user') continue;
    const userText = turns[i].content.slice(0, MAX_CHUNK_CHARS);
    const asst = turns[i + 1];
    if (!asst || asst.role !== 'assistant') {
      // Solo user turn with no response
      const content = `${prefix}\nUser: ${userText}`.slice(0, MAX_CHUNK_CHARS);
      chunks.push({ index: chunks.length, content, meta });
      continue;
    }
    const asstText = asst.content.slice(0, MAX_CHUNK_CHARS);
    const content = `${prefix}\nUser: ${userText}\nAssistant: ${asstText}`.slice(0, MAX_CHUNK_CHARS);
    chunks.push({ index: chunks.length, content, meta });
    i++; // skip the assistant turn (consumed)
  }

  return chunks;
}

// --- DB insertion --------------------------------------------------------------

const insertConv = db.prepare(`
  INSERT OR IGNORE INTO conversations
    (id, title, model, tags, chat_type, archived, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'chat', 0, ?, datetime('now'))
`);

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

async function materializeConversationFile(id) {
  if (process.env.NODE_TEST_CONTEXT || process.env.ROBOTDOJO_DB === ':memory:') return;
  try {
    const { writeConversationFile } = await import('../transcripts.js');
    await writeConversationFile(id);
  } catch (err) {
    console.warn(`[llm-export] transcript materialize failed for ${id}: ${err.message}`);
  }
}

// Fallback topic for an imported conversation when Tier-0 keyword inference finds
// no match — the doc-type default for llm_export (Uncategorized).
// The embedding reclassifier (05-reclassify, AC3) re-homes it across the whole
// ontology afterward, so this is an initial placement, not a final verdict.
function llmExportTopicPair() {
  return topicForDocType('llm_export');
}

function llmExportFallbackTopic() {
  const d = llmExportTopicPair();
  return d?.t2 || d?.t1 || 'uncategorized';
}

/**
 * Classify one imported conversation to its best T1/T2 topic by content.
 * Tier 0 keyword match against the live (now description-rich) ontology — free,
 * inline, deterministic. Returns { slug, method }. st_fcdbe84f AC1.
 */
function classifyImportedConversation(conv) {
  const userText = conv.turns
    .filter((t) => t.role === 'user')
    .map((t) => t.content || '')
    .join('\n')
    .slice(0, 4000);
  const inferred = userText ? inferTopicFromContent(userText, db) : null;
  return inferred?.slug
    ? { slug: inferred.slug, method: 'keyword' }
    : { slug: llmExportFallbackTopic(), method: 'auto' };
}

const markTopicNeedsRegen = db.prepare(
  "UPDATE user_topics SET needs_regen = 1, updated_at = datetime('now') WHERE slug = ?",
);
const setConvTopic = db.prepare(
  "UPDATE conversations SET topic_slug = ?, topic_set_method = ? WHERE id = ? AND (topic_set_method IS NULL OR topic_set_method != 'user')",
);

async function ingestConversations(conversations, provider) {
  let newCount = 0;
  let skipCount = 0;
  // Topics that gained imported chunks — flagged for context.md regeneration.
  const assignedSlugs = new Set();

  for (const conv of conversations) {
    const id = stableId(provider, conv.providerUuid);
    const fallbackTopic = llmExportTopicPair();
    const tags = JSON.stringify([`import-${provider}`, `${fallbackTopic.t1}/${fallbackTopic.t2}`]);
    const model = provider === 'grok' && (!conv.model || /^gpt/i.test(conv.model))
      ? 'grok'
      : (conv.model || provider);

    const { changes } = insertConv.run(id, conv.title.slice(0, 200), model, tags, conv.createdAt);

    if (changes === 0) {
      // WHY skip: deterministic id means this conversation already exists.
      // Re-inserting messages/chunks would create duplicates (messages has no unique constraint).
      skipCount++;
      await materializeConversationFile(id);
      continue;
    }

    newCount++;

    // Insert messages
    conv.turns.forEach((turn, seq) => {
      insertMsg.run(id, turn.role, turn.content, seq, turn.created_at || new Date().toISOString());
    });

    // Topic placement by content (AC1) — never blanket 'personal'.
    const { slug: topicSlug, method } = classifyImportedConversation(conv);
    assignedSlugs.add(topicSlug);

    // Insert chunks under the classified topic
    const enrichedConv = { ...conv, provider, model };
    const chunks = chunkConversation(id, enrichedConv);
    for (const chunk of chunks) {
      const tokenCount = Math.ceil(chunk.content.length / 4);
      insertChunk.run(topicSlug, id, chunk.index, chunk.content, chunk.meta, tokenCount);
    }
    // Record the conversation's primary topic (auto/keyword — never overrides a user choice).
    setConvTopic.run(topicSlug, method, id);
    await materializeConversationFile(id);
  }

  // AC1/AC5: flag every topic that gained imported chunks so the maintenance /
  // topic-edit watcher regenerates its context.md from the new material.
  for (const slug of assignedSlugs) markTopicNeedsRegen.run(slug);

  return { newCount, skipCount };
}

// --- Non-conversation file detection ------------------------------------------

/**
 * Returns true if this file is an LLM export metadata file (not conversations).
 * memories.json, users.json, projects.json match the llm_export classifier
 * regex but contain no conversation data.
 */
function isNonConversationFile(originalName) {
  const name = basename(originalName).toLowerCase();
  return /^(memories|users|projects|user|memory|project)\.json$/.test(name);
}

// --- Main router entry ---------------------------------------------------------

export async function routeLlmExport({ path, originalName }) {
  const name = basename(originalName || path);

  // Non-conversation LLM export files — index them as processed but don't parse
  if (isNonConversationFile(name)) {
    const topic = llmExportTopicPair();
    return {
      doc_type: 'llm_export',
      topic_t1: topic.t1,
      topic_t2: topic.t2,
      extracted_json: JSON.stringify({ provider: 'metadata', count: 0, new_count: 0, skip_count: 0 }),
      entity_refs: null,
      confidence: 0.8,
    };
  }

  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const topic = llmExportTopicPair();
    return {
      doc_type: 'llm_export',
      topic_t1: topic.t1,
      topic_t2: topic.t2,
      extracted_json: null,
      entity_refs: null,
      confidence: 0,
      status: 'needs_user',
      error: `read failed: ${err.message}`,
    };
  }

  if (!raw.trim()) {
    // WHY needs_user: an empty or whitespace-only file cannot be parsed.
    // Flag it so the user knows to re-export or check the file.
    const topic = llmExportTopicPair();
    return {
      doc_type: 'llm_export',
      topic_t1: topic.t1,
      topic_t2: topic.t2,
      extracted_json: null,
      entity_refs: null,
      confidence: 0,
      status: 'needs_user',
      error: 'file is empty — re-export from provider and drop again',
    };
  }

  const provider = detectProvider(name, raw);

  let conversations = [];
  try {
    if (provider === 'claude') {
      conversations = parseClaude(raw);
    } else if (provider === 'gemini') {
      conversations = parseGemini(raw);
    } else {
      // chatgpt / grok / unknown — attempt ChatGPT parser, fall through gracefully
      conversations = parseChatGPT(raw);
      // If ChatGPT parser returned nothing and provider is unknown, try Claude JSONL
      if (conversations.length === 0 && provider === 'unknown') {
        const claudeAttempt = parseClaude(raw);
        if (claudeAttempt.length > 0) conversations = claudeAttempt;
      }
    }
  } catch (err) {
    const topic = llmExportTopicPair();
    return {
      doc_type: 'llm_export',
      topic_t1: topic.t1,
      topic_t2: topic.t2,
      extracted_json: null,
      entity_refs: null,
      confidence: 0,
      status: 'needs_user',
      error: `parse failed: ${err.message}`,
    };
  }

  if (conversations.length === 0) {
    const topic = llmExportTopicPair();
    return {
      doc_type: 'llm_export',
      topic_t1: topic.t1,
      topic_t2: topic.t2,
      extracted_json: JSON.stringify({ provider, count: 0, new_count: 0, skip_count: 0 }),
      entity_refs: null,
      confidence: 0.7,
    };
  }

  const { newCount, skipCount } = await ingestConversations(conversations, provider);
  const topic = llmExportTopicPair();

  return {
    doc_type: 'llm_export',
    topic_t1: topic.t1,
    topic_t2: topic.t2,
    extracted_json: JSON.stringify({
      provider,
      count: conversations.length,
      new_count: newCount,
      skip_count: skipCount,
    }),
    entity_refs: null,
    confidence: 0.9,
  };
}
