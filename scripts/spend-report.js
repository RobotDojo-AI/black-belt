#!/usr/bin/env node
/**
 * scripts/spend-report.js — what the pipeline actually spent.
 *
 * st_4312c9c0 AC-5. Reads pipeline_llm_calls (migration 148) and answers the
 * question the Anthropic invoice cannot: not "how much," but "on what."
 *
 * An auto-recharge invoice is a credit purchase, not a usage statement. It
 * carries one number and no attribution. This report carries the attribution.
 *
 * Usage:
 *   node scripts/spend-report.js                      # last 30 days
 *   node scripts/spend-report.js --since 2026-07-01
 *   node scripts/spend-report.js --since 2026-07-01 --until 2026-08-01
 *   node scripts/spend-report.js --by model           # roll up by model, not label
 *   node scripts/spend-report.js --json               # machine-readable
 *
 * Requires ~/robotdojo as CWD-independent: the DB path resolves absolutely via
 * lib/db.js, so this runs from anywhere.
 */

// INTELLIGENCE_TIER: extraction — deterministic SQL aggregation over a spend
// ledger. Makes no model call and writes nothing.
export const INTELLIGENCE_TIER = 'extraction';

// db.js writes boot notices on import. They are stderr, so they never corrupt
// --json, but this is a report the owner runs by hand and reads at a glance;
// two lines of unrelated maintenance chatter above the number is noise. Set
// before the import, which is why the import is dynamic — a static one would
// hoist above the assignment and the flag would arrive too late.
process.env.ROBOTDOJO_SUPPRESS_DB_BOOT_NOTICES = '1';
const { default: db } = await import('../lib/db.js');
const { status: guardStatus } = await import('../lib/spend-guard.js');

function parseArgs(argv) {
  const out = { since: null, until: null, by: 'label', json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') out.since = argv[++i];
    else if (a === '--until') out.until = argv[++i];
    else if (a === '--by') out.by = argv[++i];
    else if (a === '--json') out.json = true;
  }
  if (!out.since) {
    // Default window: 30 days back. Computed in SQL rather than JS so the
    // boundary matches the stored datetime('now') format exactly.
    out.since = null;
  }
  if (!['label', 'model', 'tier', 'day', 'class', 'provider'].includes(out.by)) {
    process.stderr.write(`spend-report: --by must be label|model|tier|day|class|provider, got ${out.by}\n`);
    process.exit(2);
  }
  return out;
}

const args = parseArgs(process.argv);

// Bind the window once. A null --since means "30 days back"; SQLite computes it
// so the comparison is against the same clock that wrote the rows.
const sinceExpr = args.since ? '?' : "datetime('now','-30 days')";
const untilExpr = args.until ? '?' : "datetime('now')";
const params = [];
if (args.since) params.push(args.since);
if (args.until) params.push(args.until);

const where = `created_at >= ${sinceExpr} AND created_at <= ${untilExpr}`;

const totals = db.prepare(`
  SELECT COUNT(*)                          AS calls,
         COALESCE(SUM(cost_micros), 0)     AS micros,
         COALESCE(SUM(input_tokens), 0)    AS input_tokens,
         COALESCE(SUM(output_tokens), 0)   AS output_tokens,
         COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read,
         MIN(created_at)                   AS first_call,
         MAX(created_at)                   AS last_call
    FROM pipeline_llm_calls
   WHERE ${where}
`).get(...params);

const groupCol = args.by === 'day' ? "date(created_at)"
  : args.by === 'class' ? "COALESCE(spend_class,'(unlabelled)')"
  : args.by === 'provider' ? "COALESCE(provider,'(unrecorded)')"
  : args.by;
const rows = db.prepare(`
  SELECT ${groupCol}                       AS bucket,
         COUNT(*)                          AS calls,
         COALESCE(SUM(cost_micros), 0)     AS micros
    FROM pipeline_llm_calls
   WHERE ${where}
   GROUP BY 1
   ORDER BY micros DESC
`).all(...params);

const usd = (micros) => micros / 1_000_000;

