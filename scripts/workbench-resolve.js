#!/usr/bin/env node
import { resolveWorkbench, validateResumePayload } from '../lib/workbenches.js';

const args = parseArgs(process.argv.slice(2));
const { default: db } = await import('../lib/db.js');
const payload = resolveWorkbench(db, {
  id: args.id,
  target: args.target || args._?.[0],
  query: args.query,
});
const validation = validateResumePayload(payload);
const errors = [...validation.missing.map(f => `missing resume field: ${f}`)];
if ((args.requireNextAction || args['require-next-action']) && !payload.next_action) errors.push('next_action required');
if ((args.requireDeepLinks || args['require-deep-links']) && !payload.deep_links?.length) errors.push('deep_links required');
if ((args.requireRelatedEntities || args['require-related-entities']) && !payload.related_entities?.length) errors.push('related_entities required');

const result = { ok: errors.length === 0, errors, payload };
if (args.json || args.requireNextAction || args.requireDeepLinks || args.requireRelatedEntities) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`${payload.title} (${payload.workbench_id})`);
  console.log(`Root: ${payload.root}`);
  console.log(`Next: ${payload.next_action}`);
}
if (errors.length) process.exit(1);

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
