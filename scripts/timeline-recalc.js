#!/usr/bin/env node
import { recalcLifeTimeline, timelineCoverage } from '../lib/timeline-recalc.js';

const args = parseArgs(process.argv.slice(2));
const { default: db } = await import('../lib/db.js');
const result = args.coverage ? timelineCoverage(db) : recalcLifeTimeline(db);

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else if (args.coverage) {
  console.log(`Life timeline coverage: ${result.ok ? 'ok' : 'missing'}`);
  for (const row of result.sources) {
    if (!row.ready) console.log(`- ${row.source}: skipped (missing table/columns)`);
    else console.log(`- ${row.source}: ${row.timeline_rows}/${row.source_rows} timeline rows; missing ${row.missing}`);
  }
} else {
  console.log(`Life timeline recalc: ${result.source_rows} source rows, ${result.timeline_changed} timeline changes`);
  for (const row of result.sources) {
    if (row.skipped) console.log(`- ${row.source}: skipped (${row.reason})`);
    else console.log(`- ${row.source}: ${row.changed}/${row.rows}`);
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}
