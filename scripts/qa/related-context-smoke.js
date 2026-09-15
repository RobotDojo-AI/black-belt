#!/usr/bin/env node
/**
 * scripts/qa/related-context-smoke.js — st_34daf3fd
 *
 * Eight behavioral subtests for the semantic history retriever (related-context.js),
 * spanning both corpora (story archive + memory log) and cross-stage wiring. Each
 * reads the REAL index / source files and asserts in JS (readFileSync + logic +
 * process.exit) — no bare `grep`. Records/entries are picked dynamically from the
 * live index rather than hardcoded, so the tests prove behavior on the actual
 * corpus and do not rot.
 *
 *   node scripts/qa/related-context-smoke.js --subtest <name>
 *
 *   retrieval-quality   AC2 — an untagged story record is retrieved by its text above the floor
 *   memory-retrieved    AC1 — a real memory entry is semantically retrievable as a type:'memory' hit
 *   semantic-isolation  AC2 — a type:'memory' hit has raw cosine >= floor AND raw lexical < MIN_LEXICAL
 *   untagged-indexed    AC2 — the index holds untagged story records AND >=1 memory record
 *   bounded-ranked      AC3 — the per-kind caps TRUNCATE (exactly 8 story + 5 memory), best-first
 *   supersession        AC4 — a superseded story surfaces flagged SUPERSEDED; memory carries no status
 *   plan-build-wiring   AC5 — related-context is invoked in research, plan, AND build; personas carry it
 *   personas-propagated AC6 — generated dist adapters carry the added instruction (regen ran)
 *
 * Corpus env: if it invokes the retriever it inherits ROBOTDOJO_USER_ROOT from
 * this process's env, so the retriever reads the real archive + memory log.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIPELINE_RETRIEVAL_INDEX_PATH } from '../../lib/robotdojo-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const RETRIEVER = join(REPO_ROOT, 'scripts', 'related-context.js');

// Thresholds mirror the retriever's env-tunable defaults so a retune needs no
// code change here.
const MIN_COSINE = Number(process.env.ROBOTDOJO_RELATED_MIN_COSINE) || 0.33;
const MIN_LEXICAL = Number(process.env.ROBOTDOJO_RELATED_MIN_LEXICAL) || 2;
const TOP_N = Number(process.env.ROBOTDOJO_RELATED_TOP_N) || 8;
const MEM_TOP_N = Number(process.env.ROBOTDOJO_RELATED_MEM_TOP_N) || 5;
const SEED = 'st_34daf3fd';

function fail(msg) {
  process.stderr.write(`FAIL — ${msg}\n`);
  process.exit(1);
}
function pass(msg) {
  process.stdout.write(`PASS — ${msg}\n`);
  process.exit(0);
}

function loadIndex() {
  try {
    return JSON.parse(readFileSync(PIPELINE_RETRIEVAL_INDEX_PATH, 'utf8'));
  } catch (err) {
    fail(`cannot read index at ${PIPELINE_RETRIEVAL_INDEX_PATH}: ${err.message} — run: node scripts/related-context.js --rebuild`);
  }
}

function readSource(rel) {
  try {
    return readFileSync(join(REPO_ROOT, rel), 'utf8');
  } catch (err) {
    fail(`cannot read ${rel}: ${err.message}`);
  }
}

// Run the retriever once; inherit env (so ROBOTDOJO_USER_ROOT reaches the corpus).
function runRetrieverJson(args) {
  const res = spawnSync(process.execPath, [RETRIEVER, ...args, '--format', 'json'], {
    encoding: 'utf8',
    env: process.env,
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    fail(`retriever exited ${res.status} for args [${args.join(' ')}]: ${res.stderr || res.stdout}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    fail(`retriever JSON parse failed for args [${args.join(' ')}]: ${err.message}\n${res.stdout?.slice(0, 400)}`);
  }
}

// Derive a topical-sibling query from a record's own indexed text — drop the
// leading slug/id token so the query leans on content words, not the exact id.
// `words` bounds the query length: rich (default 24) for self-retrieval proofs,
// short (~10) for the isolation proof where a small query-token set is what makes
// lexical < MIN_LEXICAL achievable for a semantic neighbor.
function queryFromSnippet(snippet, words = 24) {
  const w = String(snippet || '').split(/\s+/).filter(Boolean);
  return w.slice(1, 1 + words).join(' ');
}

const records = () => Object.values(loadIndex().records || {});

// ── subtests ──────────────────────────────────────────────────────────────────

function subtestUntaggedIndexed() {
  const recs = records();
  const untagged = recs.filter((r) => r.type !== 'memory' && (!r.touches || r.touches.length === 0));
  const memory = recs.filter((r) => r.type === 'memory');
  if (untagged.length === 0) fail('no untagged story records in the index — untagged history would be invisible to touches search');
  if (memory.length === 0) fail('no memory records in the index — the memory corpus never entered the index');
  pass(`index holds ${untagged.length} untagged story records and ${memory.length} memory records (no era or corpus is invisible)`);
}

function subtestRetrievalQuality() {
  const untagged = records()
    .filter((r) => r.type !== 'memory' && (!r.touches || r.touches.length === 0) && (r.snippet || '').length > 60)
    .sort((a, b) => (b.snippet.length - a.snippet.length));
  if (!untagged.length) fail('no untagged story record with enough text to query');
  // Try a few untagged records so one weak snippet does not flake the test.
  for (const target of untagged.slice(0, 5)) {
    const q = queryFromSnippet(target.snippet);
    const out = runRetrieverJson(['--terms', q, '--mem-top-n', '0', '--top-n', '25']);
    const hit = out.results.find((r) => r.id === target.id);
    if (hit && hit.cosine >= MIN_COSINE) {
      pass(`untagged record ${target.id} (no touches) retrieved by its text at cosine ${hit.cosine.toFixed(3)} >= ${MIN_COSINE} — found without any file-touch tag`);
    }
  }
  fail(`no untagged record cleared cosine ${MIN_COSINE} for a text-only query across 5 attempts`);
}

function subtestMemoryRetrieved() {
  const mems = records()
    .filter((r) => r.type === 'memory' && (r.snippet || '').length > 60)
    .sort((a, b) => (b.snippet.length - a.snippet.length));
  if (!mems.length) fail('no memory record with enough text to query');
  for (const target of mems.slice(0, 5)) {
    const q = queryFromSnippet(target.snippet);
    const out = runRetrieverJson(['--terms', q, '--mem-top-n', '10', '--top-n', '0']);
    const memHits = out.results.filter((r) => r.type === 'memory' && r.cosine >= MIN_COSINE);
    if (memHits.length) {
      pass(`memory lesson retrieved as a type:'memory' hit at cosine ${memHits[0].cosine.toFixed(3)} >= ${MIN_COSINE} (id ${memHits[0].id})`);
    }
  }
  fail(`no memory lesson cleared cosine ${MIN_COSINE} across 5 attempts`);
}

function subtestSemanticIsolation() {
  // A memory record's own text, shortened to a handful of words, surfaces a
  // cluster of semantic NEIGHBORS. Among them is a paraphrase hit that shares
  // fewer than MIN_LEXICAL salient tokens with the query yet clears the cosine
  // floor — proving the dense signal found it, not the lexical fallback. A short
  // query (few query tokens) is what makes lexical < MIN_LEXICAL achievable while
  // cosine stays high; the rich seed-story query overlaps lexically with nearly
  // everything, so it cannot isolate the two signals.
  const mems = records()
    .filter((r) => r.type === 'memory' && (r.snippet || '').length > 100)
    .sort((a, b) => b.snippet.length - a.snippet.length);
  if (!mems.length) fail('no memory record with enough text to seed an isolation query');
  for (const m of mems.slice(0, 4)) {
    const q = queryFromSnippet(m.snippet, 10);
    const out = runRetrieverJson(['--terms', q, '--mem-top-n', '50', '--top-n', '0']);
    if (out.semantic_available !== true) fail('semantic_available is not true — the embedder was down, so an isolation proof is impossible');
    const proof = out.results.find((r) => r.type === 'memory' && r.cosine >= MIN_COSINE && r.lexical < MIN_LEXICAL);
    if (proof) pass(`memory hit ${proof.id} found by SEMANTICS: cosine ${proof.cosine.toFixed(3)} >= ${MIN_COSINE}, lexical ${proof.lexical} < ${MIN_LEXICAL} (dense signal, not lexical fallback); semantic_available=true`);
  }
  fail(`no type:'memory' hit had cosine >= ${MIN_COSINE} AND lexical < ${MIN_LEXICAL} across 4 seed queries — could not prove semantic (not lexical) retrieval of memory`);
}

function subtestBoundedRanked() {
  // Floor 0 admits every record as a candidate, so the output size is governed
  // purely by the caps — proving they TRUNCATE, not merely that few matched.
  const out = runRetrieverJson(['--story', SEED, '--min-cosine', '0']);
  const stories = out.results.filter((r) => r.type !== 'memory');
  const mems = out.results.filter((r) => r.type === 'memory');
  if (stories.length !== TOP_N) fail(`expected exactly ${TOP_N} story hits (cap truncation), got ${stories.length}`);
  if (mems.length !== MEM_TOP_N) fail(`expected exactly ${MEM_TOP_N} memory hits (cap truncation), got ${mems.length}`);
  if (out.results.length > TOP_N + MEM_TOP_N) fail(`total ${out.results.length} exceeds cap sum ${TOP_N + MEM_TOP_N}`);
  for (const kind of [stories, mems]) {
    for (let i = 1; i < kind.length; i++) {
      if (kind[i].score > kind[i - 1].score + 1e-12) fail(`ranking not monotonic best-first: ${kind[i].id} scored above its predecessor`);
    }
  }
  pass(`caps truncate: exactly ${stories.length} story + ${mems.length} memory (floor 0 admits all; output bounded by caps), each kind best-first`);
}

function subtestSupersession() {
  const sup = records().find((r) => r.type !== 'memory' && r.superseded_by);
  if (!sup) fail('no story record carries superseded_by — cannot prove supersession flagging');
  // Query with the superseded record's own text so it ranks to the top.
  const q = queryFromSnippet(sup.snippet) || sup.slug;
  const out = runRetrieverJson(['--terms', `${sup.slug} ${q}`, '--top-n', '25', '--mem-top-n', '10']);
  const hit = out.results.find((r) => r.id === sup.id);
  if (!hit) fail(`superseded record ${sup.id} did not surface for its own text`);
  if (!/^SUPERSEDED/.test(hit.status || '')) fail(`superseded record ${sup.id} surfaced with status '${hit.status}', not SUPERSEDED`);
  // Invariant over the whole output.
  for (const r of out.results) {
    if (r.type !== 'memory') {
      if (r.superseded_by && !/^SUPERSEDED/.test(r.status || '')) fail(`story ${r.id} has a supersessor but status '${r.status}' is not SUPERSEDED`);
    } else if (r.status !== undefined) {
      fail(`memory ${r.id} carries a status label '${r.status}' — memory is recency-only in v1, no fabricated status`);
    }
  }
  pass(`superseded story ${sup.id} flagged '${hit.status}'; no story with a supersessor marked live; memory carries no status label`);
}

function subtestPlanBuildWiring() {
  const checks = [
    ['agents/skills/research/SKILL.md', /related-context/, 'research skill invokes related-context'],
    ['agents/skills/plan/SKILL.md', /related-context/, 'plan skill invokes related-context'],
    ['agents/skills/build/SKILL.md', /related-context/, 'build skill invokes related-context'],
    ['agents/personas/Tantei.md', /Prior decisions/, 'Tantei persona carries the Prior-decisions instruction'],
    ['agents/personas/Ori.md', /settled history/, 'Ori persona carries the settled-history instruction'],
    ['agents/personas/Katagami.md', /settled history/, 'Katagami persona carries the settled-history instruction'],
  ];
  for (const [rel, re, label] of checks) {
    if (!re.test(readSource(rel))) fail(`${label} — missing in ${rel}`);
  }
  pass('related-context is invoked in research, plan, AND build skills, and all three personas carry their instruction');
}

function subtestPersonasPropagated() {
  const checks = [
    ['agents/dist/claude-agents/Tantei.md', /Prior decisions/, 'Tantei'],
    ['agents/dist/claude-agents/Ori.md', /settled history/, 'Ori'],
    ['agents/dist/claude-agents/Katagami.md', /settled history/, 'Katagami'],
  ];
  for (const [rel, re, name] of checks) {
    if (!re.test(readSource(rel))) fail(`${name} dist adapter missing the added instruction (${rel}) — did generate-identity.js run?`);
  }
  pass('generated dist adapters for Tantei, Ori, and Katagami carry the added instruction (regen ran)');
}

const SUBTESTS = {
  'retrieval-quality': subtestRetrievalQuality,
  'memory-retrieved': subtestMemoryRetrieved,
  'semantic-isolation': subtestSemanticIsolation,
  'untagged-indexed': subtestUntaggedIndexed,
  'bounded-ranked': subtestBoundedRanked,
  'supersession': subtestSupersession,
  'plan-build-wiring': subtestPlanBuildWiring,
  'personas-propagated': subtestPersonasPropagated,
};

function main() {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--subtest');
  const name = idx !== -1 ? argv[idx + 1] : null;
  if (!name || !SUBTESTS[name]) {
    process.stderr.write(`usage: related-context-smoke.js --subtest <${Object.keys(SUBTESTS).join('|')}>\n`);
    process.exit(2);
  }
  SUBTESTS[name]();
}

main();
