#!/usr/bin/env node
import { registerWorkbench } from '../lib/workbenches.js';

const args = parseArgs(process.argv.slice(2));
const spec = {
  id: args.id,
  slug: args.slug,
  title: args.title,
  root_path: args.root,
  target: args.target,
  attachment: args.attach ? parseAttachment(args.attach) : null,
};
if (args.attach && !spec.attachment) throw new Error(`invalid attachment: ${args.attach}`);

if (args.dryRun) {
  const result = registerWorkbench(null, spec, { dryRun: true });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const { default: db } = await import('../lib/db.js');
const result = registerWorkbench(db, spec, { maxFiles: Number(args.maxFiles || args['max-files'] || 2500) });
console.log(JSON.stringify(result, null, 2));

function parseAttachment(value) {
  const match = String(value).match(/^(topic|person|company|place):(.+)$/);
  if (!match) return null;
  return { target_type: match[1], target_id: match[2], role: 'primary' };
}

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