// Interactive chat streams through provider.streamChat and lands in
// chat_turn_metrics, never in pipeline_llm_calls. A report that counted only the
// pipeline table would under-state the real bill by whatever the owner spent
// talking to his own product — so both ledgers are summed here.
let chat = { calls: 0, micros: 0 };
try {
  const row = db.prepare(`
    SELECT COUNT(*) AS calls, COALESCE(SUM(cost_cents), 0) AS cents
      FROM chat_turn_metrics
     WHERE request_start_ms >= CAST(strftime('%s', ${sinceExpr}) AS INTEGER) * 1000
       AND request_start_ms <= CAST(strftime('%s', ${untilExpr}) AS INTEGER) * 1000
  `).get(...params);
  chat = { calls: row.calls, micros: Math.round(Number(row.cents) * 10_000) };
} catch { /* older schema without the table */ }

const grandMicros = totals.micros + chat.micros;


if (args.json) {
  process.stdout.write(JSON.stringify({
    total_usd: usd(grandMicros),
    pipeline_usd: usd(totals.micros),
    chat_usd: usd(chat.micros),
    calls: totals.calls + chat.calls,
    first_call: totals.first_call,
    last_call: totals.last_call,
    by: args.by,
    buckets: rows.map((r) => ({ bucket: r.bucket, calls: r.calls, usd: usd(r.micros) })),
  }, null, 2) + '\n');
  process.exit(0);
}

// The total leads, so a caller scraping the first number gets the answer rather
// than a header count.
process.stdout.write(`${usd(grandMicros).toFixed(4)} USD across ${totals.calls + chat.calls} calls\n`);
if (chat.calls) {
  process.stdout.write(`  pipeline ${usd(totals.micros).toFixed(4)}  |  chat ${usd(chat.micros).toFixed(4)} (${chat.calls} turns)\n`);
}

// The ceilings, so the number above is read against something rather than in a
// vacuum. A report that shows spend without showing headroom makes the owner do
// the arithmetic that the guard already did.
try {
  const g = guardStatus();
  if (g.readable) {
    const line = (name, o) => (Number.isFinite(o.limit)
      ? `  ${name.padEnd(16)} $${o.spent.toFixed(4)} / $${o.limit.toFixed(2)}  (${o.pct.toFixed(0)}%)\n`
      : '');
    process.stdout.write('\nceilings\n');
    process.stdout.write(line('today pipeline', g.today.pipeline));
    process.stdout.write(line('today total', g.today.total));
    process.stdout.write(line('month total', g.month.total));
    if (g.override) process.stdout.write('  OVERRIDE ACTIVE — ceilings bypassed in the calling process\n');
    if (g.bypasses) process.stdout.write(`  ${g.bypasses} call(s) ran uncapped while the ledger was unreadable\n`);
    process.stdout.write('\n');
  }
} catch { /* guard is advisory in the report */ }

if (totals.calls === 0 && chat.calls === 0) {
  // An empty ledger is a real answer, not an error — but say why it might be
  // empty rather than letting a zero read as "nothing was spent."
  process.stdout.write('\nNo recorded calls in this window. Either nothing ran, or calls\n');
  process.stdout.write('are bypassing the gateway — check for direct messages.create callers.\n');
  process.exit(0);
}

process.stdout.write(`window ${totals.first_call} .. ${totals.last_call}\n`);
process.stdout.write(`tokens ${totals.input_tokens} in / ${totals.output_tokens} out`);
process.stdout.write(totals.cache_read ? `, ${totals.cache_read} cached read\n\n` : '\n\n');

const width = Math.max(...rows.map((r) => String(r.bucket ?? '(none)').length), 6);
process.stdout.write(`${'BY ' + args.by.toUpperCase()}`.padEnd(width + 2) + 'CALLS'.padStart(7) + 'USD'.padStart(12) + '  SHARE\n');
for (const r of rows) {
  const share = totals.micros > 0 ? (r.micros / totals.micros) * 100 : 0;
  process.stdout.write(
    String(r.bucket ?? '(none)').padEnd(width + 2)
    + String(r.calls).padStart(7)
    + usd(r.micros).toFixed(4).padStart(12)
    + `  ${share.toFixed(1)}%\n`,
  );
}
