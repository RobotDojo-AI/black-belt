#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalSurfaceFiles,
  DEFAULT_REPO_ROOT,
  dotRobotdojoEntries,
  loadRootLock,
  protectedFiles,
  rootLockApprovalPath,
  stagedFiles,
  trackedUnder,
} from './root-lock-lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TERMINAL_STAGES = new Set(['close-complete', 'done', 'cancelled', 'closed', 'closed-superseded', 'archived', 'absorbed', 'superseded']);
const TERMINAL_KANBANS = new Set(['done', 'cancelled', 'closed', 'closed-superseded', 'archived', 'absorbed']);
const CLOSED_COMMIT_GRACE_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv = process.argv) {
  const out = {
    repoRoot: process.env.ROBOTDOJO_REPO_ROOT ? resolve(process.env.ROBOTDOJO_REPO_ROOT) : DEFAULT_REPO_ROOT,
    ci: argv.includes('--ci'),
    printApprovalRequest: argv.includes('--print-approval-request'),
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--repo') out.repoRoot = resolve(argv[++i]);
  }
  return out;
}

function buildApprovalRequest(repoRoot, lock) {
  const protectedSet = new Set([...protectedFiles(lock), ...canonicalSurfaceFiles(repoRoot)]);
  const staged = stagedFiles(repoRoot).filter((path) => protectedSet.has(path));
  const stories = loadTouchingStories(repoRoot);
  const byStory = new Map();
  for (const file of staged) {
    const story = stories.find((candidate) => candidate.touches.has(file));
    if (!story) continue;
    const sha256 = stagedBlobSha256(repoRoot, file);
    if (!sha256) continue;
    if (!byStory.has(story.id)) {
      byStory.set(story.id, {
        story_id: story.id,
        owner_quote: lock.owner_approval_quote || '',
        files: {},
      });
    }
    byStory.get(story.id).files[file] = sha256;
  }
  return { approvals: [...byStory.values()] };
}

function isTerminal(meta) {
  return TERMINAL_STAGES.has(meta.stage) || TERMINAL_KANBANS.has(meta.kanban);
}

function isRecentlyClosed(meta) {
  if (!isTerminal(meta)) return false;
  const stamp = meta.closed_at || meta.updated_at;
  const t = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(t) && Date.now() - t <= CLOSED_COMMIT_GRACE_MS;
}

