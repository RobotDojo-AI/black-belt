#!/usr/bin/env node
/**
 * Loads the Snowflake embedding model and embeds one query/document pair.
 *
 * Use --offline after installer prewarm. In offline mode, this script disables
 * remote model fetches and fails before pipeline construction when the cache is
 * obviously absent, producing a clear installer/remediation error.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODEL_ID = 'Snowflake/snowflake-arctic-embed-l-v2.0';
const EXPECTED_DIM = 1024;
const DTYPE = 'q8';
const args = new Set(process.argv.slice(2));
const offline = args.has('--offline');
const cacheDir = path.resolve(
  process.env.ROBOTDOJO_EMBED_CACHE_DIR
    || process.env.TRANSFORMERS_CACHE
    || path.join(os.homedir(), '.robotdojo', 'models', 'embeddings'),
);

function fail(message, detail = '') {
  console.error(`FAIL: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function hasLikelyCache(dir) {
  if (!fs.existsSync(dir)) return false;
  const needle = 'snowflake-arctic-embed-l-v2.0';
  const stack = [dir];
  let visited = 0;
  while (stack.length && visited < 5000) {
    const current = stack.pop();
    visited++;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.name.toLowerCase().includes(needle)) return true;
      if (entry.isDirectory()) stack.push(full);
    }
  }
  return false;
}

if (offline && !hasLikelyCache(cacheDir)) {
  fail(
    `offline cache missing for ${MODEL_ID}`,
    `Expected a prewarmed Transformers.js cache under ${cacheDir}. Run installer prewarm or this smoke without --offline once.`,
  );
}

let transformers;
try {
  transformers = await import('@huggingface/transformers');
} catch (err) {
  fail(
    '@huggingface/transformers is not installed',
    'Add it as a production dependency and run npm install before the local embedding smoke.',
  );
}

const { pipeline, env } = transformers;
env.cacheDir = cacheDir;
env.allowLocalModels = true;
env.allowRemoteModels = !offline;

let extractor;
try {
  extractor = await pipeline('feature-extraction', MODEL_ID, {
    cache_dir: cacheDir,
    local_files_only: offline,
    dtype: DTYPE,
    device: 'cpu',
  });
} catch (err) {
  fail(
    `could not load ${MODEL_ID}${offline ? ' from local cache' : ''}`,
    err?.stack || String(err),
  );
}

async function embed(text) {
  const out = await extractor(text, { pooling: 'mean', normalize: true });
  const values = Array.from(out.data || out.tolist?.()?.flat?.() || []);
  if (values.length !== EXPECTED_DIM) {
    fail(`unexpected embedding dimension ${values.length}; expected ${EXPECTED_DIM}`);
  }
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (!Number.isFinite(norm) || norm < 0.9 || norm > 1.1) {
    fail(`embedding norm out of range: ${norm}`);
  }
  return values;
}

const query = await embed('query: Robot Dojo local retrieval calibration');
const document = await embed('Robot Dojo local retrieval calibration document');

const dot = query.reduce((sum, v, i) => sum + v * document[i], 0);
if (!Number.isFinite(dot)) fail('query/document cosine is not finite');

console.log(`OK: ${MODEL_ID} loaded ${offline ? 'offline' : 'with cache/prewarm allowed'} (${EXPECTED_DIM} dims, dtype=${DTYPE}, cache=${cacheDir})`);
