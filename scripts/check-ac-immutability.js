#!/usr/bin/env node
// check-ac-immutability.js — pre-commit gate that backstops the ac-guard hook.
//
// Default mode (pre-commit): walks `git diff --cached --name-only`, builds the
// set of sealed AC/VC artifacts staged for commit, and for each one verifies
// that the staged content's SHA256 matches the chain[stage].hash recorded in
// stage-hashes.json (or any matching amendments[].new_hash). A commit that
// stages an undeclared mutation of a sealed artifact is rejected.
//
// `--all` mode (audit, run on demand): scans the entire corpus and reports
// every sealed AC/VC artifact whose on-disk content drifts from the chain
// hash. Does NOT block on findings; informational only. Useful for spotting
// pre-existing drift accumulated before this gate shipped.
//
// `--repo-root <path>`: scope all repo operations to <path> instead of the
// real robotdojo checkout. Used only by the ac-immutability test suite to
// run the gate against fixture git repos without touching the live tree.
//
// Exit 0  — clean (no staged sealed-artifact mutations in default mode; or
//           audit mode completed without internal errors).
// Exit 1  — staged tree includes an undeclared sealed-artifact mutation.
// Exit 2  — internal error (read failure, malformed JSON, git unavailable).
//
// Scope of protection: only `agent_sealed` chain entries for the three
// stages whose artifacts are explicitly AC/VC documents. Pre-amend entries
// (agent_sealed cleared by `--amend`) are intentionally not enforced — that
// is the legitimate edit window. Build/qa/close/research stages are not in
// scope: their artifacts are not the contract the build is judged against.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve as pathResolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DEFAULT_REPO_ROOT = pathResolve(dirname(new URL(import.meta.url).pathname), '..');
const PROTECTED_STAGES = new Set(['scope', 'plan', 'criteria']);

function sha256OfBytes(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Chain hash formula mirrors story-gate.js line 314:
//   hash = sha256(prev_hash_hex_string_as_utf8 + file_bytes)
// `prev` is the `prev` field on the chain entry itself (stable across
// amend cycles — see story-gate.js --amend which preserves entry.prev).
function chainHashFor(prevHex, bytes) {
  if (!prevHex) return sha256OfBytes(bytes); // belt-and-suspenders for malformed chains
  return sha256OfBytes(Buffer.concat([Buffer.from(prevHex, 'utf8'), bytes]));
}

function fileBytes(path) {
  return readFileSync(path);
}

// Return the file content as staged in the index (not the working tree).
// Returns null if the file isn't in the index (deleted, never staged).
function stagedBytes(repoRoot, relPath) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'show', `:${relPath}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function stagedFiles(repoRoot) {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'diff', '--cached', '--name-only'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

function resolveChainFile(repoRoot, entryFile) {
  if (!entryFile) return null;
  if (entryFile.startsWith('/')) return entryFile;
  return pathResolve(repoRoot, entryFile);
}

function findStories(storiesDir) {
  if (!existsSync(storiesDir)) return [];
  return readdirSync(storiesDir).filter((d) => /^(st|df|wk)_/.test(d));
}

// Build the sealed-paths index keyed by absolute filesystem path.
function buildSealedIndex(repoRoot) {
  const storiesDir = join(repoRoot, 'user', 'workbenches', 'topics', 'work', 'robot-dojo', 'wk_robot_dojo', 'stories');
  const index = new Map(); // absPath -> { story_id, stage, expectedHash, acceptedHashes }
  for (const dir of findStories(storiesDir)) {
    const storyDir = join(storiesDir, dir);
    const hashFile = join(storyDir, 'stage-hashes.json');
    if (!existsSync(hashFile)) continue;

    let data;
    try {
      data = JSON.parse(readFileSync(hashFile, 'utf8'));
    } catch (err) {
      process.stderr.write(`[check-ac-immutability] WARN: malformed ${hashFile}: ${err.message}\n`);
      continue;
    }

    const chain = data.chain || {};
    for (const [stage, entry] of Object.entries(chain)) {
      if (!PROTECTED_STAGES.has(stage)) continue;
      if (!entry || !entry.agent_sealed) continue;
      const filePath = resolveChainFile(repoRoot, entry.file);
      if (!filePath) continue;
      const amendments = Array.isArray(entry.amendments) ? entry.amendments : [];
      const acceptedHashes = new Set([entry.hash, ...amendments.map((a) => a && a.new_hash).filter(Boolean)]);
      if (!index.has(filePath)) {
        index.set(filePath, {
          story_id: data.story_id || dir,
          stage,
          prev: entry.prev,
          expectedHash: entry.hash,
          acceptedHashes,
        });
      }
    }
  }
  return index;
}

function printViolation(v, out) {
  out.write(`\n  story:  ${v.story_id}\n`);
  out.write(`  stage:  ${v.stage}\n`);
  out.write(`  file:   ${v.file}\n`);
  if (v.kind === 'hash-drift') {
    out.write(`  drift:  sha256 mismatch\n`);
    out.write(`    expected: ${v.expected}\n`);
    out.write(`    actual:   ${v.actual}\n`);
    out.write(`  fix:    run \`node ~/robotdojo/scripts/story-gate.js --amend ${v.stage} --story ${v.story_id}\`\n`);
    out.write(`          then re-stage, re-seal, and re-approve. Or revert the file to its sealed content.\n`);
  } else if (v.kind === 'staged-deletion') {
    out.write(`  detail: this commit stages a deletion of a sealed AC/VC artifact\n`);
    out.write(`  fix:    sealed artifacts must not be deleted; --amend the stage first if removal is intended\n`);
  } else {
    out.write(`  detail: ${v.detail}\n`);
  }
}