function loadTouchingStories(repoRoot) {
  const out = [];
  const storiesDir = join(repoRoot, 'user', 'workbenches', 'topics', 'work', 'robot-dojo', 'wk_robot_dojo', 'stories');
  if (!existsSync(storiesDir)) return out;
  for (const dir of readdirSync(storiesDir)) {
    const path = join(storiesDir, dir, 'meta.json');
    if (!existsSync(path)) continue;
    let meta;
    try { meta = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    if (isTerminal(meta) && !isRecentlyClosed(meta)) continue;
    out.push({ id: meta.story_id || dir, touches: new Set(meta.touches || []) });
  }
  return out;
}

function stagedBlobSha256(repoRoot, file) {
  const exists = spawnSync('git', ['cat-file', '-e', `:${file}`], { cwd: repoRoot });
  if (exists.status !== 0) return null;
  const result = spawnSync('git', ['show', `:${file}`], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return createHash('sha256').update(result.stdout).digest('hex');
}

function loadLocalApprovals() {
  const path = rootLockApprovalPath();
  if (!existsSync(path)) return { path, approvals: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const approvals = Array.isArray(parsed) ? parsed : parsed.approvals || [];
  return { path, approvals };
}

function localApprovalMatches(approval, storyId, file, sha256) {
  if (!approval || approval.story_id !== storyId) return false;
  if (!approval.owner_quote || !approval.files || typeof approval.files !== 'object') return false;
  return approval.files[file] === sha256;
}

function codeownersLines(repoRoot) {
  const path = join(repoRoot, '.github', 'CODEOWNERS');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function codeownersPatternMatches(pattern, file) {
  const normalized = pattern.replace(/^\/+/, '');
  if (normalized === '*') return true;
  if (normalized.endsWith('/')) return file.startsWith(normalized);
  if (normalized.endsWith('/*')) return file.startsWith(normalized.slice(0, -1));
  return file === normalized;
}

function checkCodeownersCoverage(repoRoot, lock, protectedSet, errors) {
  const owner = lock.owner_codeowner;
  const lines = codeownersLines(repoRoot);
  if (!lines.length) {
    errors.push('.github/CODEOWNERS is missing; GitHub cannot require owner review for architecture lock files');
    return;
  }
  for (const file of protectedSet) {
    const covered = lines.some((line) => {
      const [pattern, ...owners] = line.split(/\s+/);
      return owners.includes(owner) && codeownersPatternMatches(pattern, file);
    });
    if (!covered) errors.push(`${file} is protected but not covered by .github/CODEOWNERS for ${owner}`);
  }
}

function checkProtectedTouches(repoRoot, lock, ci, errors) {
  const protectedSet = new Set([...protectedFiles(lock), ...canonicalSurfaceFiles(repoRoot)]);
  checkCodeownersCoverage(repoRoot, lock, protectedSet, errors);
  const staged = stagedFiles(repoRoot);
  const stagedProtected = staged.filter((path) => protectedSet.has(path));
  if (!stagedProtected.length) return;

  const stories = loadTouchingStories(repoRoot);
  const local = loadLocalApprovals();
  for (const file of stagedProtected) {
    const touching = stories.filter((story) => story.touches.has(file));
    if (!touching.length) {
      errors.push(`${file} is root-lock protected; an open story must list the exact file in meta.touches`);
      continue;
    }
    if (ci) continue;

    const sha256 = stagedBlobSha256(repoRoot, file);
    if (!sha256) {
      errors.push(`${file} is root-lock protected and cannot be deleted by an agent commit`);
      continue;
    }
    const ok = touching.some((story) =>
      local.approvals.some((approval) => localApprovalMatches(approval, story.id, file, sha256))
    );
    if (!ok) {
      errors.push(`${file} is root-lock protected; missing local owner approval in ${local.path} for staged sha256 ${sha256}`);
    }
  }
}

function checkRootEntries(repoRoot, lock, errors) {
  const allowed = new Set(Object.keys(lock.entries));
  for (const entry of readdirSync(repoRoot)) {
    if (!allowed.has(entry)) {
      errors.push(`top-level entry is not in root allowlist lock: ${entry}`);
    }
  }

  for (const [name, entry] of Object.entries(lock.entries)) {
    const exists = existsSync(join(repoRoot, name));
    if (entry.required && !exists) errors.push(`required root entry missing: ${name}`);
    if (!exists) continue;
    const st = statSync(join(repoRoot, name));
    if (entry.type === 'dir' && !st.isDirectory()) errors.push(`root entry should be a directory: ${name}`);
    if (entry.type === 'file' && !st.isFile()) errors.push(`root entry should be a file: ${name}`);
  }

  for (const retired of lock.retired || []) {
    if (existsSync(join(repoRoot, retired))) errors.push(`retired top-level root still exists: ${retired}`);
    const tracked = trackedUnder(repoRoot, retired);
    if (tracked.length) {
      errors.push(`retired top-level root still has tracked files: ${tracked.slice(0, 10).join(', ')}`);
    }
  }
}

function checkUntrackedRecoverabilityClasses(repoRoot, lock, errors) {
  const trackedForbidden = new Set();
  for (const [name, entry] of Object.entries(lock.entries)) {
    if (entry.class === 'regenerable') trackedForbidden.add(name);
    if (entry.class === 'gcp' && entry.type === 'file') trackedForbidden.add(name);
  }
  for (const name of trackedForbidden) {
    const tracked = trackedUnder(repoRoot, name);
    if (tracked.length) errors.push(`${name} is ${lock.entries[name].class} but tracked by Git: ${tracked.join(', ')}`);
  }
}

function checkDotRobotdojo(repoRoot, lock, errors) {
  const dotdir = join(process.env.HOME || '', '.robotdojo');
  if (!existsSync(dotdir)) return;
  const allowed = dotRobotdojoEntries(lock);
  for (const entry of readdirSync(dotdir)) {
    if (entry.startsWith('.')) continue;
    if (!allowed.has(entry)) errors.push(`~/.robotdojo/${entry} is not in root allowlist lock dot_robotdojo_entries`);
  }
}

function checkNoMirroredAllowlists(repoRoot, errors) {
  const forbidden = [
    ['scripts/gate.js', /const\s+ALLOWED_REPO\b/],
    ['scripts/gate.js', /const\s+ALLOWED_DOTDIR_ROOT\b/],
    ['scripts/gate.js', /const\s+DIR_RULES\b/],
    ['scripts/gate.js', /const\s+GITIGNORED_DIRS\b/],
    ['scripts/gate.js', /entries\.filter\([^)]*startsWith\(['"]\.['"]\)/],
    ['scripts/check-gitignore.js', /const\s+ALLOWED_REPO_DIRS\b/],
    ['scripts/check-gitignore.js', /const\s+REPO_WIDE_PATTERNS\b/],
  ];
  for (const [file, pattern] of forbidden) {
    const path = join(repoRoot, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (pattern.test(text)) errors.push(`${file} still contains mirrored root allowlist logic matching ${pattern}`);
  }
}

function main() {
  const { repoRoot, ci, printApprovalRequest } = parseArgs();
  const errors = [];
  let lock;
  try {
    lock = loadRootLock(repoRoot);
  } catch (err) {
    errors.push(err.message);
  }
  if (lock) {
    if (printApprovalRequest) {
      process.stdout.write(`${JSON.stringify(buildApprovalRequest(repoRoot, lock), null, 2)}\n`);
      return;
    }
    checkRootEntries(repoRoot, lock, errors);
    checkUntrackedRecoverabilityClasses(repoRoot, lock, errors);
    checkDotRobotdojo(repoRoot, lock, errors);
    checkNoMirroredAllowlists(repoRoot, errors);
    checkProtectedTouches(repoRoot, lock, ci, errors);
  }

  if (errors.length) {
    process.stderr.write(`check-root-lock: FAIL (${errors.length})\n`);
    for (const error of errors) process.stderr.write(`- ${error}\n`);
    process.exit(1);
  }
  process.stdout.write('check-root-lock: clean\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
