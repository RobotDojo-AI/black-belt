#!/usr/bin/env node
import { openWorkbench } from '../lib/workbench-open.js';

const args = parseArgs(process.argv.slice(2));
const { default: db } = await import('../lib/db.js');
const result = openWorkbench(db, args);

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const p = result.payload;
  console.log(`Workbench: ${p.title} (${p.workbench_id})`);
  console.log(`Root: ${p.root}`);
  console.log(`Next: ${p.next_action}`);
  console.log(`Indexed: ${result.indexed.items} items, ${result.indexed.chunks} chunks`);
  console.log(`RAG: ${result.contract.indexes_for_rag ? 'queued for embedding' : 'index only'}`);
  if (!result.ok) console.log(`Errors: ${result.errors.join(', ')}`);
}

if (!result.ok) process.exit(1);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}
