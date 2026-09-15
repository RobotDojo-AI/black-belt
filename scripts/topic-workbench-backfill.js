#!/usr/bin/env node
import { backfillTopicWorkbenches, topicWorkbenchCoverage } from '../lib/topic-workbench-seed.js';

const args = parseArgs(process.argv.slice(2));
const { default: db } = await import('../lib/db.js');

const options = {
  includeHidden: Boolean(args.includeHidden || args.all),
  dryRun: Boolean(args.dryRun),
  recalc: Boolean(args.recalc),
  maxFiles: Number(args.maxFiles || args['max-files'] || 1000),
};

const result = args.coverage
  ? topicWorkbenchCoverage(db, options)
  : await backfillTopicWorkbenches(db, options);

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else if (args.coverage) {
  console.log(`Topic workbench coverage: ${result.with_workbench}/${result.topics}`);
  if (result.missing.length) {
    console.log(`Missing: ${result.missing.map((row) => row.slug).join(', ')}`);
  }
} else {
  console.log(`Topic workbench backfill: created ${result.created}/${result.missing} missing workbench(es)`);
  if (result.recalculated) console.log(`Recalculated: ${result.recalculated}`);
  for (const row of result.workbenches) {
    console.log(`- ${row.slug}: ${row.workbench_id}`);
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
    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    const rawKey = eq >= 0 ? raw.slice(0, eq) : raw;
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq >= 0) {
      out[key] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}
