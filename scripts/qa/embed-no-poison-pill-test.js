#!/usr/bin/env node
/**
 * scripts/qa/embed-no-poison-pill-test.js — st_f6315f0b AC 8 / VC 8
 *
 * Asserts: embedChunks advances every queued chunk in a single run, even
 * when some chunks already have a row in the target vec table — i.e. no
 * sqlite-vec UNIQUE poison-pill loop, no rows stuck at embedded=0, no
 * "UNIQUE constraint failed" lines.
 *
 * Strategy:
 *   1. Spawn ourselves in a child process with ROBOTDOJO_DB pointed at a
 *      mktemp -d DB AND ROBOTDOJO_ALLOW_PLAINTEXT=1 — so importing lib/db.js
 *      gets an isolated DB and never touches the live corpus.
 *   2. Inside the child, _setEmbedBatchOverride is called with a stub that
 *      returns deterministic Float32Arrays — exercises the real embedChunks
 *      code path WITHOUT any Gemini network call.
 *   3. Seed 10 chunks at embedded=0. Pre-populate the chunk_vec_qa table
 *      with rows for chunks 1, 3, 5, 7, 9 — these are the chunks that would
 *      have poison-pilled under INSERT OR REPLACE.
 *   4. Call embedChunks('qa').
 *   5. Assert: every row advances to embedded=1, every chunk_id appears in
 *      chunk_vec_qa, and stderr is silent on UNIQUE errors.
 *
 * WHY a child process: lib/db.js opens the DB at module-load time using
 *   process.env.ROBOTDOJO_DB. Setting the env in-process is too late.
 *
 * Exit 0 with single OK line on pass.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// If we're the child process (CHILD=1), run the real test logic.
if (process.env.QA_POISON_PILL_CHILD === '1') {
  await runChild();
  process.exit(0);
}

// Parent: create tmp DB path, fork the child with env, capture stdout/stderr.
const tmpDir = mkdtempSync(join(tmpdir(), 'qa-poison-pill-'));
try {
  // ROBOTDOJO_DB must be under ~/robotdojo/user/databases/ OR set
  // ROBOTDOJO_ALLOW_PLAINTEXT=1 to opt out of encryption guard.
  const dbPath = join(tmpDir, 'qa.db');
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      ...process.env,
      QA_POISON_PILL_CHILD: '1',
      ROBOTDOJO_DB: dbPath,
      ROBOTDOJO_ALLOW_PLAINTEXT: '1',
      // Suppress any stray "BB inactive" or cohort gating noise.
      NODE_ENV: 'test',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });

  if (result.status !== 0) {
    console.error(`FAIL: child exited ${result.status}`);
    console.error('--- child stdout ---');
    console.error(result.stdout);
    console.error('--- child stderr ---');
    console.error(result.stderr);
    process.exit(1);
  }

  // Negative assertion: UNIQUE constraint failed must not appear anywhere.
  if (/UNIQUE constraint failed/i.test(result.stdout + result.stderr)) {
    console.error('FAIL: UNIQUE constraint error in child output');
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(1);
  }

  // Surface the OK line from the child.
  const ok = result.stdout.match(/^OK: .*$/m);
  if (!ok) {
    console.error('FAIL: child did not emit OK line');
    console.error(result.stdout);
    process.exit(1);
  }
  console.log(ok[0]);
  process.exit(0);
} finally {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function runChild() {
  // Import the real production modules — they pick up our ROBOTDOJO_DB.
  const { default: db } = await import(`${REPO_ROOT}/lib/db.js`);
  const rag = await import(`${REPO_ROOT}/lib/rag.js`);
  const { embedChunks } = await import(`${REPO_ROOT}/lib/rag/embed.js`);
  const EMBED_DIM = rag.EMBED_DIM;

  // 1. Install the embedBatch stub — returns one zero-vector per text.
  rag._setEmbedBatchOverride((texts) =>
    Promise.resolve(texts.map(() => new Float32Array(EMBED_DIM))),
  );

  // 2. Ensure chunks table has the columns embedChunks expects. The full
  //    migration set runs on db.js import, so chunks should exist already.
  //    If not (fresh tmp DB without inline migrate), create minimally.
  const hasChunks = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chunks'",
  ).get();
  if (!hasChunks) {
    db.exec(`
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY,
        topic TEXT,
        source_type TEXT,
        source_id TEXT,
        chunk_index INTEGER DEFAULT 0,
        content TEXT,
        is_starred INTEGER DEFAULT 0,
        content_rank INTEGER DEFAULT 3,
        event_time TEXT,
        embedded INTEGER DEFAULT 0,
        skip_embed INTEGER DEFAULT 0
      )
    `);
  }

  // 3. Seed 10 chunks at embedded=0 under topic 'qa'.
  const insChunk = db.prepare(`
    INSERT INTO chunks (id, topic, source_type, source_id, content, embedded, skip_embed)
    VALUES (?, 'qa', 'test', ?, ?, 0, 0)
  `);
  // Clear any prior state for re-runs.
  db.prepare(`DELETE FROM chunks WHERE topic = 'qa'`).run();
  for (let i = 1; i <= 10; i++) {
    insChunk.run(i, `qa:${i}`, `test content ${i}`);
  }

  // 4. Pre-populate chunk_vec_qa with rows for chunks 1, 3, 5, 7, 9. These
  //    would have caused UNIQUE constraint failures under the old INSERT OR
  //    REPLACE code path.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec_qa USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${EMBED_DIM}])`);
  const preVec = db.prepare(`INSERT INTO chunk_vec_qa(chunk_id, embedding) VALUES (?, ?)`);
  const zeroBuf = Buffer.alloc(EMBED_DIM * 4);
  for (const id of [1, 3, 5, 7, 9]) preVec.run(String(id), zeroBuf);

  // 5. Run the production embedChunks. If the upsert is still INSERT OR
  //    REPLACE, the first batch would throw UNIQUE — let it surface to
  //    the parent which checks stderr.
  await embedChunks('qa');

  // 6. Assertions.
  const stuck = db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE topic='qa' AND embedded=0 AND skip_embed=0`).get();
  if (stuck.n !== 0) {
    console.error(`FAIL: ${stuck.n} chunks stuck at embedded=0`);
    process.exit(1);
  }
  const advanced = db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE topic='qa' AND embedded=1`).get();
  if (advanced.n !== 10) {
    console.error(`FAIL: ${advanced.n}/10 advanced (expected 10)`);
    process.exit(1);
  }
  const vecCount = db.prepare(`SELECT COUNT(*) AS n FROM chunk_vec_qa`).get();
  if (vecCount.n !== 10) {
    console.error(`FAIL: chunk_vec_qa has ${vecCount.n} rows (expected 10)`);
    process.exit(1);
  }

  // Single OK line — matches the plan VC regex exactly.
  console.log(`OK: 10/10 chunks advanced (0 stuck at embedded=0, 0 UNIQUE errors)`);
}
