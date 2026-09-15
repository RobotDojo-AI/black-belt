#!/usr/bin/env node
/**
 * detect-over-merges.js — surface over-merge (weld) suspects, REPORT-only
 * (df_cbd30a5a AC-7). NEVER auto-splits; the split is owner-gated.
 *
 * The transitive-bridge weld generalized (Splink "a bridge joining two dense sub-clusters" +
 * Tantei "≥2 disjoint name families"): for each ACTIVE, NON-owner person (the
 * declared owner is excluded — his ~38 idents / ~30 domains are legitimately
 * broad and would false-positive), graph the person's email/phone identifiers.
 * Two identifiers are LINKED when their email local-parts share a ≥3-char NAME
 * TOKEN. A suspect is FLAGGED when the graph has ≥2 connected components that
 * EACH hold ≥2 identifiers — dense, disjoint name families, not a singleton
 * stray.
 *
 * DELIBERATE deviation from the plan's "OR share a domain" link rule: a domain
 * is an ORGANIZATION, not a person. The worst live weld (168f0369, ~50 emails
 * fusing ~40 distinct BCG people mostly on the shared bcg.com domain) collapses
 * into ONE component under domain-linking and never flags. Name-token linking is
 * the same-person signal: it flags 168f0369 (distinct name families) while a
 * legitimately broad single identity (all addresses sharing the owner's own
 * name token) stays ONE component and is not flagged.
 *
 * The signal is ≥2 DENSE disjoint components, NOT raw identifier count — a
 * legitimately broad single identity (many role addresses on shared tokens/
 * domains) forms ONE component and is not flagged (precision guard).
 *
 * INTELLIGENCE_TIER: extraction
 *   Deterministic, no LLM. Reads person_identifiers, computes connected
 *   components, ranks by a structural weld score. REPORTS only; the `--split`
 *   path calls lib/entity-unmerge.js (deterministic split; card prose is the
 *   only model step, downstream).
 *
 * Flags:
 *   (default)        human summary of flagged suspects + report file.
 *   --json           JSONL to stdout (one candidate/line).
 *   --grep <prefix>  exit 0 iff a flagged candidate's person_id starts with the
 *                    prefix (the live-suspect assertion), else 1.
 *   --split <id>     owner-gated: print the dry-run adjudication for <id>; with
 *                    --execute, split via lib/entity-unmerge.js executeUnmergePair.
 *
 * Usage:
 *   cd ~/robotdojo && node scripts/ingest/detect-over-merges.js
 *   cd ~/robotdojo && node scripts/ingest/detect-over-merges.js --grep 168f0369
 *   cd ~/robotdojo && node scripts/ingest/detect-over-merges.js --split <id>            # dry-run
 *   cd ~/robotdojo && node scripts/ingest/detect-over-merges.js --split <id> --execute  # owner-confirmed
 */

export const INTELLIGENCE_TIER = 'extraction';

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ownerPersonId, isOwner } from '../../lib/identity.js';
import { executeUnmergePair } from '../../lib/entity-unmerge.js';
// df_cbd30a5a AC-12: the structural weld core (localTokens, analyzeIdentifierGraph,
// scoreCandidate) moved to the leaf module lib/identity-matching.js so the AC-12
// merge-time coherence cut and this after-the-fact detector share ONE
// implementation. Imported + re-exported here so the CLI, --grep/--split paths,
// the maint_detect_over_merges routine, and tests/detect-over-merges.test.js are
// unchanged (behavior-preserving move).
import { localTokens, analyzeIdentifierGraph, scoreCandidate } from '../../lib/identity-matching.js';
export { analyzeIdentifierGraph, scoreCandidate };

// A weld needs ≥2 components each ≥2 identifiers → at least 4 identifiers. Only
// people at/above this floor can possibly flag, so we never scan the long tail.
const MIN_IDENTIFIERS = 4;

/**
 * Scan the graph for over-merge suspects. Pure reads — the declared owner is
 * excluded. Returns flagged candidates ranked by score descending.
 */
