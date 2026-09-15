#!/usr/bin/env node
import { discoverWorkbenchCandidates, validateDiscovery, writeDiscoveryOutputs } from '../lib/workbench-files.js';

const args = parseArgs(process.argv.slice(2));
const coveredPaths = await loadRegisteredCoverage(args);
const candidates = discoverWorkbenchCandidates({
  maxFiles: Number(args.maxFiles || args['max-files'] || 8000),
  coveredPaths,
});
const validation = validateDiscovery(candidates, {
  strictSeeds: args.strict !== false && args.strict !== 'false',
  failOnUnresolvedHighConfidence: true,
  failOnUnregisteredClear: true,
});
const outputs = args.writeManifest || args['write-manifest'] || !args.dryRun
  ? writeDiscoveryOutputs(candidates, { outDir: args.outDir || args['out-dir'] })
  : null;

const payload = {
  ok: validation.ok,
  errors: validation.errors,
  counts: {
    total: candidates.length,
    clear: candidates.filter(c => c.classification === 'clear').length,
    ambiguous: candidates.filter(c => c.classification === 'ambiguous').length,
    ignore: candidates.filter(c => c.classification === 'ignore').length,
    register: candidates.filter(c => c.recommended_action === 'register').length,
    registered: candidates.filter(c => c.recommended_action === 'registered').length,
  },
  outputs,
  candidates,
};

console.log(JSON.stringify(payload, null, 2));
if (!validation.ok) process.exit(1);

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

async function loadRegisteredCoverage(args) {
  if (args.noDbCoverage || args['no-db-coverage']) return [];
  try {
    const { default: db } = await import('../lib/db.js');
    const roots = db.prepare(`
      SELECT root_path AS path FROM workbenches WHERE root_path IS NOT NULL AND root_path != ''
      UNION
      SELECT resume_path AS path FROM workbenches WHERE resume_path IS NOT NULL AND resume_path != ''
      UNION
      SELECT path FROM workbench_items WHERE path IS NOT NULL AND path != ''
    `).all().map(row => row.path);
    return roots;
  } catch {
    return [];
  }
}
