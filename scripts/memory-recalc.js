#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { recalcMemory } from '../lib/memory-recalc.js';

const args = parseArgs(process.argv.slice(2));
if (!args.id && !args.workbenchId && !args.target && !args.topic && !args.all) {
  console.error('usage: node scripts/memory-recalc.js --id <workbench_id> [--json]');
  console.error('   or: node scripts/memory-recalc.js --topic <slug> [--json]');
  console.error('   or: node scripts/memory-recalc.js --target <topic-or-entity> [--json]');
  console.error('   or: node scripts/memory-recalc.js --all [--json]');
  process.exit(2);
}

const { default: db } = await import('../lib/db.js');
const result = await recalcMemory(db, args);
const resultFile = args.resultFile || process.env.ROBOTDOJO_MEMORY_RECALC_RESULT_FILE || null;
if (resultFile) atomicWriteJson(resultFile, {
  action: 'memory_recalc',
  checked_at: new Date().toISOString(),
  ...result,
});

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Recalc scope: ${result.scope} (${result.target})`);
  console.log(`Workbenches: ${result.count}`);
  for (const item of result.workbenches) {
    console.log(`- ${item.workbench_id}: ${item.synthesis_path}`);
    console.log(`  Latest: ${item.latest_state}`);
    console.log(`  Next: ${item.next_action}`);
    console.log(`  Sources: ${item.source_records}; hash ${item.source_set_hash}`);
  }
  if (result.snapshots) {
    console.log(`Snapshots: scanned ${result.snapshots.scanned}, inserted ${result.snapshots.inserted}, existing ${result.snapshots.existing}`);
  }
}

function atomicWriteJson(path, payload) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
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
