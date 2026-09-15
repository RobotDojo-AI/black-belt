#!/usr/bin/env node
import { promoteWorkbenchFinding } from '../lib/workbench-distill.js';

const args = parseArgs(process.argv.slice(2));
const { default: db } = await import('../lib/db.js');
const result = await promoteWorkbenchFinding(db, {
  id: args.id,
  target: args.target,
  source_path: args.source,
  change_summary: args.summary,
  reviewer: args.reviewer || 'codex',
}, { dryRun: !!args.dryRun });
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
