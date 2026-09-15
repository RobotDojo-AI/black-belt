#!/usr/bin/env node
/**
 * Static installer/readiness smoke for local embedding provisioning.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL_ID = 'Snowflake/snowflake-arctic-embed-l-v2.0';
const MIN_DISK_MB = 2048;
const failures = [];

function read(rel) {
  const abs = path.join(REPO_ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
}

const pkg = JSON.parse(read('package.json'));
if (!pkg.dependencies?.['@huggingface/transformers']) {
  failures.push('package.json must include @huggingface/transformers in dependencies');
}

for (const rel of ['apps/static/install.sh']) {
  const text = read(rel);
  const syntax = spawnSync('bash', ['-n', rel], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (syntax.status !== 0) failures.push(`${rel}: bash -n failed: ${syntax.stderr.trim()}`);

  const floor = text.match(/\bMIN_DISK_MB=(\d+)/);
  if (!floor) failures.push(`${rel}: MIN_DISK_MB is missing`);
  else if (Number(floor[1]) < MIN_DISK_MB) failures.push(`${rel}: MIN_DISK_MB=${floor[1]} below ${MIN_DISK_MB}`);

  if (!text.includes(MODEL_ID)) failures.push(`${rel}: installer must name ${MODEL_ID}`);
  if (!/(prewarm|warm).*embed|embed.*(prewarm|warm)|local-embedding-smoke|local-embed/i.test(text)) {
    failures.push(`${rel}: installer must run a local embedding model prewarm step`);
  }
}

const readinessText = [
  read('lib/setup-readiness.js'),
  read('routes/setup/index.js'),
  read('routes/setup.js'),
  read('apps/account/app.js'),
].join('\n');

if (!/local embedding|embedding model|embed model/i.test(readinessText)) {
  failures.push('setup/readiness surfaces must report local embedding model status');
}
if (!/retry|prewarm|download/i.test(readinessText)) {
  failures.push('setup/readiness surfaces must include a retry/prewarm path for the local embedding model');
}

const staticSmoke = read('scripts/qa/local-embedding-smoke.js');
if (!staticSmoke.includes('--offline')) {
  failures.push('scripts/qa/local-embedding-smoke.js must support --offline for target-machine QA');
}

const finishPipeline = read('scripts/ingest/finish-pipeline.sh');
if (!/node scripts\/build-global-hnsw\.js/.test(finishPipeline)) {
  failures.push('scripts/ingest/finish-pipeline.sh must build the global HNSW artifact before restart');
}
if (!/FATAL: HNSW build failed/.test(finishPipeline) || /server may fall back to per-topic/.test(finishPipeline)) {
  failures.push('scripts/ingest/finish-pipeline.sh must fail closed when HNSW build fails, not restart into degraded vector retrieval');
}
if (!/exit "\$rc"/.test(finishPipeline)) {
  failures.push('scripts/ingest/finish-pipeline.sh must exit with the HNSW build failure code');
}

if (failures.length) {
  console.error(`FAIL: installer local embedding smoke found ${failures.length} issue(s)`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`OK: installer provisions and readiness reports ${MODEL_ID}`);
