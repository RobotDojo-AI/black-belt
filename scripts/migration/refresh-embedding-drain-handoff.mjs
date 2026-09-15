#!/usr/bin/env node
/**
 * Refresh a completed embedding-drain handoff without starting another writer.
 *
 * This is intentionally narrower than the guarded drain launcher. It only
 * extends freshness for an already-successful zero-backlog handoff after
 * re-checking the live DB and writer hold.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const ROOT = process.env.ROBOTDOJO_HOME || resolve(homedir(), 'robotdojo');
const CONFIG_DIR = process.env.ROBOTDOJO_CONFIG || resolve(homedir(), '.robotdojo');
const HANDOFF_FILE = process.env.ROBOTDOJO_DRAIN_HANDOFF_FILE
  || resolve(CONFIG_DIR, 'runtime', 'embedding-drain-handoff.json');

const args = parseArgs(process.argv.slice(2));
const resultFile = args.resultFile || process.env.ROBOTDOJO_DRAIN_HANDOFF_REFRESH_RESULT_FILE || null;
const jsonOutput = args.json === true;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      out.json = true;
    } else if (arg === '--result-file') {
      out.resultFile = argv[++i];
    } else if (arg.startsWith('--result-file=')) {
      out.resultFile = arg.slice('--result-file='.length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function atomicWriteJson(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function launchdLabelAbsent(label) {
  if (!label) return { ok: true, required: false, reason: 'no_label' };
  const result = spawnSync('launchctl', ['list'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      required: true,
      reason: 'launchctl_list_failed',
      status: result.status,
      stderr: String(result.stderr || '').trim(),
    };
  }
  const present = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => line.split(/\s+/).at(-1) === label);
  return {
    ok: !present,
    required: true,
    reason: present ? 'label_still_present' : 'label_absent',
    label,
  };
}

function existingHandoffFailures(handoff) {
  const failures = [];
  if (handoff?.ok !== true) failures.push('handoff ok flag is not true');
  if (handoff?.status !== 'ready_for_reclassify') failures.push('handoff status is not ready_for_reclassify');
  if (handoff?.child_ok !== true) failures.push('handoff child_ok flag is not true');
  if (Number(handoff?.pending_embeddings) !== 0) failures.push('handoff pending embeddings is not zero');
  if (handoff?.pending_count_error) failures.push(`handoff pending count error: ${handoff.pending_count_error}`);
  if (!handoff?.checked_at || Number.isNaN(Date.parse(String(handoff.checked_at)))) {
    failures.push('handoff checked_at is missing or invalid');
  }
  return failures;
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

async function activeWriterHoldFailure() {
  const { readEmbedPauseHold } = await import(resolve(ROOT, 'lib/embed-pause-hold.js'));
  const hold = readEmbedPauseHold({ maxCacheMs: 0 });
  if (hold?.active !== true) return null;
  const reason = hold.reason || hold.hold?.reason || 'unknown';
  return `embed writer hold is active (${reason})`;
}

async function main() {
  const startedAt = new Date().toISOString();
  const handoff = readJson(HANDOFF_FILE);
  const failures = existingHandoffFailures(handoff);

  const pending = await pendingBacklogCount();
  if (pending !== 0) failures.push(`live pending embeddings is not zero (${pending})`);

  const holdFailure = await activeWriterHoldFailure();
  if (holdFailure) failures.push(holdFailure);

  const launchd = handoff?.launchd_remove?.ok === true
    ? { ok: true, reason: 'handoff_remove_ok', label: handoff.launchd_label || null }
    : launchdLabelAbsent(handoff?.launchd_label || null);
  if (launchd.ok !== true) failures.push(`temporary drain launchd label is not clear (${launchd.reason || 'unknown'})`);

  const now = new Date().toISOString();
  const result = {
    ok: failures.length === 0,
    action: 'refresh_embedding_drain_handoff',
    handoff_file: HANDOFF_FILE,
    started_at: startedAt,
    checked_at: now,
    previous_checked_at: handoff?.checked_at || null,
    pending_embeddings: pending,
    launchd_clearance: launchd,
    failures,
  };

  if (result.ok) {
    atomicWriteJson(HANDOFF_FILE, {
      ...handoff,
      ok: true,
      status: 'ready_for_reclassify',
      child_ok: true,
      pending_embeddings: pending,
      pending_count_error: null,
      checked_at: now,
      refresh: {
        action: 'refresh_embedding_drain_handoff',
        previous_checked_at: handoff.checked_at,
        checked_at: now,
        pid: process.pid,
      },
    });
  }
  if (resultFile) atomicWriteJson(resultFile, result);
  if (jsonOutput) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
  const payload = {
    ok: false,
    action: 'refresh_embedding_drain_handoff',
    handoff_file: HANDOFF_FILE,
    checked_at: new Date().toISOString(),
    error: err?.message || String(err),
  };
  if (resultFile) {
    try { atomicWriteJson(resultFile, payload); } catch {}
  }
  if (jsonOutput) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
