#!/usr/bin/env node
/**
 * scripts/rebuild/relationship-graph-rerun.js — re-runnable full-corpus
 * relationship rebuild (st_df0a8d71 AC-10; RE-SEQUENCED by st_f67bc2eb D9 for
 * the person-to-person truth swap).
 *
 * Compute tier map:
 *   Tier 0 — every pass in this file (legacy backfill, content/contact scan,
 *            structural family inference [question generation only], edge
 *            building, statement mining, the walk + derived cache, structured
 *            -column fact extraction, consistency gate, data-layer quiz):
 *            deterministic SQL/regex. No LLM calls from this file.
 *   Card regeneration is DELEGATED to the entity pipeline's own tier routing
 *   (scripts/regen-entities.js → free/haiku/sonnet buckets).
 *
 * SEQUENCE (dependency order — each step feeds the next):
 *   1. legacy backfill      → owner-class relation_tag rows become owner
 *      edges in person_relations; inference-class rows clear to high-priority
 *      confirm questions (omission beats a false status). Idempotent.
 *   2. content/contact pass → family-from-content results write through the
 *      setRelationTag adapter: Apple contact-card relation fields land as
 *      'contact' authority edges; markdown content is inference class and the
 *      firewall converts it to questions. NOTHING here writes an edge
 *      directly.
 *   3. family inference     → structural passes now generate QUESTIONS only
 *      (the store refuses inference-class writes — AC-3).
 *   4. relationship-builder → legacy colleague/interaction edges only
 *      (source 1, the relation_tag projection, is retired).
 *   5. mining sweep         → possessive statements across chat, sent email,
 *      and notes (scripts/ingest/10-mine-relations.js, spawned synchronously).
 *   6. walk → derived cache → the six readers' columns re-derive from edges.
 *   7. bulkExtractFacts     → entity_facts from structured columns.
 *   8. card consistency sweep + regen of flagged rows.
 *   9. graph-fact-quiz      → the operation FINISHES by proving the graph
 *      passes the data-layer quiz (rewired checks incl. cache coherence).
 *
 * A coverage report is written to ~/.robotdojo/logs/maintenance/. Exit code
 * mirrors the final quiz: non-zero when the graph does not pass.
 *
 * CLI: node scripts/rebuild/relationship-graph-rerun.js --report
 */
export const INTELLIGENCE_TIER = 'orchestration';

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..', '..');
// logs/maintenance, not a new ~/.robotdojo/reports dir: the dot-robotdojo
// whitelist (config/root-allowlist.lock.json) is owner-protected, and the
// maintenance history already lives here — the rerun report is the same
// operational-artifact class.
const REPORT_DIR = resolve(homedir(), '.robotdojo', 'logs', 'maintenance');

const log = (m) => console.log(`[graph-rerun] ${m}`);

const { default: db } = await import('../../lib/db.js');
const {
  setRelationTag,
  backfillLegacyRelationColumns,
  refreshDerivedRelationCache,
} = await import('../../lib/people-write.js');
const { inferFamilyFromContent } = await import('../../lib/family-from-content.js');
const { inferFamilyRelationships } = await import('../../lib/family-inference.js');
const { buildRelationships } = await import('../../lib/relationship-builder.js');
const { bulkExtractFacts } = await import('../../lib/entity-facts.js');

const report = {
  started_at: new Date().toISOString(),
  legacy_backfill: null,
  content_pass: { matches: 0, contact_edges: 0, queued: 0, unchanged: 0 },
  inference_pass: null,
  edges: null,
  mining: { exit: null },
  derived_cache: null,
  facts: null,
  cards: { gate_exit: null, regen_exit: null },
  data_layer_quiz: { exit: null },
};

// ── 1. Legacy backfill (truth swap; idempotent on re-run) ────────────────────
let familyConfig = { members: [] };
try {
  familyConfig = JSON.parse(readFileSync(resolve(REPO_ROOT, 'config', 'family.json'), 'utf8'));
} catch { log('config/family.json absent — backfill classifies by fact provenance only'); }

report.legacy_backfill = backfillLegacyRelationColumns(db, { familyConfig });
log(`legacy backfill: owner_edges=${report.legacy_backfill.owner_edges} composites_written=${report.legacy_backfill.composites_written} composites_queued=${report.legacy_backfill.composites_queued} questions=${report.legacy_backfill.questions}`);

// ── 2. Content/contact pass through the adapter ──────────────────────────────
// alreadyTagged is EMPTY on purpose: the adapter + firewall decide per source
// class; contact-card matches may upgrade untagged rows, inference matches
// become questions either way.
const content = await inferFamilyFromContent({
  db,
  log: (m) => log(m.trim()),
  config: familyConfig,
  alreadyTagged: new Set(),
});
report.content_pass.matches = content.tags.size;

