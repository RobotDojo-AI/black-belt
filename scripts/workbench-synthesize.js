#!/usr/bin/env node
import { synthesizeWorkbench } from '../lib/workbench-synthesis.js';

const args = parseArgs(process.argv.slice(2));
if (!args.id && !args.workbenchId && !args.target && !args.query) {
  console.error('usage: node scripts/workbench-synthesize.js --id <workbench_id> [--json]');
  console.error('   or: node scripts/workbench-synthesize.js --target <topic-or-entity> [--json]');
  process.exit(2);
}

const { default: db } = await import('../lib/db.js');
const result = await synthesizeWorkbench(db, args);

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Workbench: ${result.workbench_id}`);
  console.log(`Synthesis: ${result.synthesis_path}`);
  console.log(`Latest: ${result.latest_state}`);
  console.log(`Next: ${result.next_action}`);
  console.log(`Sources: ${result.source_records}`);
  console.log(`Source hash: ${result.source_set_hash}`);
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
