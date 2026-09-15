#!/usr/bin/env node
// scripts/check-preseal-protected-touches.js — st_5e810098 AC2/AC3.
//
// Pre-seal (and pre-commit-attempt) notice for protected/canonical-surface
// files a story declares in meta.touches. Unlike check-root-lock.js (which
// is blind until `git add` has run), this reads meta.touches directly and
// compares each protected file's STAGED blob sha256 to the local approval —
// the fix for the TOCTOU shape named in research (a gate keyed to a
// declaration, not the state that will actually be committed).
//
// CLI: node scripts/check-preseal-protected-touches.js --story <id>
//        [--repo <path>] [--fail-if-unapproved]
//
// Exit 0 always, UNLESS:
//   - a genuine structural error occurs (bad root-lock config, unreadable
//     meta.json) — exits 1 regardless of --fail-if-unapproved.
//   - --fail-if-unapproved is passed AND at least one touched protected file
//     is staged with NEEDS APPROVAL — exits 1. This mode is for /build step 6
//     deciding whether to attempt the commit.
//
// Tier: extraction (deterministic; reads git + local JSON, no LLM).
export const INTELLIGENCE_TIER = 'extraction';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalSurfaceFiles,
  loadRootLock,
  protectedFiles,
  rootLockApprovalPath,
  stagedBlobSha256,
} from './root-lock-lib.js';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

function parseArgs(argv) {
  const out = { repoRoot: join(process.env.HOME, 'robotdojo'), failIfUnapproved: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--story') out.story = argv[++i];
    else if (argv[i] === '--repo') out.repoRoot = argv[++i];
    else if (argv[i] === '--fail-if-unapproved') out.failIfUnapproved = true;
  }
  return out;
}

function loadLocalApprovals() {
  const path = rootLockApprovalPath();
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.approvals || [];
}

function approvalMatches(approvals, storyId, file, sha256) {
  return approvals.some((a) => a && a.story_id === storyId && a.files && a.files[file] === sha256);
}

const args = parseArgs(process.argv);
if (!args.story) {
  console.error('Usage: check-preseal-protected-touches.js --story <id> [--repo <path>] [--fail-if-unapproved]');
  process.exit(1);
}

let lock;
try {
  lock = loadRootLock(args.repoRoot);
} catch (e) {
  console.error(`BLOCKED — root-allowlist lock malformed: ${e.message}`);
  process.exit(1);
}

const metaPath = join(PIPELINE_STORIES_DIR, args.story, 'meta.json');
let meta;
try {
  meta = JSON.parse(readFileSync(metaPath, 'utf8'));
} catch (e) {
  console.error(`BLOCKED — could not read meta.json for story ${args.story} (${metaPath}): ${e.message}`);
  process.exit(1);
}

const touches = Array.isArray(meta.touches) ? meta.touches.filter(Boolean) : [];
const protectedSet = new Set([...protectedFiles(lock), ...canonicalSurfaceFiles(args.repoRoot)]);
const targets = touches.filter((f) => protectedSet.has(f));

const approvals = loadLocalApprovals();
const rows = targets.map((file) => {
  const sha = stagedBlobSha256(args.repoRoot, file);
  let status;
  if (!sha) status = 'NOT STAGED';
  else if (approvalMatches(approvals, args.story, file, sha)) status = 'APPROVED';
  else status = 'NEEDS APPROVAL';
  return { file, status };
});

const w = Math.max('FILE'.length, ...rows.map((r) => r.file.length));
console.log(`\n${'FILE'.padEnd(w)}  STATUS`);
console.log(`${'-'.repeat(w)}  --------------`);
if (rows.length === 0) {
  console.log('(no protected files in meta.touches)');
} else {
  for (const r of rows) console.log(`${r.file.padEnd(w)}  ${r.status}`);
}

const anyNeedsApproval = rows.some((r) => r.status === 'NEEDS APPROVAL');
if (args.failIfUnapproved && anyNeedsApproval) process.exit(1);
process.exit(0);
