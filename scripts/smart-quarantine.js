#!/usr/bin/env node
/**
 * smart-quarantine.js — CLI orchestrator.
 *
 * Default mode: dry-run (proposes; doesn't apply).
 * Flags:
 *   --execute        — apply decisions
 *   --input-dir <p>  — directory to walk (default: quarantine/ + dotdir + research)
 *   --manifest <p>   — JSONL path (default: <PIPELINE_ROOT>/quarantine-manifest.jsonl)
 *
 * WHY default dry-run: the classifier should never silently mutate the tree.
 * The owner reads the proposed actions before opting into --execute.
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnPath } from '../lib/quarantine/index.js';
import { PIPELINE_ROOT } from '../lib/robotdojo-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

function parseArgs(argv) {
  const opts = { execute: false, inputDir: null, manifest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') opts.execute = true;
    else if (a === '--input-dir') opts.inputDir = argv[++i];
    else if (a === '--manifest') opts.manifest = argv[++i];
  }
  return opts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = args.manifest || join(PIPELINE_ROOT, 'quarantine-manifest.jsonl');

  const inputs = args.inputDir
    ? [args.inputDir]
    : [
        join(REPO_ROOT, 'quarantine'),
      ];

  let allResults = [];
  for (const dir of inputs) {
    if (!existsSync(dir)) continue;
    const out = await runOnPath(dir, {
      repoRoot: REPO_ROOT,
      execute: args.execute,
      manifest,
    });
    allResults = allResults.concat(out.results);
  }

  const summary = {
    mode: args.execute ? 'execute' : 'dry-run',
    processed: allResults.length,
    manifest,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (args.execute) {
    for (const r of allResults) {
      if (r.execError) console.error(`ERROR: ${r.file}: ${r.execError}`);
    }
  } else {
    for (const r of allResults) {
      if (r.skipped) {
        console.log(`[dry-run] ${r.file}: noop (${r.reason})`);
        continue;
      }
      const d = r.decision || {};
      console.log(`[dry-run] ${r.file}: ${d.action} → ${d.destination} (conf=${d.confidence ?? '?'})`);
    }
  }
}

main().catch(err => {
  console.error('smart-quarantine failed:', err.message);
  process.exit(1);
});
