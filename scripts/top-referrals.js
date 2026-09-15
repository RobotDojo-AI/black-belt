#!/usr/bin/env node
/**
 * top-referrals.js — surface the top-N qualified referral candidates.
 *
 * Usage:
 *   node scripts/top-referrals.js [--limit 20] [--format markdown|json]
 *                                 [--refresh] [--extract-pro]
 *                                 [--max-spend 5.0] [--dry-run]
 *
 * By default: reads cached scores (from referral_scores table).
 *
 * Flags:
 *   --limit N         Top N candidates (default 20)
 *   --format X        'markdown' | 'json'  (default markdown)
 *   --refresh         Recompute all scores before output
 *   --extract-pro     Also extract professional info via Haiku (batched, costs $)
 *   --max-spend USD   Cap LLM spend (default 5.0)
 *   --dry-run         Extract but do not write to DB
 *
 * Output: writes markdown to ~/.robotdojo/reports/top-referrals-{date}.md
 *         (report path is gitignored and private).
 */
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import db from '../lib/db.js';
import {
  computeReferralScores,
  getTopReferralCandidates,
  QUALIFIED_THRESHOLD,
  WEIGHTS,
} from '../lib/referral.js';
// st_bc949e7c Phase 3.6: post-consolidation BB import. The lib/bb/index.js
// extractBatch is a stub returning the zero-result shape; the real
// professional-extraction pipeline ships in a future BB drop.
import { isBBActive } from '../lib/cohort/active.js';
import * as bb from '../lib/bb/index.js';
const _bbActive = await isBBActive();
const extractBatch = _bbActive
  ? bb.extractBatch
  : (async () => ({ extracted: 0, domainOnly: 0, skipped: 0, costUsd: 0 }));

function parseArgs(argv) {
  const out = { limit: 20, format: 'markdown', refresh: false,
    extractPro: false, maxSpend: 5.0, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit')       out.limit = parseInt(argv[++i], 10);
    else if (a === '--format') out.format = argv[++i];
    else if (a === '--refresh') out.refresh = true;
    else if (a === '--extract-pro') out.extractPro = true;
    else if (a === '--max-spend') out.maxSpend = parseFloat(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/top-referrals.js [--limit N] [--format X]`);
  console.log(`                                     [--refresh] [--extract-pro]`);
  console.log(`                                     [--max-spend USD] [--dry-run]`);
}

async function main() {
  const args = parseArgs(process.argv);
  const t0 = Date.now();

  if (args.extractPro) {
    // Extract pro info for Core + Network people who don't have it yet.
    const needIds = db.prepare(`
      SELECT p.id FROM people p
      LEFT JOIN person_professional pp ON pp.person_id = p.id
      WHERE p.archived = 0
        AND p.tier IN ('core', 'network')
        AND pp.person_id IS NULL
      ORDER BY p.score DESC
    `).all().map(r => r.id);

    console.info(`[pro] extracting for ${needIds.length} people (batch 20, cap $${args.maxSpend})`);
    const stats = await extractBatch(needIds, {
      batchSize: 20,
      maxSpendUsd: args.maxSpend,
      dryRun: args.dryRun,
    });
    console.info(`[pro] extracted=${stats.extracted} domainOnly=${stats.domainOnly} ` +
                 `skipped=${stats.skipped} cost=$${stats.costUsd.toFixed(3)}`);
  }

  if (args.refresh || args.extractPro) {
    console.info('[referral] recomputing scores...');
    computeReferralScores();
  }

  const candidates = getTopReferralCandidates(args.limit);
  const qualified = candidates.filter(c => c.qualified).length;

  if (args.format === 'json') {
    console.log(JSON.stringify({ candidates, qualified, threshold: QUALIFIED_THRESHOLD }, null, 2));
    return;
  }

  // Markdown output
  const md = renderMarkdown(candidates, { qualified, took: Date.now() - t0 });

  // Ensure reports dir exists
  const dir = resolve(homedir(), '.robotdojo', 'reports');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const outPath = resolve(dir, `top-referrals-${date}.md`);
  writeFileSync(outPath, md);

  // Print a compact summary + point to the file.
  console.log(md);
  console.log(`\nReport written to ${outPath}`);
}

function renderMarkdown(candidates, { qualified, took }) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push(`# Top Referral Candidates — ${date}`);
  lines.push('');
  lines.push(`Qualified (>= ${QUALIFIED_THRESHOLD}): **${qualified} / ${candidates.length}**`);
  lines.push(`Scoring weights: ` + Object.entries(WEIGHTS)
    .map(([k, v]) => `${k}=${v}`).join(', '));
  lines.push(`Computed in ${(took / 1000).toFixed(1)}s. All scoring is local.`);
  lines.push('');
  lines.push('| # | Name | Tier | Role | Score | Top Signal | Rel | Tech | Tool | Priv | Share |');
  lines.push('|---|------|------|------|-------|------------|-----|------|------|------|-------|');
  candidates.forEach((c, i) => {
    const role = [c.title, c.company].filter(Boolean).join(' @ ') || '—';
    const s = c.scores;
    const flag = c.qualified ? '✓' : ' ';
    lines.push(
      `| ${i + 1} ${flag} | ${esc(c.displayName)} | ${c.tier} | ${esc(role)} ` +
      `| ${c.total.toFixed(2)} | ${c.topSignal} ` +
      `| ${num(s.relationship)} | ${num(s.technical)} | ${num(s.toolSpend)} ` +
      `| ${num(s.privacy)} | ${num(s.sharing)} |`
    );
  });
  lines.push('');
  lines.push('*Generated by Robot Dojo `scripts/top-referrals.js`.*');
  return lines.join('\n');
}

function num(x) { return (x || 0).toFixed(2); }
function esc(s) { return String(s || '').replace(/\|/g, '\\|'); }

main().catch(err => {
  console.error('[top-referrals] Fatal:', err);
  process.exit(1);
});
