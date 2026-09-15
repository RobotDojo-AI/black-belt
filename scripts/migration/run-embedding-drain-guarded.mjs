#!/usr/bin/env node
/**
 * Guarded launcher for the temporary embedding catch-up drain.
 *
 * The drain itself owns embedding behavior. This wrapper owns lifecycle:
 *   - forwards SIGINT/SIGTERM to the child drain,
 *   - writes a handoff marker after the child exits,
 *   - removes the temporary launchd label only when the embeddable backlog is zero.
 *
 * Why this exists: `launchctl submit` jobs are KeepAlive-like in practice. A plain
 * temporary drain can complete, exit 0, and be respawned, reacquiring the writer
 * hold instead of handing ownership back to the product `chunk-embed-daemon`.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const ROOT = process.env.ROBOTDOJO_HOME || resolve(homedir(), 'robotdojo');
const CONFIG_DIR = process.env.ROBOTDOJO_CONFIG || resolve(homedir(), '.robotdojo');
const HANDOFF_FILE = process.env.ROBOTDOJO_DRAIN_HANDOFF_FILE
  || resolve(CONFIG_DIR, 'runtime', 'embedding-drain-handoff.json');
const LAUNCHD_LABEL = process.env.ROBOTDOJO_DRAIN_REMOVE_LAUNCHD_LABEL || '';
const drainArgs = process.argv.slice(2);
const DRAIN_SCRIPT = resolve(ROOT, 'scripts/migration/drain-personal-embeddings.mjs');

function writeHandoff(payload) {
  mkdirSync(dirname(HANDOFF_FILE), { recursive: true });
  const tmp = `${HANDOFF_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, HANDOFF_FILE);
}

async function pendingBacklogCount() {
  const { default: db } = await import(resolve(ROOT, 'lib/db.js'));
  try {
    return Number(db.prepare(`
      SELECT COUNT(*) AS n
      FROM chunks
      WHERE COALESCE(embedded, 0) = 0
        AND COALESCE(skip_embed, 0) = 0
    `).get()?.n || 0);
  } finally {
    try { db.close?.(); } catch {}
  }
}

function removeLaunchdLabel(label) {
  if (!label) return { attempted: false, ok: false, reason: 'no_label' };
  const result = spawnSync('launchctl', ['remove', label], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    attempted: true,
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

if (!existsSync(DRAIN_SCRIPT)) {
  writeHandoff({
    ok: false,
    status: 'missing_drain_script',
    args: drainArgs,
    checked_at: new Date().toISOString(),
  });
  process.exit(1);
}

const child = spawn(process.execPath, [DRAIN_SCRIPT, ...drainArgs], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});

let terminating = false;
let terminatingSignal = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    terminating = true;
    terminatingSignal = signal;
    try { child.kill(signal); } catch {}
  });
}

child.on('error', async (err) => {
  writeHandoff({
    ok: false,
    status: 'spawn_failed',
    error: err?.message || String(err),
    args: drainArgs,
    checked_at: new Date().toISOString(),
  });
  process.exit(1);
});

child.on('close', async (code, signal) => {
  let pending = null;
  let countError = null;
  try {
    pending = await pendingBacklogCount();
  } catch (err) {
    countError = err?.message || String(err);
  }

  const drained = code === 0 && pending === 0;
  const status = drained
    ? 'ready_for_reclassify'
    : terminating
      ? 'terminated'
      : code === 0
        ? 'draining'
        : 'failed';
  const payload = {
    ok: drained,
    status,
    child_ok: code === 0,
    pending_embeddings: pending,
    pending_count_error: countError,
    child: {
      code,
      signal: signal || null,
    },
    launchd_label: LAUNCHD_LABEL || null,
    launchd_remove: { attempted: false, ok: false, reason: drained ? 'pending' : 'not_drained' },
    args: drainArgs,
    next_steps: drained ? [
      'run scripts/migration/run-post-embedding-drain-pipeline.mjs --watch',
    ] : [],
    checked_at: new Date().toISOString(),
  };
  writeHandoff(payload);

  if (drained) {
    const removal = removeLaunchdLabel(LAUNCHD_LABEL);
    try {
      writeHandoff({
        ...payload,
        launchd_remove: removal,
        checked_at: new Date().toISOString(),
      });
    } catch {
      /* removing our own launchd job can terminate this process; the pre-remove
       * handoff marker above is the durable evidence. */
    }
  }

  if (drained) process.exit(0);
  if (terminating) process.exit(terminatingSignal === 'SIGINT' ? 130 : 143);
  if (signal) process.exit(signal === 'SIGINT' ? 130 : 143);
  process.exit(Number(code) || 1);
});