const readPerson = db.prepare('SELECT id, relation_tag, relation_label FROM people WHERE id = ?');
for (const [personId, tag] of content.tags) {
  const label = content.labels.get(personId) || null;
  const via = content.vias?.get(personId) || 'identity';
  const source = via === 'apple-related' ? 'contact-card' : 'content-inference';
  const row = readPerson.get(personId);
  if (!row) continue;
  try {
    const before = row.relation_tag;
    const updated = setRelationTag(db, personId, tag, label, { source });
    if (source === 'contact-card' && updated?.relation_tag && updated.relation_tag !== before) {
      report.content_pass.contact_edges++;
    } else if (updated?.relation_tag === before) {
      // Either unchanged truth or a firewall conversion — the question queue
      // carries the difference; both are honest non-writes here.
      if (source === 'contact-card') report.content_pass.unchanged++;
      else report.content_pass.queued++;
    }
  } catch (err) {
    log(`content pass write failed for ${personId}: ${err.message}`);
  }
}
log(`content pass: matches=${report.content_pass.matches} contact_edges=${report.content_pass.contact_edges} queued=${report.content_pass.queued}`);

// ── 3. Structural family inference → questions only (firewall) ──────────────
try {
  report.inference_pass = inferFamilyRelationships({ dryRun: false, verbose: false });
  log('family inference complete (candidates land as questions, never edges)');
} catch (err) {
  log(`family inference failed: ${err.message}`);
  report.inference_pass = { error: err.message };
}

// ── 4. Legacy typed edges (colleague/interaction only) ───────────────────────
try {
  const edges = await buildRelationships(db, { log: (m) => log(String(m).trim()) });
  report.edges = edges.sources;
} catch (err) {
  log(`relationship-builder failed: ${err.message}`);
  report.edges = { error: err.message };
}

// ── 5. Mining sweep (chat + sent email + notes; transcripts → questions) ────
{
  const mine = spawnSync(process.execPath, [
    resolve(REPO_ROOT, 'scripts', 'ingest', '10-mine-relations.js'), '--report',
  ], { stdio: 'inherit', timeout: 1_800_000 });
  report.mining.exit = mine.status;
  if (mine.status !== 0) log(`mining sweep exited ${mine.status} — continuing (quiz below decides the verdict)`);
}

// ── 5b. Archived-endpoint sweep (AC-11) ──────────────────────────────────────
// The store refuses NEW edges onto archived people, and the product archive
// path deprecates on archive — this sweep closes the remaining race: a
// pipeline archive pass (scripts/ingest/06-archive.js) archiving someone
// AFTER their edges landed. Owner exemption: the owner's own row is archived
// by product convention.
{
  const { deprecateEdgesForPerson } = await import('../../lib/relation-store.js');
  const { ownerPersonId } = await import('../../lib/identity.js');
  const owner = String(ownerPersonId() || '');
  const staleEndpoints = db.prepare(`
    SELECT DISTINCT p.id FROM people p
    JOIN person_relations pr ON pr.status = 'active' AND (pr.person_a = p.id OR pr.person_b = p.id)
    WHERE COALESCE(p.archived, 0) = 1 AND p.id != ?
  `).all(owner);
  let sweptEdges = 0;
  for (const row of staleEndpoints) {
    sweptEdges += deprecateEdgesForPerson(db, row.id, { reason: 'archived' }).deprecated;
  }
  report.archived_sweep = { people: staleEndpoints.length, edges_deprecated: sweptEdges };
  log(`archived-endpoint sweep: people=${staleEndpoints.length} edges_deprecated=${sweptEdges}`);
}

// ── 6. Walk → derived cache ──────────────────────────────────────────────────
report.derived_cache = refreshDerivedRelationCache(db);
log(`derived cache: updated=${report.derived_cache.updated} cleared=${report.derived_cache.cleared}${report.derived_cache.skipped ? ' (skipped — empty edge table)' : ''}`);

// ── 7. Structured facts ───────────────────────────────────────────────────────
try {
  report.facts = { inserted: bulkExtractFacts(db, (m) => log(String(m).trim())) };
} catch (err) {
  log(`bulkExtractFacts failed: ${err.message}`);
  report.facts = { error: err.message };
}

// ── 8. Card consistency sweep + regen of flagged rows ────────────────────────
const gate = spawnSync(process.execPath, [
  resolve(REPO_ROOT, 'scripts', 'qa', 'card-graph-consistency.js'), '--all', '--regen',
], { stdio: 'inherit', timeout: 600_000 });
report.cards.gate_exit = gate.status;
if (gate.status !== 0) {
  const regen = spawnSync(process.execPath, [resolve(REPO_ROOT, 'scripts', 'regen-entities.js')], {
    stdio: 'inherit', timeout: 1_800_000,
  });
  report.cards.regen_exit = regen.status;
}

// ── 9. Data-layer quiz LAST — the operation's own green gate ─────────────────
const quiz = spawnSync(process.execPath, [resolve(REPO_ROOT, 'scripts', 'qa', 'graph-fact-quiz.js')], {
  stdio: 'inherit', timeout: 300_000,
});
report.data_layer_quiz.exit = quiz.status;

report.finished_at = new Date().toISOString();
if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = resolve(REPORT_DIR, `relationship-graph-rerun-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
log(`coverage report → ${reportPath}`);

if (quiz.status !== 0) {
  log('FAIL — data-layer quiz did not pass; the chat-layer quiz must not be consulted until this is green');
  process.exit(1);
}
log('OK — rerun complete and the graph passes the data-layer quiz');
process.exit(0);
