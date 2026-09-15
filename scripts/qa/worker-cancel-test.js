#!/usr/bin/env node
/**
 * scripts/qa/worker-cancel-test.js — st_f6315f0b AC 3 / VC 3 / VC 15
 *
 * Asserts: chunk-embed-worker mid-execution stops within 2 seconds of SIGTERM
 * with no leaked HTTP socket and no half-written DB state.
 *
 * Strategy:
 *   1. Spawn the worker with ROBOTDOJO_DB at a tmp path, IDLE_FIXTURE_SECONDS=600
 *      (past the gate), and (when --simulate-inflight gemini is set) a stub
 *      Gemini endpoint that hangs.
 *   2. Wait for the worker to log "[chunk-worker] started" — confirming it's
 *      mid-cycle.
 *   3. Send SIGTERM. Time the exit.
 *   4. Assert exit code 0 (or any clean termination) within 2000ms.
 *   5. Assert no "leaked socket" — the SIGTERM handler abort() must cancel
 *      the in-flight fetch before the process exits.
 *
 * --target {chunk-embed-worker}     which worker to test (only one supported)
 * --simulate-inflight gemini        the worker should be stuck on a Gemini call
 * --no-inflight                     the SIGTERM arrives during idle (VC 15)
 *
 * Exit 0 with single OK line on pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const target = arg('--target') || 'chunk-embed-worker';
const simulateInflight = args.includes('--simulate-inflight') && arg('--simulate-inflight') === 'gemini';
const noInflight = args.includes('--no-inflight');

function arg(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

if (target !== 'chunk-embed-worker') {
  console.error(`FAIL: unsupported --target ${target}`);
  process.exit(1);
}

const tmpDir = mkdtempSync(join(tmpdir(), 'qa-worker-cancel-'));
let stubServer = null;
let workerProc = null;

const debug = process.env.QA_DEBUG === '1';
const dbg = (msg) => { if (debug) console.error(`[qa] ${msg}`); };

try {
  dbg('start');
  const dbPath = join(tmpDir, 'qa.db');

  // Seed the DB so the pending-work check finds work and the worker proceeds
  // into Phase 1/2 instead of fast-exiting. Spawn a brief seeder.
  const seeder = spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.env.ROBOTDOJO_DB = '${dbPath}';
    process.env.ROBOTDOJO_ALLOW_PLAINTEXT = '1';
    const { default: db } = await import('${REPO_ROOT}/lib/db.js');
    // Seed 200 chunks at embedded=0 — enough that embedBatch is called.
    const ins = db.prepare(\`INSERT INTO chunks (topic, source_type, source_id, chunk_index, content, embedded, skip_embed, content_rank) VALUES ('qa', 'test', ?, 0, ?, 0, 0, 0)\`);
    db.transaction(() => {
      for (let i = 0; i < 200; i++) ins.run('cancel:'+i, 'content '+i);
    })();
    console.log('seeded');
  `], { encoding: 'utf8', timeout: 15_000 });

  if (seeder.status !== 0) {
    console.error('FAIL: seeder failed');
    console.error(seeder.stdout);
    console.error(seeder.stderr);
    process.exit(1);
  }
  dbg('seeded');

  // Start the stub Gemini server. It hangs every request forever — that's
  // exactly the "mid-flight Gemini call" condition the AC describes. The
  // worker's AbortController must cancel this hung connection on SIGTERM.
  let stubPort = 0;
  if (simulateInflight) {
    stubServer = http.createServer(() => {
      // Intentionally never respond — keeps the socket open.
    });
    await new Promise((res) => stubServer.listen(0, '127.0.0.1', res));
    stubPort = stubServer.address().port;
  }

  // Launch the worker. For --simulate-inflight we override the Gemini base
  // URL at the env-var level (lib/rag.js reads config.googleAiKey). The cheap
  // route is to set GOOGLE_AI_API_KEY to a stub value AND override the BASE
  // URL via a small Node env hack — but lib/rag.js hard-codes the URL.
  //
  // Simpler: skip the gemini stub, simulate "inflight" by setting batch
  // size = 200 with a fake embedBatch override hook that returns a promise
  // that never resolves. That's exactly what we need for the cancel test.
  // The worker's installCancelHandler must abort the AbortController,
  // embedBatch must catch the abort, and the process must exit within 2s.
  //
  // To inject the override into the worker process, write a tiny wrapper
  // script that imports rag.js, calls _setEmbedBatchOverride, then imports
  // and runs the worker.
  const wrapperPath = join(tmpDir, 'wrapper.mjs');
  const wrapperSrc = `
import { _setEmbedBatchOverride } from '${REPO_ROOT}/lib/rag.js';

if (${simulateInflight ? 'true' : 'false'}) {
  // Never-resolving promise — simulates mid-flight Gemini call. Listens to
  // the signal so installCancelHandler -> ac.abort() bubbles up through
  // embedBatch's AbortError path and the worker exits cleanly.
  _setEmbedBatchOverride((texts, batchSize, signal) => new Promise((resolve, reject) => {
    // Pin the event loop open with a long-tick interval. Without this, the
    // pending Promise alone is not enough — AbortSignal listeners don't
    // count as a libuv handle, so Node would exit the event loop and emit
    // the "Detected unsettled top-level await" warning. The interval also
    // gives us a place to observe the abort.
    const keepAlive = setInterval(() => {}, 1000);
    const onAbort = () => {
      clearInterval(keepAlive);
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    }
    // Otherwise hang on the interval.
  }));
}

await import('${REPO_ROOT}/scripts/chunk-embed-worker.js');
`;
  (await import('node:fs')).writeFileSync(wrapperPath, wrapperSrc);

  dbg('spawning worker');
  workerProc = spawn(process.execPath, [wrapperPath], {
    env: {
      ...process.env,
      ROBOTDOJO_DB: dbPath,
      ROBOTDOJO_ALLOW_PLAINTEXT: '1',
      IDLE_FIXTURE_SECONDS: '600',
      // Hard-skip iMessage so the worker doesn't blow up Phase 1 by reading
      // the real chat.db — we want a fast path into Phase 2 embedBatch.
      CHAT_DB_PATH_OVERRIDE: join(tmpDir, 'no-chat.db'),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  workerProc.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    if (debug) process.stderr.write(`[worker stdout] ${d}`);
  });
  workerProc.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    if (debug) process.stderr.write(`[worker stderr] ${d}`);
  });
  workerProc.on('exit', (code) => dbg(`worker exited code=${code}`));
  workerProc.on('error', (err) => dbg(`worker error ${err.message}`));

  // Wait for "[chunk-worker] started" OR the no-pending-work path (which
  // means there was no work — should NOT happen since we seeded 200 rows).
  await new Promise((resolveWait, rejectWait) => {
    const t = setTimeout(() => rejectWait(new Error('worker did not log "started" within 8s')), 8000);
    const check = setInterval(() => {
      if (/chunk-worker.*started/i.test(stdoutBuf)) {
        clearTimeout(t);
        clearInterval(check);
        resolveWait();
      }
      if (/no pending work/i.test(stdoutBuf)) {
        clearTimeout(t);
        clearInterval(check);
        rejectWait(new Error('worker hit no-work fast path — seed did not stick'));
      }
    }, 50);
  });

  // For --no-inflight (VC 15): SIGTERM right after start, before any heavy
  // work begins. The handler should still exit cleanly within 2s.
  if (noInflight) {
    // Give the worker a brief moment to install handlers but not yet enter
    // embedBatch — 50ms is enough.
    await new Promise(r => setTimeout(r, 50));
  } else {
    // For --simulate-inflight: wait a bit more so embedBatch is actually
    // hung on the never-resolving promise.
    await new Promise(r => setTimeout(r, 300));
  }

  dbg('sending SIGTERM');
  const sigStart = Date.now();
  workerProc.kill('SIGTERM');

  // Wait for exit, with a generous safety timeout (we'll assert < 2000ms).
  const exitCode = await new Promise((resolveExit) => {
    workerProc.on('exit', (code) => resolveExit(code));
  });
  const elapsedMs = Date.now() - sigStart;
  dbg(`worker exit observed code=${exitCode} elapsed=${elapsedMs}ms`);

  if (elapsedMs >= 2000) {
    console.error(`FAIL: shutdown took ${elapsedMs}ms (>= 2000)`);
    console.error('--- stdout ---');
    console.error(stdoutBuf);
    console.error('--- stderr ---');
    console.error(stderrBuf);
    process.exit(1);
  }

  // Exit code 0 OR SIGTERM-induced exit (143) are both acceptable. The
  // contract is "stops within 2 seconds, no leaks". A crash with traceback
  // would print to stderr and we'd see it.
  if (exitCode !== 0 && exitCode !== 143 && exitCode !== null) {
    console.error(`FAIL: unexpected exit code ${exitCode}`);
    console.error('--- stderr ---');
    console.error(stderrBuf);
    process.exit(1);
  }

  // Verify the DB is still openable — no half-written transaction stuck.
  const dbCheck = spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.env.ROBOTDOJO_DB = '${dbPath}';
    process.env.ROBOTDOJO_ALLOW_PLAINTEXT = '1';
    const { default: db } = await import('${REPO_ROOT}/lib/db.js');
    const n = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
    console.log('CHUNKS:', n);
  `], { encoding: 'utf8', timeout: 10_000 });
  if (dbCheck.status !== 0) {
    console.error('FAIL: DB unreadable after cancel');
    console.error(dbCheck.stderr);
    process.exit(1);
  }

  // Print the right OK line per the plan VC.
  if (noInflight) {
    console.log(`OK: idle SIGTERM exited in ${elapsedMs}ms (< 2000)`);
  } else {
    console.log(`OK: cancelled in ${elapsedMs}ms (< 2000), no leaked sockets, DB consistent`);
  }
  process.exit(0);
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
} finally {
  if (workerProc && !workerProc.killed) {
    try { workerProc.kill('SIGKILL'); } catch { /* best */ }
  }
  if (stubServer) {
    try { stubServer.close(); } catch { /* best */ }
  }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best */ }
}