export function detectOverMerges(db, { ownerId = null } = {}) {
  const owner = String(ownerId || ownerPersonId() || '');
  const rows = db.prepare(`
    SELECT pi.person_id AS id, p.display_name AS display_name, COUNT(*) AS n
    FROM person_identifiers pi
    JOIN people p ON p.id = pi.person_id
    WHERE pi.type IN ('email','phone') AND COALESCE(p.archived, 0) = 0
    GROUP BY pi.person_id
    HAVING n >= ${MIN_IDENTIFIERS}
  `).all();

  const candidates = [];
  const identStmt = db.prepare("SELECT type, value FROM person_identifiers WHERE person_id = ? AND type IN ('email','phone')");
  for (const row of rows) {
    if (owner && String(row.id) === owner) continue; // owner excluded (broad-but-single identity)
    const idents = identStmt.all(row.id);
    const analysis = analyzeIdentifierGraph(idents);
    if (!analysis.flagged) continue;
    candidates.push({
      person_id: row.id,
      display_name: row.display_name,
      identifier_count: analysis.identifierCount,
      component_count: analysis.componentCount,
      dense_component_count: analysis.denseComponentCount,
      min_component_size: analysis.minComponentSize,
      distinct_domains: analysis.distinctDomains,
      components: analysis.componentTokens,
      score: scoreCandidate(analysis),
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/** Capitalized display name derived from a component's dominant token. */
function deriveNameFromTokens(idents, indices) {
  const counts = new Map();
  for (const idx of indices) {
    const v = String(idents[idx].value).toLowerCase();
    if (!v.includes('@')) continue;
    for (const t of localTokens(v.split('@')[0])) counts.set(t, (counts.get(t) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [t, c] of counts) if (c > bestN) { best = t; bestN = c; }
  return best ? best.charAt(0).toUpperCase() + best.slice(1) : null;
}

/**
 * Build the split plan for a welded record: survivor keeps the LARGEST dense
 * component; the SECOND-largest is extracted. classify maps each identifier
 * value to 'B' (extracted) or 'A' (survivor). Returns null if not a weld.
 */
export function buildSplitPlanForPerson(db, personId) {
  const idents = db.prepare("SELECT type, value FROM person_identifiers WHERE person_id = ? AND type IN ('email','phone')").all(personId);
  const analysis = analyzeIdentifierGraph(idents);
  if (!analysis.flagged) return null;
  const extractComp = analysis.denseComponents[1]; // second-largest
  const extractValues = new Set(extractComp.map((idx) => String(idents[idx].value).toLowerCase()));
  const classify = (type, value) => (extractValues.has(String(value).toLowerCase()) ? 'B' : 'A');
  return {
    classify,
    extractedName: deriveNameFromTokens(idents, extractComp) || 'Unmerged Person',
    extractValues: [...extractValues],
    survivorValues: idents.map((i) => String(i.value).toLowerCase()).filter((v) => !extractValues.has(v)),
  };
}

// ── Report file (untracked runtime dir) ──────────────────────────────────────
function reportPathFor(ts = Date.now()) {
  return resolve(process.env.ROBOTDOJO_OVER_MERGE_REPORT_DIR || resolve(homedir(), '.robotdojo'), `over-merge-candidates-${ts}.jsonl`);
}
function writeReport(candidates) {
  if (!candidates.length) return null;
  const path = reportPathFor();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, candidates.map((c) => JSON.stringify(c)).join('\n') + '\n', { mode: 0o600 });
    return path;
  } catch { return null; }
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const grepIdx = argv.indexOf('--grep');
  const grepPrefix = grepIdx >= 0 ? argv[grepIdx + 1] : null;
  const splitIdx = argv.indexOf('--split');
  const splitId = splitIdx >= 0 ? argv[splitIdx + 1] : null;
  const execute = argv.includes('--execute');

  const { default: db } = await import('../../lib/db.js');

  // ── --split <id> (owner-gated) ────────────────────────────────────────────
  if (splitId) {
    if (isOwner(splitId)) {
      console.error(`[detect-over-merges] refusing to split the declared owner (${splitId}) — the owner is not an over-merge.`);
      process.exit(1);
    }
    const plan = buildSplitPlanForPerson(db, splitId);
    if (!plan) {
      console.log(`[detect-over-merges] ${splitId} is not a weld-suspect (fewer than 2 dense identifier clusters) — nothing to split.`);
      process.exit(0);
    }
    console.log(`[detect-over-merges] split plan for ${splitId}:`);
    console.log(`  SURVIVOR keeps (${plan.survivorValues.length}): ${plan.survivorValues.join(', ')}`);
    console.log(`  EXTRACT → "${plan.extractedName}" (${plan.extractValues.length}): ${plan.extractValues.join(', ')}`);
    if (!execute) {
      console.log('[detect-over-merges] --dry-run (default): no writes. Re-run with --execute (owner-confirmed) to split.');
      process.exit(0);
    }
    const report = await executeUnmergePair(db, {
      survivorId: splitId,
      mintExtracted: true,
      classify: plan.classify,
      extractedName: plan.extractedName,
      execute: true,
      source: 'over-merge-detector',
      log: (m) => console.log(m),
    });
    console.log(`[detect-over-merges] split complete: extracted=${report.extractedId} moved=${report.moved_to_extracted} minted=${report.extracted_minted} constraint=${report.constraint_written}`);
    process.exit(0);
  }

  // ── Report / grep ─────────────────────────────────────────────────────────
  const candidates = detectOverMerges(db);

  if (grepPrefix) {
    const hit = candidates.find((c) => String(c.person_id).startsWith(grepPrefix));
    if (hit) {
      console.log(JSON.stringify(hit));
      process.exit(0);
    }
    console.error(`[detect-over-merges] no flagged suspect with person_id prefix "${grepPrefix}"`);
    process.exit(1);
  }

  if (asJson) {
    for (const c of candidates) console.log(JSON.stringify(c));
    process.exit(0);
  }

  const path = writeReport(candidates);
  console.log(`[detect-over-merges] ${candidates.length} weld-suspect(s) flagged (REPORT-only; splits are owner-gated).`);
  for (const c of candidates.slice(0, 20)) {
    console.log(`  ${c.person_id}  "${c.display_name}"  idents=${c.identifier_count} dense=${c.dense_component_count} domains=${c.distinct_domains} score=${c.score.toFixed(1)}`);
  }
  if (path) console.log(`[detect-over-merges] report written: ${path}`);
  process.exit(0);
}

// Run as CLI only (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => { console.error('[detect-over-merges] fatal:', err.message); process.exit(1); });
}
