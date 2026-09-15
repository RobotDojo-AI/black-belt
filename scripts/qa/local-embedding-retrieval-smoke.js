#!/usr/bin/env node
/**
 * Retrieval smoke for local embeddings.
 *
 * It checks two hermetic paths:
 *   1. Production vector search returns a known result from a real local
 *      sqlite-vec table seeded with the same local embedding runtime.
 *   2. Production search falls back to FTS when vectors are unavailable,
 *      and any attempted network call fails the smoke.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

if (process.env.QA_LOCAL_EMBEDDING_RETRIEVAL_CHILD === '1') {
  await runChild();
  process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-embedding-retrieval-'));
try {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      QA_LOCAL_EMBEDDING_RETRIEVAL_CHILD: '1',
      ROBOTDOJO_DB: path.join(tmpDir, 'qa.db'),
      ROBOTDOJO_ALLOW_PLAINTEXT: '1',
      ROBOTDOJO_LOCAL_DB_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ROBOTDOJO_LOCAL_EMBEDDING_TEST_STUB: '1',
      TRANSFORMERS_OFFLINE: '1',
      GOOGLE_AI_API_KEY: '',
      OPENAI_API_KEY: '',
      NODE_ENV: 'test',
    },
    encoding: 'utf8',
    timeout: 90_000,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  process.stdout.write(result.stdout);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function runChild() {
  let fetchCalled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCalled = true;
    throw new Error(`network disabled in retrieval smoke: ${args[0]}`);
  };

  try {
    const { default: db } = await import(pathToFileURL(path.join(REPO_ROOT, 'lib/db.js')).href);
    const {
      EMBED_DIM,
      EMBED_MODEL,
      contentHash,
      embedBatch,
      embeddingSignature,
      vectorToBuffer,
    } = await import(pathToFileURL(path.join(REPO_ROOT, 'lib/rag.js')).href);

    const content = 'The orchid greenhouse appointment is Monday with a planning checklist.';
    db.prepare(`
      INSERT INTO chunks (topic, source_type, source_id, chunk_index, content, metadata, embedded, skip_embed)
      VALUES ('qa_semantic', 'test', 'semantic-hit', 0, ?, ?, 0, 0)
    `).run(content, JSON.stringify({ event_time: new Date().toISOString() }));
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec_qa_semantic USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${EMBED_DIM}])`);
    const semanticChunk = db.prepare(`SELECT id FROM chunks WHERE topic = 'qa_semantic' AND source_id = 'semantic-hit'`).get();
    const [documentVec] = await embedBatch([content], 1, null, { inputType: 'document' });
    const hash = contentHash(content);
    const signature = embeddingSignature({ content_hash: hash, topic: 'qa_semantic', modelId: EMBED_MODEL, dim: EMBED_DIM });
    db.prepare(`INSERT INTO chunk_vec_qa_semantic(chunk_id, embedding) VALUES (?, ?)`)
      .run(String(semanticChunk.id), vectorToBuffer(documentVec));
    db.prepare(`
      UPDATE chunks
         SET embedded = 1,
             content_hash = ?,
             embedding_model_id = ?,
             embedding_dim = ?,
             embedding_signature = ?,
             embedded_at = datetime('now')
       WHERE id = ?
    `).run(hash, EMBED_MODEL, EMBED_DIM, signature, semanticChunk.id);

    const { search } = await import(pathToFileURL(path.join(REPO_ROOT, 'lib/rag-search.js')).href);
    const semantic = await search('orchid greenhouse appointment Monday', {
      topic: 'qa_semantic',
      mode: 'vector',
      limit: 3,
    });
    assert(semantic[0]?.source_id === 'semantic-hit', 'semantic vector retrieval did not return expected chunk');

    db.prepare(`
      INSERT INTO chunks (topic, source_type, source_id, chunk_index, content, metadata, embedded, skip_embed)
      VALUES ('qa_fts', 'test', 'fts-hit', 0, 'orchid greenhouse appointment fallback', '{}', 0, 0)
    `).run();
    try { db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')").run(); } catch {}

    const fallback = await search('orchid greenhouse', { topic: 'qa_fts', mode: 'hybrid', limit: 3 });
    assert(fallback.some(row => row.source_id === 'fts-hit'), 'FTS fallback did not return expected local chunk');
    assert(fetchCalled === false, 'retrieval attempted a network embedding call');
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('OK: retrieval returns known local chunk and falls back to FTS without cloud embeddings');
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}
