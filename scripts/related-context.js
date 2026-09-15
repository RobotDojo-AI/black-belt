#!/usr/bin/env node
/**
 * scripts/related-context.js — st_34daf3fd
 *
 * Compute tier: Tier 0 (local structural + local ONNX cosine). No LLM on the
 * path — no getAnthropicClient, no MODELS.*; $0, no API, no daemon. It reuses the
 * existing local embedder (lib/rag.js) and brute-force cosine over ~1772 vectors
 * (a full-scan access pattern, not an ANN problem at this scale). It never writes
 * to the memory log and never LLM-summarizes — it SELECTS, RANKS, and marks story
 * supersession, emitting deterministic snippets + JIT pointers. The specialist
 * (Tantei/Ori/Katagami) reads the pointed artifacts and writes the synthesis.
 *
 * The retriever hands research, plan, AND build a small, ranked, supersession-aware
 * set of the most relevant prior context — past stories/defects/work items PLUS the
 * distilled memory-log lessons — selected by semantic relevance over the whole
 * corpus. Records with no file-touch tags are still found by their text; overturned
 * story decisions are flagged; memory lessons surface by recency; and when nothing
 * relevant exists it says so plainly.
 *
 *   node scripts/related-context.js --story <id> [--top-n 8] [--mem-top-n 5]
 *        [--format markdown|json] [--min-cosine 0.33] [--min-lexical 2]
 *        [--reindex] [--rebuild] [--terms "a,b,c"]
 *
 * Exit 0 on every normal outcome including "nothing relevant"; non-zero only on a
 * genuine usage error, so a stage run never blocks on it.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  PIPELINE_STORIES_DIR,
  PIPELINE_RETRIEVAL_INDEX_PATH,
  USER_MEMORY_DIR,
} from '../lib/robotdojo-paths.js';
import {
  embedBatch,
  safeEmbed,
  cosineSimilarity,
  contentHash,
  vectorToBuffer,
  localEmbeddingModelStatus,
  EMBED_MODEL,
  EMBED_DIM,
} from '../lib/rag.js';
import { embedInputCharCap } from '../lib/rag/local-embed.js';
import { gather } from '../lib/distill-sources/memory-log.js';

// Bumping this when the record schema or embed_text changes forces a rebuild via
// the model/dim/version guard. v2 = the memory corpus was folded into the sidecar
// that previously held story records only.
const INDEX_VERSION = 2;

// Tunable knobs — every one env-overridable, no un-tunable literal (build convention).
const DEFAULTS = {
  topN: numEnv('ROBOTDOJO_RELATED_TOP_N', 8),
  memTopN: numEnv('ROBOTDOJO_RELATED_MEM_TOP_N', 5),
  minCosine: floatEnv('ROBOTDOJO_RELATED_MIN_COSINE', 0.33),
  minLexical: numEnv('ROBOTDOJO_RELATED_MIN_LEXICAL', 2),
  rrfK: numEnv('ROBOTDOJO_RELATED_RRF_K', 60),
  embedBatchSize: numEnv('ROBOTDOJO_RELATED_EMBED_BATCH', 16),
};

export const INTELLIGENCE_TIER = 'extraction';

// ── tokenization / lexical signal ─────────────────────────────────────────────

// A small stopword set so "shared salient tokens" means content words, not glue.
// Kept deliberately short — the goal is to strip the highest-frequency function
// words that would otherwise inflate lexical overlap between unrelated records.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'was', 'were', 'are',
  'has', 'have', 'had', 'not', 'but', 'you', 'your', 'its', 'their', 'they',
  'them', 'then', 'than', 'into', 'onto', 'out', 'over', 'under', 'per', 'via',
  'can', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'been',
  'being', 'because', 'when', 'where', 'what', 'which', 'who', 'whom', 'how',
  'why', 'about', 'above', 'below', 'each', 'more', 'most', 'some', 'such',
  'only', 'own', 'same', 'other', 'any', 'all', 'both', 'few', 'nor', 'off',
  'once', 'here', 'there', 'while', 'does', 'did', 'done', 'get', 'got', 'use',
  'used', 'using', 'one', 'two', 'now', 'new', 'old', 'set', 'run', 'ran',
]);

// Lowercase, split on non-word runs (keep _ - . / so file paths and story ids
// survive as single tokens), drop stopwords and tokens shorter than 3 chars.
function tokenize(text) {
  const raw = String(text || '').toLowerCase().split(/[^a-z0-9_./-]+/);
  const out = [];
  for (const t of raw) {
    const tok = t.replace(/^[-.]+|[-.]+$/g, '');
    if (tok.length < 3) continue;
    if (STOPWORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

function uniqueTokens(text) {
  return Array.from(new Set(tokenize(text)));
}

// Shared salient tokens between the query token set and a record's token set.
function lexicalOverlap(querySet, recordTokens) {
  let n = 0;
  for (const t of recordTokens) if (querySet.has(t)) n++;
  return n;
}

// ── file-path extraction (the touches signal keys off this) ───────────────────

const PATH_RE = /\b(?:lib|scripts|routes|apps|api|agents|architecture|config|tests)\/[A-Za-z0-9_./-]+/g;

function extractPaths(text) {
  const m = String(text || '').match(PATH_RE) || [];
  // Normalize trailing punctuation the regex may have swept in.
  return Array.from(new Set(m.map((p) => p.replace(/[).,;:]+$/, ''))));
}

// ── markdown section helpers (embed_text assembly) ────────────────────────────

function readIfExists(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

// Body of a `## Heading` section up to the next `##` (or EOF).
function sectionBody(md, headingRe) {
  const lines = String(md || '').split('\n');
  let capturing = false;
  const out = [];
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (capturing) break;
      if (headingRe.test(line)) { capturing = true; continue; }
    } else if (capturing) {
      out.push(line);
    }
  }
  return out.join('\n').trim();
}

// First non-empty paragraph (blank-line-delimited) of a block of text, with
// markdown emphasis and blockquote markers stripped and whitespace collapsed.
function firstParagraph(text) {
  const blocks = String(text || '').split(/\n\s*\n/);
  for (const b of blocks) {
    const cleaned = b.replace(/[*_>#`-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned) return cleaned;
  }
  return '';
}

function truncateToCap(text) {
  const cap = embedInputCharCap();
  const s = String(text || '').trim();
  return cap > 0 && s.length > cap ? s.slice(0, cap) : s;
}

function snippetOf(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// ── record enumeration ────────────────────────────────────────────────────────

// One story/defect/work record's embed_text: slug — description — framing first
// para (00-scope.md) — close summary first para (05-close.md). slug+description
// are present on ~all records, so every record embeds even with no artifacts and
// no touches — the mechanism that keeps untagged records searchable by their text.
function storyEmbedText(meta, storyDir) {
  const framing = firstParagraph(sectionBody(readIfExists(join(storyDir, '00-scope.md')), /^##\s+Framing\b/i));
  const close = readIfExists(join(storyDir, '05-close.md'));
  const closeSummary = close
    ? firstParagraph(sectionBody(close, /^##\s+Shipped\b/i)) || firstParagraph(close.replace(/^#[^\n]*\n/, ''))
    : '';
  const parts = [meta.slug || meta.story_id || '', meta.description || meta.short_desc || '', framing, closeSummary]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  return truncateToCap(parts.join(' — '));
}

function storyArtifactPaths(storyDir) {
  const out = [];
  for (const name of ['00-scope.md', '01-research.md', '02-plan.md', '05-close.md', '04-qa.md']) {
    if (existsSync(join(storyDir, name))) out.push(join(storyDir, name));
  }
  return out;
}

function enumerateStoryRecords() {
  let dirs = [];
  try {
    dirs = readdirSync(PIPELINE_STORIES_DIR).filter((d) => /^(st|df|wk)_/.test(d));
  } catch {
    return [];
  }
  const records = [];
  for (const dir of dirs) {
    const storyDir = join(PIPELINE_STORIES_DIR, dir);
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(storyDir, 'meta.json'), 'utf8'));
    } catch {
      continue; // malformed meta — skip, never crash the scan (graceful degradation)
    }
    const embedText = storyEmbedText(meta, storyDir);
    if (!embedText) continue; // no slug/desc/artifacts at all — nothing to embed
    records.push({
      id: meta.story_id || dir,
      type: ['story', 'defect', 'work'].includes(meta.type) ? meta.type : (dir.startsWith('df_') ? 'defect' : dir.startsWith('wk_') ? 'work' : 'story'),
      domain: meta.domain || null,
      slug: meta.slug || meta.story_id || dir,
      stage: meta.stage || null,
      verdict: meta.verdict || null,
      superseded_by: meta.superseded_by || null,
      spawned_from: meta.spawned_from || meta.spawned_from_story || null,
      touches: Array.isArray(meta.touches) ? meta.touches : [],
      closed_at: meta.closed_at || null,
      updated_at: meta.updated_at || meta.started || null,
      artifact_paths: storyArtifactPaths(storyDir),
      snippet: snippetOf(embedText),
      content_hash: contentHash(embedText),
      tokens: uniqueTokens(embedText),
      _embed_text: embedText,
    });
  }
  return records;
}

// One memory record's embed_text: name — description — body. A memory entry IS
// its lesson, so the whole entry is pure signal (unlike a story, assembled from
// several artifacts). Deterministic; no LLM. gather() MUST be called with an
// explicit high maxEntries — its 1000 default silently drops the oldest/lowest-
// priority entries below the live count (the one correctness trap for this story).
async function enumerateMemoryRecords() {
  let entries = [];
  try {
    entries = await gather({ maxEntries: Number.MAX_SAFE_INTEGER });
  } catch {
    return []; // memory dir absent / unreadable — run on stories alone (graceful)
  }
  const records = [];
  for (const e of entries) {
    const fileName = String(e.source || '').replace(/^memory-log:/, '');
    const embedText = truncateToCap([e.name || '', e.description || '', e.body || '']
      .map((s) => String(s || '').trim()).filter(Boolean).join(' — '));
    if (!embedText) continue;
    records.push({
      id: `mem:${fileName}`,
      type: 'memory',
      mem_type: e.type || null,
      name: e.name || fileName,
      description: e.description || '',
      timestamp: e.timestamp || null,
      source: e.source || `memory-log:${fileName}`,
      snippet: snippetOf(embedText),
      content_hash: contentHash(embedText),
      tokens: uniqueTokens(embedText),
      _embed_text: embedText,
    });
  }
  return records;
}

// ── index build / refresh ─────────────────────────────────────────────────────

function loadIndex() {
  try {
    return JSON.parse(readFileSync(PIPELINE_RETRIEVAL_INDEX_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveIndex(index) {
  mkdirSync(dirname(PIPELINE_RETRIEVAL_INDEX_PATH), { recursive: true });
  writeFileSync(PIPELINE_RETRIEVAL_INDEX_PATH, JSON.stringify(index), 'utf8');
}

function vectorToB64(vec) {
  return vectorToBuffer(vec).toString('base64');
}

function b64ToVector(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

// Incremental (rebuild=false): keep vectors for records whose content_hash is
// unchanged; embed only new/changed records in one process (one model load).
// Full (rebuild=true): re-embed everything. Memory entries are append-only, so
// incremental only ever ADDS memory vectors, never re-embeds an existing one.
async function buildIndex({ rebuild }) {
  const prior = rebuild ? null : loadIndex();
  const guardStale = !prior
    || prior.model !== EMBED_MODEL
    || prior.dim !== EMBED_DIM
    || (prior.version || 0) < INDEX_VERSION;
  const priorRecords = guardStale ? {} : (prior.records || {});

  const [stories, memories] = [enumerateStoryRecords(), await enumerateMemoryRecords()];
  const all = [...stories, ...memories];

  const toEmbed = [];
  const records = {};
  for (const rec of all) {
    const existing = priorRecords[rec.id];
    if (existing && existing.content_hash === rec.content_hash && existing.vector_b64) {
      // Unchanged — reuse the stored vector, but refresh mutable display fields
      // (status, artifact paths, tokens) from the current source.
      const { _embed_text, ...store } = rec;
      records[rec.id] = { ...store, vector_b64: existing.vector_b64 };
    } else {
      toEmbed.push(rec);
    }
  }

  if (toEmbed.length) {
    const vectors = await embedBatch(
      toEmbed.map((r) => r._embed_text),
      DEFAULTS.embedBatchSize,
      null,
      { inputType: 'document' },
    );
    for (let i = 0; i < toEmbed.length; i++) {
      const { _embed_text, ...store } = toEmbed[i];
      records[store.id] = { ...store, vector_b64: vectorToB64(vectors[i]) };
    }
  }

  const index = {
    version: INDEX_VERSION,
    model: EMBED_MODEL,
    dim: EMBED_DIM,
    built_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    records,
  };
  saveIndex(index);
  return { index, embedded: toEmbed.length, total: all.length };
}

// Newest source mtime across all story meta.json + memory-log files. Retrieval
// lazily refreshes when the index predates any source (self-healing).
function newestSourceMtime() {
  let newest = 0;
  try {
    for (const dir of readdirSync(PIPELINE_STORIES_DIR).filter((d) => /^(st|df|wk)_/.test(d))) {
      try { newest = Math.max(newest, statSync(join(PIPELINE_STORIES_DIR, dir, 'meta.json')).mtimeMs); } catch {}
    }
  } catch {}
  try {
    const memDir = join(USER_MEMORY_DIR, 'log');
    for (const f of readdirSync(memDir).filter((n) => /^\d{4}-.*\.md$/.test(n))) {
      try { newest = Math.max(newest, statSync(join(memDir, f)).mtimeMs); } catch {}
    }
  } catch {}
  return newest;
}

async function ensureFreshIndex() {
  const index = loadIndex();
  const guardStale = !index
    || index.model !== EMBED_MODEL
    || index.dim !== EMBED_DIM
    || (index.version || 0) < INDEX_VERSION;
  const builtAt = index ? Date.parse(index.built_at || 0) : 0;
  const timeStale = !index || newestSourceMtime() > builtAt;
  if (!guardStale && !timeStale) return index;
  try {
    const { index: fresh } = await buildIndex({ rebuild: guardStale });
    return fresh;
  } catch (err) {
    if (index) {
      process.stderr.write(`[related-context] index refresh failed (${err.message}); using stale index\n`);
      return index;
    }
    throw err;
  }
}

// ── query build ───────────────────────────────────────────────────────────────

// buildQuery self-adjusts to whichever artifacts exist, so the SAME invocation
// works at research (framing only), plan (+ scope ACs + research), and build
// (+ plan's named files). No per-stage code branch.
function buildQuery({ storyId, terms }) {
  if (terms) {
    return { text: terms, namedPaths: extractPaths(terms), spawnedFrom: null };
  }
  const storyDir = join(PIPELINE_STORIES_DIR, storyId);
  let meta = {};
  try { meta = JSON.parse(readFileSync(join(storyDir, 'meta.json'), 'utf8')); } catch {}
  const parts = [meta.slug || storyId, meta.description || meta.short_desc || ''];

  const scope = readIfExists(join(storyDir, '00-scope.md'));
  if (scope) {
    parts.push(sectionBody(scope, /^##\s+Framing\b/i));
    parts.push(sectionBody(scope, /^##\s+Original request\b/i));
    parts.push(sectionBody(scope, /^##\s+Acceptance criteria\b/i));
  }
  const research = readIfExists(join(storyDir, '01-research.md'));
  if (research) parts.push(sectionBody(research, /^##\s+Recommendation\b/i));
  const plan = readIfExists(join(storyDir, '02-plan.md'));
  if (plan) {
    parts.push(sectionBody(plan, /^##\s+Approach\b/i));
    parts.push(sectionBody(plan, /^##\s+How ACs are satisfied\b/i));
  }
  const text = truncateToCap(parts.map((s) => String(s || '').trim()).filter(Boolean).join('\n'));
  return { text, namedPaths: extractPaths(text), spawnedFrom: meta.spawned_from || meta.spawned_from_story || null };
}

// ── ranking (RRF over four signals, raw-signal floor, per-kind cap) ────────────

function computeStatus(rec) {
  if (rec.superseded_by) return `SUPERSEDED-by-${rec.superseded_by}`;
  if (rec.verdict === 'FAIL') return 'FAILED';
  if (['archived', 'abandoned'].includes(rec.stage) && rec.verdict !== 'PASS') return 'ABANDONED';
  return 'LIVE';
}

function rrfContribution(sortedIds, k) {
  const map = new Map();
  sortedIds.forEach((id, i) => map.set(id, 1 / (k + i + 1)));
  return map;
}

async function rank(index, query, opts, activeId) {
  const recs = Object.values(index.records || {});
  const querySet = new Set(tokenize(query.text));
  const namedPaths = new Set(query.namedPaths);

  // Semantic availability: only if the embedder is installed AND the query embeds.
  let queryVec = null;
  let semanticAvailable = false;
  if (localEmbeddingModelStatus().installed && query.text) {
    queryVec = await safeEmbed(query.text, { inputType: 'query' });
    semanticAvailable = queryVec != null;
  }

  const scored = [];
  for (const rec of recs) {
    if (rec.id === activeId) continue; // never retrieve the active story itself
    let cosine = 0;
    if (semanticAvailable && rec.vector_b64) {
      cosine = cosineSimilarity(queryVec, b64ToVector(rec.vector_b64));
    }
    const lexical = lexicalOverlap(querySet, rec.tokens || []);
    const touches = rec.type === 'memory' ? 0
      : (rec.touches || []).filter((p) => namedPaths.has(p)).length;
    const lineage = rec.type === 'memory' ? false
      : Boolean((activeId && rec.spawned_from === activeId) || (query.spawnedFrom && rec.id === query.spawnedFrom));

    const clears = cosine >= opts.minCosine || lexical >= opts.minLexical || touches >= 1 || lineage;
    if (!clears) continue;

    const matchedOn = [];
    if (cosine >= opts.minCosine) matchedOn.push('semantic');
    if (lexical >= opts.minLexical) matchedOn.push('lexical');
    if (touches >= 1) matchedOn.push('touches');
    if (lineage) matchedOn.push('lineage');

    scored.push({ rec, cosine, lexical, touches, lineage, matchedOn });
  }

  // Reciprocal Rank Fusion — score-independent, no cross-scale normalization. Each
  // signal contributes 1/(k+rank) to records it ranks; memory records simply never
  // appear in the touches/lineage lists, so they fuse on semantic+lexical only.
  const k = opts.rrfK;
  const byCosine = [...scored].filter((s) => s.cosine > 0).sort((a, b) => b.cosine - a.cosine).map((s) => s.rec.id);
  const byLexical = [...scored].filter((s) => s.lexical > 0).sort((a, b) => b.lexical - a.lexical).map((s) => s.rec.id);
  const byTouches = [...scored].filter((s) => s.touches > 0).sort((a, b) => b.touches - a.touches).map((s) => s.rec.id);
  const byLineage = scored.filter((s) => s.lineage).map((s) => s.rec.id);
  const contribs = [
    rrfContribution(byCosine, k),
    rrfContribution(byLexical, k),
    rrfContribution(byTouches, k),
    rrfContribution(byLineage, k),
  ];

  for (const s of scored) {
    s.score = contribs.reduce((sum, c) => sum + (c.get(s.rec.id) || 0), 0);
    s.recency = s.rec.type === 'memory'
      ? Date.parse(s.rec.timestamp || 0) || 0
      : Date.parse(s.rec.closed_at || s.rec.updated_at || 0) || 0;
  }
  // Fused score desc; recency as the final tiebreak only.
  scored.sort((a, b) => (b.score - a.score) || (b.recency - a.recency));

  const stories = scored.filter((s) => s.rec.type !== 'memory').slice(0, opts.topN);
  const memories = scored.filter((s) => s.rec.type === 'memory').slice(0, opts.memTopN);

  return { stories, memories, semanticAvailable };
}

// ── output ────────────────────────────────────────────────────────────────────

function memDateLabel(ts) {
  if (!ts) return 'undated';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString().slice(0, 10);
}

function storyLine(s, i) {
  const status = computeStatus(s.rec);
  const label = status.startsWith('SUPERSEDED-by-')
    ? `[SUPERSEDED by ${status.slice('SUPERSEDED-by-'.length)}]`
    : `[${status}]`;
  const bits = [];
  if (s.matchedOn.includes('semantic') || s.cosine > 0) bits.push(`semantic ${s.cosine.toFixed(2)}`);
  if (s.touches > 0) {
    const hit = (s.rec.touches || []).filter((p) => s.matchedOn.includes('touches'));
    bits.push(`touches ${hit.slice(0, 2).join(', ') || s.touches}`);
  }
  if (s.lexical > 0) bits.push(`lexical ${s.lexical}`);
  if (s.lineage) bits.push('lineage');
  const lines = [
    `${i + 1}) ${s.rec.id} — ${s.rec.slug} — ${label} — ${bits.join(' · ')}`,
    `   snippet: ${s.rec.snippet}`,
  ];
  if (s.rec.artifact_paths?.length) lines.push(`   artifacts: ${s.rec.artifact_paths.join(', ')}`);
  return lines.join('\n');
}

function memLine(s, i) {
  const bits = [];
  if (s.matchedOn.includes('semantic') || s.cosine > 0) bits.push(`semantic ${s.cosine.toFixed(2)}`);
  if (s.lexical > 0) bits.push(`lexical ${s.lexical}`);
  return [
    `${i + 1}) MEM ${s.rec.mem_type || 'note'} — ${s.rec.name} — ${memDateLabel(s.rec.timestamp)} — ${bits.join(' · ')}`,
    `   lesson: ${s.rec.snippet}`,
    `   source: ${s.rec.source}`,
  ].join('\n');
}

function renderMarkdown({ stories, memories, semanticAvailable }, index, opts) {
  const corpus = Object.keys(index.records || {}).length;
  if (!stories.length && !memories.length) {
    return `No prior decisions or lessons bear on this area. Corpus of ${corpus} records (stories + memory) searched semantically; none cleared the relevance floor.\n`;
  }
  const out = [];
  const degraded = semanticAvailable ? '' : ' [semantic unavailable — lexical-only]';
  out.push(`### Prior decisions (retrieved ${stories.length + memories.length} of ${corpus} by relevance; not a full read)${degraded}`);
  out.push('');
  out.push(`**Past stories / defects / work** (top ${opts.topN}):`);
  if (stories.length) out.push(stories.map(storyLine).join('\n'));
  else out.push('None relevant.');
  out.push('');
  out.push(`**Distilled lessons (memory log)** (top ${opts.memTopN}):`);
  if (memories.length) out.push(memories.map(memLine).join('\n'));
  else out.push('None relevant.');
  out.push('');
  return out.join('\n');
}

function renderJson({ stories, memories, semanticAvailable }, index, opts) {
  const toResult = (s) => ({
    id: s.rec.id,
    type: s.rec.type,
    ...(s.rec.type === 'memory' ? { mem_type: s.rec.mem_type, name: s.rec.name, source: s.rec.source, timestamp: s.rec.timestamp }
      : { slug: s.rec.slug, status: computeStatus(s.rec), superseded_by: s.rec.superseded_by || null, artifact_paths: s.rec.artifact_paths || [] }),
    score: s.score,
    cosine: s.cosine,
    lexical: s.lexical,
    touches: s.touches,
    matched_on: s.matchedOn,
    snippet: s.rec.snippet,
  });
  return JSON.stringify({
    corpus: Object.keys(index.records || {}).length,
    model: index.model,
    semantic_available: semanticAvailable,
    story_cap: opts.topN,
    mem_cap: opts.memTopN,
    results: [...stories.map(toResult), ...memories.map(toResult)],
  }, null, 2);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}
function floatEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function parseArgs(argv) {
  const flags = { format: 'markdown' };
  const known = new Set(['--story', '--top-n', '--mem-top-n', '--format', '--min-cosine', '--min-lexical', '--terms', '--reindex', '--rebuild']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--story': flags.story = argv[++i]; break;
      case '--top-n': flags.topN = Number(argv[++i]); break;
      case '--mem-top-n': flags.memTopN = Number(argv[++i]); break;
      case '--format': flags.format = argv[++i]; break;
      case '--min-cosine': flags.minCosine = Number(argv[++i]); break;
      case '--min-lexical': flags.minLexical = Number(argv[++i]); break;
      case '--terms': flags.terms = argv[++i]; break;
      case '--reindex': flags.reindex = true; break;
      case '--rebuild': flags.rebuild = true; break;
      default:
        if (a.startsWith('--') && !known.has(a)) {
          process.stderr.write(`Error: unknown flag ${a}\n`);
          process.exit(2);
        }
    }
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.rebuild || flags.reindex) {
    const { embedded, total } = await buildIndex({ rebuild: Boolean(flags.rebuild) });
    const memCount = Object.values(loadIndex().records || {}).filter((r) => r.type === 'memory').length;
    process.stdout.write(`related-context: ${flags.rebuild ? 'rebuilt' : 'reindexed'} — ${total} records (${embedded} embedded this run), ${memCount} memory records → ${PIPELINE_RETRIEVAL_INDEX_PATH}\n`);
    return;
  }

  if (!flags.story && !flags.terms) {
    process.stderr.write('Error: --story <id> or --terms "..." required\n');
    process.exit(2);
  }

  const opts = {
    topN: Number.isFinite(flags.topN) ? flags.topN : DEFAULTS.topN,
    memTopN: Number.isFinite(flags.memTopN) ? flags.memTopN : DEFAULTS.memTopN,
    minCosine: Number.isFinite(flags.minCosine) ? flags.minCosine : DEFAULTS.minCosine,
    minLexical: Number.isFinite(flags.minLexical) ? flags.minLexical : DEFAULTS.minLexical,
    rrfK: DEFAULTS.rrfK,
  };

  let index;
  try {
    index = await ensureFreshIndex();
  } catch (err) {
    // No index and cannot build (e.g. embedder missing on first run). Emit the
    // honest-negative line and exit 0 — a stage must never block on retrieval.
    process.stderr.write(`[related-context] no index available (${err.message})\n`);
    process.stdout.write('No prior decisions or lessons bear on this area. Retrieval index unavailable.\n');
    return;
  }

  const query = buildQuery({ storyId: flags.story, terms: flags.terms });
  const ranked = await rank(index, query, opts, flags.story || null);

  if (flags.format === 'json') process.stdout.write(renderJson(ranked, index, opts) + '\n');
  else process.stdout.write(renderMarkdown(ranked, index, opts));
}

main().catch((err) => {
  // Any unexpected error still exits 0 on the retrieval path via the honest line,
  // but a hard crash here (bad flag already exited 2) is a real defect — surface it.
  process.stderr.write(`[related-context] ${err.stack || err.message}\n`);
  process.exit(1);
});
