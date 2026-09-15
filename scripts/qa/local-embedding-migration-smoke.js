#!/usr/bin/env node
/**
 * Hermetic migration smoke for the local embedding cutover.
 *
 * Seeds a temp DB with raw chunks, FTS rows, old 3072-dim vec artifacts, and
 * stale ANN sidecars. Then it invokes the implementation migration module and
 * proves raw source rows survive while derived embedding artifacts are rebuilt
 * or invalidated for 1024-dim Snowflake vectors.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL_ID = 'Snowflake/snowflake-arctic-embed-l-v2.0';
const EXPECTED_DIM = 1024;

if (process.env.QA_LOCAL_EMBEDDING_MIGRATION_CHILD === '1') {
  await runChild();
  process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-embedding-migration-'));
try {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      QA_LOCAL_EMBEDDING_MIGRATION_CHILD: '1',
      ROBOTDOJO_DB: path.join(tmpDir, 'qa.db'),
      ROBOTDOJO_ANN_DIR: path.join(tmpDir, 'ann'),
      ROBOTDOJO_ALLOW_PLAINTEXT: '1',
      ROBOTDOJO_LOCAL_DB_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ROBOTDOJO_LOCAL_EMBEDDING_TEST_STUB: '1',
      TRANSFORMERS_OFFLINE: '1',
      NODE_ENV: 'test',
    },
    encoding: 'utf8',
    timeout: 45_000,
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
  const before = await seedLegacyFile(process.env.ROBOTDOJO_DB);

  // Importing lib/db.js is the product migration path: it opens the temp DB,
  // loads sqlite-vec, applies SQL migrations, then runs inline migrate() steps.
  const { default: db } = await import(pathToFileURL(path.join(REPO_ROOT, 'lib/db.js')).href);
  const after = snapshot(db);

  assert(after.chunkCount === before.chunkCount, `chunk count changed ${before.chunkCount} -> ${after.chunkCount}`);
  assert(after.rawJson === before.rawJson, 'raw chunk/source content changed');
  assert(after.ftsCount === before.ftsCount, `FTS row count changed ${before.ftsCount} -> ${after.ftsCount}`);
  assert(after.oldVecTables.length === 0, `old 3072-dim vec tables still present: ${after.oldVecTables.join(', ')}`);
  assert(after.vecTables.every(t => t.sql.includes(`float[${EXPECTED_DIM}]`)), 'vec tables must be absent or 1024-dim');
  assert(!after.staleAnnSidecar, 'stale ANN sidecar survived migration');

  console.log(`OK: migration preserved ${after.chunkCount} chunks and invalidated derived vectors/ANN for ${MODEL_ID}`);
}

async function seedLegacyFile(dbPath) {
  const { default: PlainDatabase } = await import('better-sqlite3');
  const sqliteVec = await import('sqlite-vec');
  const db = new PlainDatabase(dbPath);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      topic        TEXT NOT NULL,
      source_type  TEXT NOT NULL,
      source_id    TEXT NOT NULL,
      chunk_index  INTEGER NOT NULL DEFAULT 0,
      content      TEXT NOT NULL,
      metadata     TEXT NOT NULL DEFAULT '{}',
      token_count  INTEGER NOT NULL DEFAULT 0,
      embedded     INTEGER NOT NULL DEFAULT 0,
      skip_embed   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(topic, source_type, source_id, chunk_index)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      content='chunks',
      content_rowid='id'
    );
  `);

  db.prepare(`DELETE FROM chunks WHERE topic = 'qa_local_embedding'`).run();
  db.prepare(`
    INSERT INTO chunks (topic, source_type, source_id, chunk_index, content, metadata, embedded, skip_embed)
    VALUES ('qa_local_embedding', 'test', 'source-a', 0, 'orchid tax planning note', '{"kind":"raw"}', 1, 0)
  `).run();
  db.prepare(`
    INSERT INTO chunks (topic, source_type, source_id, chunk_index, content, metadata, embedded, skip_embed)
    VALUES ('qa_local_embedding', 'test', 'source-b', 1, 'greenhouse appointment memory', '{"kind":"raw"}', 1, 0)
  `).run();
  try { db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')").run(); } catch {}

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec_qa_local_embedding USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[3072])`);
  const rowIds = db.prepare(`SELECT id FROM chunks WHERE topic = 'qa_local_embedding' ORDER BY id`).all();
  const insertVec = db.prepare(`INSERT INTO chunk_vec_qa_local_embedding(chunk_id, embedding) VALUES (?, ?)`);
  for (const row of rowIds) insertVec.run(String(row.id), Buffer.alloc(3072 * 4));

  const annDir = process.env.ROBOTDOJO_ANN_DIR;
  fs.mkdirSync(annDir, { recursive: true });
  fs.writeFileSync(path.join(annDir, 'sidecar.json'), JSON.stringify({
    dim: 768,
    model_id: 'legacy-paid-embedding-model',
    built_from_count: rowIds.length,
  }, null, 2));

  const before = snapshot(db);
  db.close();
  return before;
}

function snapshot(db) {
  const rows = db.prepare(`
    SELECT topic, source_type, source_id, chunk_index, content, metadata
    FROM chunks
    WHERE topic = 'qa_local_embedding'
    ORDER BY id
  `).all();
  const vecTables = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'chunk_vec_%'
    ORDER BY name
  `).all();
  let ftsCount = 0;
  try { ftsCount = db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts`).get().n; } catch {}
  const sidecarPath = path.join(process.env.ROBOTDOJO_ANN_DIR, 'sidecar.json');
  let staleAnnSidecar = false;
  if (fs.existsSync(sidecarPath)) {
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    staleAnnSidecar = sidecar.dim !== EXPECTED_DIM || sidecar.model_id !== MODEL_ID;
  }
  return {
    chunkCount: rows.length,
    rawJson: JSON.stringify(rows),
    ftsCount,
    vecTables,
    oldVecTables: vecTables.filter(t => /float\[3072\]/.test(t.sql || '')).map(t => t.name),
    staleAnnSidecar,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}
