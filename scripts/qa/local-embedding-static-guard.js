#!/usr/bin/env node
/**
 * Static guard for st_817a23c4.
 *
 * Fails when product/runtime surfaces still expose paid embedding models or
 * provider-owned embedding routes. The scanner intentionally ignores this QA
 * file and tests; those files need to name forbidden strings to assert them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL_ID = 'Snowflake/snowflake-arctic-embed-l-v2.0';
const EXPECTED_DIM = 1024;

const RUNTIME_DIRS = ['lib', 'routes', 'config', 'apps', 'scripts'];
const DOC_DIRS = ['docs'];
const IGNORE_PARTS = [
  `${path.sep}node_modules${path.sep}`,
  `${path.sep}scripts${path.sep}qa${path.sep}`,
  `${path.sep}tests${path.sep}`,
  `${path.sep}pipeline${path.sep}`,
  `${path.sep}apps${path.sep}static${path.sep}vendor${path.sep}`,
];

const GEMINI_EMBED = ['gemini', 'embedding'].join('-');
const GOOGLE_EMBED_HOST = ['generative', 'language'].join('');
const VERTEX_EMBED = ['text', 'embedding', '004'].join('-');
const OPENAI_EMBED = ['text', 'embedding', '3'].join('-');

const BANNED_RUNTIME = [
  ['Gemini embedding model', new RegExp(`\\b${GEMINI_EMBED}(?:-\\d+)?\\b`, 'i')],
  ['Gemini embedContent URL', new RegExp(`${GOOGLE_EMBED_HOST}\\.googleapis\\.com\\/[^\\s'"\\\`]+:embedContent`, 'i')],
  ['Gemini batchEmbedContents URL', new RegExp(`${GOOGLE_EMBED_HOST}\\.googleapis\\.com\\/[^\\s'"\\\`]+:batchEmbedContents`, 'i')],
  ['Vertex embedding model', new RegExp(`\\b${VERTEX_EMBED}\\b`, 'i')],
  ['OpenAI embedding model', new RegExp(`\\b${OPENAI_EMBED}-(small|large)\\b`, 'i')],
  ['OpenAI embeddings API', /(^|[^a-z])openai\.embeddings\.create\b|\/v1\/embeddings\b/i],
  ['Vertex embedding predict API', /aiplatform\.googleapis\.com\/[^\s'"`]+(embed|predict)/i],
];

const BANNED_DOCS = [
  ['provider-owned embedding contract', /\b(provider\.)?embed\(/i],
  ['paid embedding model in provider docs', new RegExp(`\\b(${GEMINI_EMBED}|${VERTEX_EMBED}|${OPENAI_EMBED}-(small|large))\\b`, 'i')],
];

const failures = [];

function walk(dir) {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const stack = [abs];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (IGNORE_PARTS.some(part => full.includes(part))) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(js|mjs|cjs|json|md|sh|sql|html|txt)$/i.test(entry.name)) out.push(full);
    }
  }
  return out;
}

function scanFiles(files, rules) {
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const [label, re] of rules) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          failures.push(`${rel}:${i + 1}: ${label}: ${lines[i].trim().slice(0, 180)}`);
        }
      }
    }
  }
}

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

scanFiles(RUNTIME_DIRS.flatMap(walk), BANNED_RUNTIME);
scanFiles(DOC_DIRS.flatMap(walk), BANNED_DOCS);

const pkg = JSON.parse(read('package.json'));
if (!pkg.dependencies?.['@huggingface/transformers']) {
  failures.push('package.json: @huggingface/transformers must be a production dependency');
}

const configText = read('lib/config.js');
if (!configText.includes(MODEL_ID)) {
  failures.push(`lib/config.js: config.models.embed must resolve to ${MODEL_ID}`);
}

const ragText = fs.existsSync(path.join(REPO_ROOT, 'lib/rag.js')) ? read('lib/rag.js') : '';
const localText = fs.existsSync(path.join(REPO_ROOT, 'lib/rag/local-embed.js'))
  ? read('lib/rag/local-embed.js')
  : '';
if (!new RegExp(`EMBED_DIM\\s*=\\s*${EXPECTED_DIM}\\b`).test(`${ragText}\n${localText}`)) {
  failures.push(`lib/rag.js or lib/rag/local-embed.js: EMBED_DIM must be ${EXPECTED_DIM}`);
}
if (!`${ragText}\n${localText}`.includes(MODEL_ID)) {
  failures.push(`embedding runtime must name ${MODEL_ID}`);
}

if (failures.length) {
  console.error(`FAIL: local embedding static guard found ${failures.length} issue(s)`);
  for (const failure of failures.slice(0, 80)) console.error(`- ${failure}`);
  if (failures.length > 80) console.error(`- ... ${failures.length - 80} more`);
  process.exit(1);
}

console.log(`OK: local-only embedding static guard passed (${MODEL_ID}, ${EXPECTED_DIM} dims)`);
