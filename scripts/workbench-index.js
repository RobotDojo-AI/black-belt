#!/usr/bin/env node
import { indexWorkbench } from '../lib/workbench-rag.js';
import { dryRunFixture } from '../lib/workbenches.js';

const args = parseArgs(process.argv.slice(2));
if (args.dryRun && args.target && !args.id) {
  const fixture = dryRunFixture(args.target);
  console.log(JSON.stringify({
    dry_run: true,
    target: args.target,
    workbench_id: fixture.workbench.id,
    indexable_items: fixture.items.length,
    items: fixture.items.slice(0, 40),
  }, null, 2));
  process.exit(0);
}

const { default: db } = await import('../lib/db.js');
const id = args.id || args.target;
const result = indexWorkbench(db, id, { dryRun: !!args.dryRun, skipEmbed: !!args.skipEmbed || !!args['skip-embed'] });
console.log(JSON.stringify(result, null, 2));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}
