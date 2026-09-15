#!/usr/bin/env node
/**
 * Restore-proof for GCP private backup.
 *
 * This is intentionally stricter than a backup dry-run: it downloads real
 * objects from the configured GCS bucket and compares restored bytes against
 * the local source files that should have been backed up.
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import config from '../lib/config.js';

const HOME = homedir();
const ROOT = join(HOME, 'robotdojo');
const BUCKET = config.gcsBucket;

const PROBES = [
  {
    name: 'context',
    local: 'user/contexts/topics/work/robot-dojo/context.md',
    remote: 'user/contexts/topics/work/robot-dojo/context.md',
  },
  {
    name: 'workbench',
    local: 'user/workbenches/topics/work/robot-dojo/wk_robot_dojo/INDEX.md',
    remote: 'user/workbenches/topics/work/robot-dojo/wk_robot_dojo/INDEX.md',
  },
  {
    // st_9699c94f: permanent restore-proof for the RELOCATED dev pipeline.
    // kanban.md is the live operating map — proving it round-trips byte-identical
    // gives the founder's pipeline the same durability guarantee any customer's
    // workbench data gets (customer parity, AC9).
    name: 'pipeline-workbench',
    local: 'user/workbenches/topics/work/robot-dojo/wk_robot_dojo/kanban.md',
    remote: 'user/workbenches/topics/work/robot-dojo/wk_robot_dojo/kanban.md',
  },
  {
    name: 'transcripts',
    local: 'user/transcripts/.gitignore',
    remote: 'user/transcripts/.gitignore',
  },
];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fail(message) {
  console.error(`[restore-proof] FAIL: ${message}`);
  process.exit(1);
}

if (!BUCKET) fail('GCS bucket is not configured');

const which = spawnSync('which', ['gcloud'], { encoding: 'utf8' });
if (which.status !== 0) fail('gcloud is not on PATH');

const restoreRoot = mkdtempSync(join(tmpdir(), 'robotdojo-gcs-restore-proof-'));
const results = [];

for (const probe of PROBES) {
  const localPath = join(ROOT, probe.local);
  if (!existsSync(localPath)) fail(`local probe missing: ${probe.local}`);

  const restorePath = join(restoreRoot, probe.local);
  mkdirSync(dirname(restorePath), { recursive: true });

  const remotePath = `${BUCKET}/${probe.remote}`;
  const cp = spawnSync('gcloud', ['storage', 'cp', remotePath, restorePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (cp.status !== 0) {
    fail(`could not restore ${probe.name} from ${remotePath}: ${cp.stderr.trim() || cp.stdout.trim()}`);
  }

  const localSha = sha256(localPath);
  const restoredSha = sha256(restorePath);
  if (localSha !== restoredSha) {
    fail(`sha mismatch for ${probe.name}: local=${localSha} restored=${restoredSha}`);
  }
  results.push({ name: probe.name, remote: remotePath, sha256: localSha });
}

console.log(JSON.stringify({
  ok: true,
  restored: results.length,
  restore_root: restoreRoot,
  probes: results,
}, null, 2));
