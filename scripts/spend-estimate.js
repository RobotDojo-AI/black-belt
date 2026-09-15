#!/usr/bin/env node
/**
 * scripts/spend-estimate.js — what will this cost, and was the estimate right?
 *
 * st_4312c9c0 AC-18. AC-5 made past spend queryable; this adds the forward half
 * so the owner can price a piece of work before committing to it, and reconcile
 * the estimate against the actual afterwards.
 *
 * The reconciliation is the load-bearing part. An estimate nobody checks becomes
 * a number people trust for no reason; showing the gap makes a consistently
 * wrong estimator visible instead of quietly authoritative.
 *
 * Estimates are built from THIS SYSTEM'S OWN HISTORY, not from a guess. Every
 * label in pipeline_llm_calls carries its real observed cost per call, so
 * "enrich 400 entities" is priced from what enriching one actually cost, with
 * the spread shown rather than hidden behind a mean.
 *
 * Usage:
 *   node scripts/spend-estimate.js --label entity-enrich-reacts-null --count 400
 *   node scripts/spend-estimate.js --reconcile --label entity-enrich-reacts-null --since 2026-08-01
 *   node scripts/spend-estimate.js --list
 */

// INTELLIGENCE_TIER: extraction — deterministic aggregation over the spend
// ledger. Makes no model call.
export const INTELLIGENCE_TIER = 'extraction';

process.env.ROBOTDOJO_SUPPRESS_DB_BOOT_NOTICES = '1';
const { default: db } = await import('../lib/db.js');

function parseArgs(argv) {
  const out = { label: null, count: 1, since: null, reconcile: false, list: false, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') out.label = argv[++i];
    else if (a === '--count') out.count = Number(argv[++i]);
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--reconcile') out.reconcile = true;
    else if (a === '--list') out.list = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

const args = parseArgs(process.argv);
const usd = (micros) => micros / 1_000_000;

/** Every label with enough history to price, cheapest first. */
function labelStats(label = null) {
  const where = label ? 'WHERE label = ?' : '';
  const params = label ? [label] : [];
  return db.prepare(`
    SELECT label,
           COUNT(*)                       AS calls,
           AVG(cost_micros)               AS mean_micros,
           MIN(cost_micros)               AS min_micros,
           MAX(cost_micros)               AS max_micros,
           SUM(cost_micros)               AS total_micros
      FROM pipeline_llm_calls
      ${where}
     GROUP BY label
     ORDER BY mean_micros DESC
  `).all(...params);
}

if (args.list) {
  const rows = labelStats();
  if (!rows.length) {
    process.stdout.write('No history yet — nothing can be priced until calls are recorded.\n');
    process.exit(0);
  }
  process.stdout.write('LABEL'.padEnd(34) + 'CALLS'.padStart(7) + 'MEAN USD'.padStart(12) + '   RANGE\n');
  for (const r of rows) {
    process.stdout.write(
      r.label.padEnd(34)
      + String(r.calls).padStart(7)
      + usd(r.mean_micros).toFixed(6).padStart(12)
      + `   ${usd(r.min_micros).toFixed(6)} – ${usd(r.max_micros).toFixed(6)}\n`,
    );
  }
  process.exit(0);
}

if (!args.label) {
  process.stderr.write('usage: spend-estimate.js --label <call-site> --count <n>\n');
  process.stderr.write('       spend-estimate.js --reconcile --label <call-site> [--since DATE]\n');
  process.stderr.write('       spend-estimate.js --list\n');
  process.exit(2);
}

const [stats] = labelStats(args.label);

if (!stats) {
  // Refusing to price is the honest answer. A made-up number here would be
  // indistinguishable from a real one at the point it gets used.
  process.stdout.write(`0.0000 USD — no history for "${args.label}", so it cannot be priced.\n`);
  process.stdout.write('Run the work once and the estimate becomes real. --list shows what can be priced.\n');
  process.exit(0);
}

if (args.reconcile) {
  const sinceExpr = args.since ? '?' : "datetime('now','-30 days')";
  const params = args.since ? [args.label, args.since] : [args.label];
  const actual = db.prepare(`
    SELECT COUNT(*) AS calls, COALESCE(SUM(cost_micros), 0) AS micros
      FROM pipeline_llm_calls
     WHERE label = ? AND created_at >= ${sinceExpr}
  `).get(...params);

  const predicted = stats.mean_micros * actual.calls;
  const gapPct = predicted > 0 ? ((actual.micros - predicted) / predicted) * 100 : 0;

  process.stdout.write(`${usd(actual.micros).toFixed(6)} USD actual across ${actual.calls} calls\n`);
  process.stdout.write(`${usd(predicted).toFixed(6)} USD predicted at the all-time mean\n`);
  process.stdout.write(`gap ${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(1)}%`);
  process.stdout.write(Math.abs(gapPct) > 25
    ? ' — wide enough that the mean is not describing this work well\n'
    : '\n');
  process.exit(0);
}

const meanTotal = stats.mean_micros * args.count;
const lowTotal = stats.min_micros * args.count;
const highTotal = stats.max_micros * args.count;

if (args.json) {
  process.stdout.write(`${JSON.stringify({
    label: args.label,
    count: args.count,
    estimate_usd: usd(meanTotal),
    low_usd: usd(lowTotal),
    high_usd: usd(highTotal),
    basis_calls: stats.calls,
  }, null, 2)}\n`);
  process.exit(0);
}

process.stdout.write(`${usd(meanTotal).toFixed(4)} USD estimated for ${args.count} × ${args.label}\n`);
process.stdout.write(`range ${usd(lowTotal).toFixed(4)} – ${usd(highTotal).toFixed(4)} USD\n`);
process.stdout.write(`basis: ${stats.calls} recorded call(s), mean ${usd(stats.mean_micros).toFixed(6)} each\n`);
if (stats.calls < 5) {
  process.stdout.write('Thin basis — fewer than 5 recorded calls. Treat this as a rough order of magnitude.\n');
}
