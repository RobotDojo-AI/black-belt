#!/usr/bin/env node
/**
 * scripts/rebuild/relation-resolve-run.js — re-runnable composite resolution
 * operation (st_f67bc2eb amendment A1).
 *
 * Compute tier map: Tier 0 only — deterministic SQL + arithmetic fusion
 * (lib/relation-resolve.js). No LLM anywhere; the owner's data resolves the
 * owner's graph.
 *
 * Runs the composite resolver over the open question queue against the live
 * graph: ≥0.90 fused confidence writes the correctly-anchored edge at
 * authority 'inferred-high' and auto-answers the question with full signal
 * provenance; 0.70–0.90 re-anchors the question's phrasing; below silences;
 * genuine two-sided evidence stays open with a named conflict_reason.
 *
 * Fixed-point: resolved members grow the confirmed clusters, so a re-run can
 * resolve candidates the previous pass could not. Idempotent — resolved and
 * silenced rows never re-enter (dedup keys), edge writes merge evidence.
 *
 * Resolution report → ~/.robotdojo/reports/relation-resolve-latest.json
 * (+ dated copy), beside the mining report.
 *
 * CLI: node scripts/rebuild/relation-resolve-run.js --report
 */
export const INTELLIGENCE_TIER = 'extraction';

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..', '..');
const REPORT_DIR = resolve(homedir(), '.robotdojo', 'reports');
const log = (m) => console.log(`[relation-resolve] ${m}`);

const { default: db } = await import('../../lib/db.js');
const { runCompositeResolution } = await import('../../lib/relation-resolve.js');

let familyConfig = null;
try {
  familyConfig = JSON.parse(readFileSync(resolve(REPO_ROOT, 'config', 'family.json'), 'utf8'));
} catch { log('config/family.json absent — resolver runs without owner-curated surname patterns'); }

const before = db.prepare("SELECT COUNT(*) n FROM relation_questions WHERE status = 'open'").get().n;
const report = runCompositeResolution(db, { familyConfig });
report.open_before = before;

if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const latestPath = resolve(REPORT_DIR, 'relation-resolve-latest.json');
const datedPath = resolve(REPORT_DIR, `relation-resolve-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(latestPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
writeFileSync(datedPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
log(`report → ${latestPath}`);
log(`passes=${report.passes} written=${report.resolved_written} auto_answered=${report.auto_answered_questions} re_anchored=${report.re_anchored_questions} conflicts=${report.conflicts_tagged} silenced=${report.silenced}`);
log(`open: ${report.open_before} → ${report.open_after} (${report.open_conflict_tagged} conflict-tagged)`);
process.exit(report.error ? 1 : 0);
