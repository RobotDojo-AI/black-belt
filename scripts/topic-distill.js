#!/usr/bin/env node
// scripts/topic-distill.js — thin CLI wrapper for lib/topic-distill.js
// (st_5184eb86 chunks 4-5). Mirrors scripts/workbench-synthesize.js's shape.
//
// --dry-run computes and prints the distilled context_md WITHOUT writing —
// no applyTopicContext() call, no SYNTHESIS.md write, no projection-run
// record. Safe to run against the live DB for proof/inspection.
import db from '../lib/db.js';
import { distillTopic, isTopicDistillEnabled } from '../lib/topic-distill.js';

const args = parseArgs(process.argv.slice(2));
if (!args.slug && !args.workbenchId) {
  console.error('usage: node scripts/topic-distill.js --slug <topic-slug> [--dry-run] [--json]');
  console.error('   or: node scripts/topic-distill.js --workbench-id <workbench_id> [--dry-run] [--json]');
  process.exit(2);
}

const result = await distillTopic(db, { slug: args.slug, workbenchId: args.workbenchId }, { dryRun: Boolean(args.dryRun) });

if (!result) {
  console.log(`No description / nothing to synthesize for ${args.slug || args.workbenchId}.`);
  process.exit(0);
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Topic: ${result.slug}`);
  console.log(`Flag enabled (topic_distill.enabled): ${isTopicDistillEnabled()}`);
  console.log(`Dry run: ${result.dry_run}`);
  console.log(`Applied to user_topics: ${result.applied}${result.precedence_reason ? ` (${result.precedence_reason})` : ''}`);
  console.log(`Workbench: ${result.workbench_id || '(none registered)'}`);
  console.log(`Grounding items (entity_facts + entity_claims): ${result.grounding_items}`);
  console.log(`Redacted ungrounded claims: ${result.offending_redacted.length ? result.offending_redacted.join(', ') : '(none)'}`);
  console.log(`Source set hash: ${result.source_set_hash}`);
  console.log(`Chars: ${result.context_md.length}`);
  console.log('--- context_md ---');
  console.log(result.context_md);
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
