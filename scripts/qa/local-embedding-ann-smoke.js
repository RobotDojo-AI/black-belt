#!/usr/bin/env node
/**
 * Static ANN smoke for the Snowflake 1024-dim cutover.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL_ID = 'Snowflake/snowflake-arctic-embed-l-v2.0';
const EXPECTED_DIM = 1024;
const failures = [];

function read(rel) {
  const abs = path.join(REPO_ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
}

const annText = [
  read('lib/ann/matryoshka.js'),
  read('lib/ann/ann-config.js'),
  read('lib/ann/usearch-adapter.js'),
].join('\n');
const ragText = [
  read('lib/rag.js'),
  read('lib/rag/local-embed.js'),
].join('\n');

const hnswLiteral = new RegExp(`\\bHNSW_DIMS\\s*=\\s*${EXPECTED_DIM}\\b`).test(annText);
const hnswFromEmbedDim = /\bHNSW_DIMS\s*=\s*EMBED_DIM\b/.test(annText)
  && new RegExp(`\\b(?:LOCAL_)?EMBED_DIM\\s*=\\s*${EXPECTED_DIM}\\b`).test(ragText);
if (!hnswLiteral && !hnswFromEmbedDim) {
  failures.push(`ANN HNSW_DIMS must be ${EXPECTED_DIM}`);
}

for (const stale of [
  ['paid ANN text', new RegExp(`\\b${['gemini', 'embedding'].join('-')}|Gemini embeddings|Gemini vector`, 'i')],
  ['768-dim truncation', /\b768[- ]dim|HNSW_DIMS\s*=\s*768|truncateAndNormalize/i],
  ['3072-dim ANN assumptions', /\b3072[- ]dim|float\[3072\]/i],
]) {
  if (stale[1].test(annText)) failures.push(`${stale[0]} remains in ANN code`);
}

if (!annText.includes(MODEL_ID) && !/model_id|embedding_model_id|EMBED_MODEL_ID/.test(annText)) {
  failures.push('ANN sidecar/build path must record the embedding model id');
}

if (!/sidecar/i.test(annText) || !/dim\s*:\s*HNSW_DIMS|dim\s*:\s*EXPECTED_DIM|embedding_dim/i.test(annText)) {
  failures.push('ANN sidecar must record the 1024-dimensional embedding space');
}

const sidecar = process.env.ROBOTDOJO_ANN_SMOKE_SIDECAR;
if (sidecar && fs.existsSync(sidecar)) {
  const data = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  if (data.dim !== EXPECTED_DIM) failures.push(`${sidecar}: dim=${data.dim}, expected ${EXPECTED_DIM}`);
  if (data.model_id && data.model_id !== MODEL_ID) failures.push(`${sidecar}: model_id=${data.model_id}, expected ${MODEL_ID}`);
}

if (failures.length) {
  console.error(`FAIL: local embedding ANN smoke found ${failures.length} issue(s)`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`OK: ANN uses ${EXPECTED_DIM}-dim Snowflake embedding space`);
