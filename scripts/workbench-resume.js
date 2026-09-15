#!/usr/bin/env node
import { resolveWorkbench, validateResumePayload } from '../lib/workbenches.js';

const args = parseArgs(process.argv.slice(2));
const { default: db } = await import('../lib/db.js');
const payload = resolveWorkbench(db, { id: args.id, target: args.target || args._?.join(' ') });
const validation = validateResumePayload(payload);
console.log(JSON.stringify({ ok: validation.ok, missing: validation.missing, payload }, null, 2));
if (!validation.ok) process.exit(1);

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