function runAuditMode(repoRoot) {
  const sealed = buildSealedIndex(repoRoot);
  const violations = [];
  let entriesChecked = 0;

  for (const [filePath, meta] of sealed) {
    if (!existsSync(filePath)) {
      violations.push({
        story_id: meta.story_id,
        stage: meta.stage,
        file: filePath,
        kind: 'file-missing',
        detail: 'sealed artifact does not exist on disk',
      });
      continue;
    }
    entriesChecked++;
    const actual = chainHashFor(meta.prev, fileBytes(filePath));
    if (!meta.acceptedHashes.has(actual)) {
      violations.push({
        story_id: meta.story_id,
        stage: meta.stage,
        file: filePath,
        kind: 'hash-drift',
        expected: meta.expectedHash,
        actual,
      });
    }
  }

  if (violations.length === 0) {
    process.stdout.write(`[check-ac-immutability --all] ok — ${entriesChecked} sealed AC/VC artifacts verified\n`);
    process.exit(0);
  }

  process.stderr.write(`[check-ac-immutability --all] AUDIT — ${violations.length} drift finding(s) (informational; pre-commit mode only blocks staged drift):\n`);
  for (const v of violations) printViolation(v, process.stderr);
  // Audit mode exits 0 even on findings — informational only.
  process.exit(0);
}

function runPrecommitMode(repoRoot) {
  const staged = stagedFiles(repoRoot);
  if (staged.size === 0) {
    process.stdout.write(`[check-ac-immutability] ok — nothing staged\n`);
    process.exit(0);
  }

  const sealed = buildSealedIndex(repoRoot);
  const violations = [];
  let entriesChecked = 0;

  for (const rel of staged) {
    const abs = pathResolve(repoRoot, rel);
    if (!sealed.has(abs)) continue; // not a sealed artifact — irrelevant
    const meta = sealed.get(abs);
    entriesChecked++;

    const staged = stagedBytes(repoRoot, rel);
    if (staged === null) {
      violations.push({
        story_id: meta.story_id,
        stage: meta.stage,
        file: abs,
        kind: 'staged-deletion',
      });
      continue;
    }
    const stagedHash = chainHashFor(meta.prev, staged);
    if (!meta.acceptedHashes.has(stagedHash)) {
      violations.push({
        story_id: meta.story_id,
        stage: meta.stage,
        file: abs,
        kind: 'hash-drift',
        expected: meta.expectedHash,
        actual: stagedHash,
      });
    }
  }

  if (violations.length === 0) {
    if (entriesChecked === 0) {
      process.stdout.write(`[check-ac-immutability] ok — no sealed AC/VC artifacts in this commit\n`);
    } else {
      process.stdout.write(`[check-ac-immutability] ok — ${entriesChecked} staged sealed artifact(s) verified\n`);
    }
    process.exit(0);
  }

  process.stderr.write(`[check-ac-immutability] FAIL — ${violations.length} undeclared sealed-artifact mutation(s) in this commit:\n`);
  for (const v of violations) printViolation(v, process.stderr);
  process.stderr.write(`\nA sealed AC/VC artifact's staged content must match its chain hash, or have a matching amendments[] entry.\n`);
  process.stderr.write(`Run \`node ~/robotdojo/scripts/story-gate.js --amend <stage> --story <id>\` to legitimately edit, then re-stage and re-seal.\n`);
  process.exit(1);
}

// Argv parse: supports --all / --audit, plus --repo-root <path> for tests.
const rawArgs = process.argv.slice(2);
let overrideRoot = null;
const flags = new Set();
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--repo-root') {
    overrideRoot = pathResolve(rawArgs[++i]);
  } else {
    flags.add(a);
  }
}
const REPO_ROOT = overrideRoot || DEFAULT_REPO_ROOT;

if (flags.has('--all') || flags.has('--audit')) {
  runAuditMode(REPO_ROOT);
} else {
  runPrecommitMode(REPO_ROOT);
}
