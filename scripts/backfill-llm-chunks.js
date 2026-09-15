/**
 * Backfill RAG chunks for import-* conversations that have messages but no llm_export chunks.
 *
 * WHY: The prior import mechanism (before route-llm-export.js) wrote conversations+messages
 * but never called chunkConversation(). 1,292 conversations have 0 RAG chunks.
 * This script reads messages from the DB, reconstructs turn pairs, and inserts chunks.
 */
import db from '../lib/db.js';

const MAX_CHUNK_CHARS = 1500;

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

// Conversations with messages but no llm_export chunks
const convRows = db.prepare(`
  SELECT DISTINCT c.id, c.title, c.model, c.tags, c.created_at
  FROM conversations c
  JOIN messages m ON m.conversation_id = c.id
  WHERE c.tags LIKE '%import-%'
  AND NOT EXISTS (
    SELECT 1 FROM chunks WHERE source_type='llm_export' AND source_id=c.id
  )
  ORDER BY c.created_at
`).all();

console.log(`Found ${convRows.length} conversations needing chunks`);

const getMessages = db.prepare(`
  SELECT role, content, created_at FROM messages
  WHERE conversation_id = ?
  ORDER BY seq ASC, rowid ASC
`);

let totalChunks = 0;
let processedConvs = 0;

for (const conv of convRows) {
  const messages = getMessages.all(conv.id);
  if (messages.length === 0) continue;

  const turns = messages.map(m => ({ role: m.role, content: m.content || '', created_at: m.created_at }));

  // Detect provider from tags
  let provider = 'unknown';
  try {
    const tags = JSON.parse(conv.tags || '[]');
    const importTag = tags.find(t => t.startsWith('import-'));
    if (importTag) provider = importTag.replace('import-', '');
  } catch {}

  const createdAt = conv.created_at || new Date().toISOString();
  const meta = JSON.stringify({
    provider,
    model: conv.model || provider,
    title: conv.title || 'Imported conversation',
    date: createdAt.slice(0, 10),
  });
  const title = (conv.title || 'Imported conversation').slice(0, 60);
  const prefix = `[${createdAt.slice(0, 10)} | ${conv.model || provider} | ${title}]`;

  const chunks = [];

  // Chunk 0: session summary
  const firstUser = turns.find(t => t.role === 'user')?.content?.slice(0, 200) || '';
  const lastUser = [...turns].reverse().find(t => t.role === 'user')?.content?.slice(0, 200) || '';
  chunks.push({ index: 0, content: `${prefix}\n\nFirst: ${firstUser}\nLast: ${lastUser}`, meta });

  // Chunks 1..N: turn pairs
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== 'user') continue;
    const userText = turns[i].content.slice(0, MAX_CHUNK_CHARS);
    const asst = turns[i + 1];
    if (!asst || asst.role !== 'assistant') {
      chunks.push({ index: chunks.length, content: `${prefix}\nUser: ${userText}`.slice(0, MAX_CHUNK_CHARS), meta });
      continue;
    }
    const asstText = asst.content.slice(0, MAX_CHUNK_CHARS);
    chunks.push({ index: chunks.length, content: `${prefix}\nUser: ${userText}\nAssistant: ${asstText}`.slice(0, MAX_CHUNK_CHARS), meta });
    i++;
  }

  const insertMany = db.transaction(() => {
    for (const chunk of chunks) {
      const tokenCount = Math.ceil(chunk.content.length / 4);
      insertChunk.run('personal', conv.id, chunk.index, chunk.content, chunk.meta, tokenCount);
    }
  });
  insertMany();

  totalChunks += chunks.length;
  processedConvs++;

  if (processedConvs % 100 === 0) {
    process.stdout.write(`  ${processedConvs}/${convRows.length} conversations, ${totalChunks} chunks inserted\r`);
  }
}

console.log(`\nDone: ${processedConvs} conversations, ${totalChunks} chunks inserted`);

// Final verification
const remaining = db.prepare(`
  SELECT COUNT(DISTINCT c.id) as n FROM conversations c
  JOIN messages m ON m.conversation_id = c.id
  WHERE c.tags LIKE '%import-%'
  AND NOT EXISTS (SELECT 1 FROM chunks WHERE source_type='llm_export' AND source_id=c.id)
`).get();
console.log(`Conversations still without chunks: ${remaining.n}`);
