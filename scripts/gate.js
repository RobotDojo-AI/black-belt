#!/usr/bin/env node
/**
 * gate.js - enforces the canonical filesystem ontology defined in
 * architecture/structure.md and architecture/sitemap.md. Every folder and file is checked against the
 * MECE definition of its parent directory.
 *
 * Replaces check-structure.js. No quarantine auto-move — gate only reports.
 * Quarantine is smart-quarantine.js's job; gate.js just stops the commit.
 *
 * Five checks, all run on every invocation:
 *
 *   1. Repo root allowlist + naming — top-level entries must be in
 *      config/root-allowlist.lock.json.
 *      Root markdown files must be lowercase (e.g., architecture/architecture.md not ARCHITECTURE.md).
 *   2. Untracked deep-tree files (advisory) — every file in ~/robotdojo/ should
 *      be tracked or gitignored. Logged but does NOT block: smart-quarantine.js
 *      (pre-commit Step 2a) is the intelligence layer that classifies untracked
 *      files. Live WIP from concurrent terminals passes; >24h stale rot reaches
 *      quarantine/ via the classifier and then blocks via zone 5 (qgrace).
 *   3. Per-directory MECE — every tracked file must match the allowed file-type
 *      ruleset of its top-level directory (e.g., `lib/foo.png` violates lib/
 *      because lib/ is .js/.ts/.sql/.mjs/.md only).
 *   4. ~/.robotdojo/ whitelist — top-level entries must be in the root lock.
 *   5. 24h quarantine grace — files lingering in quarantine/ beyond 24h are
 *      stop-the-line (quarantine is not a parking lot).
 *
 * To add a new top-level repo entry: owner approval is required. Update
 *   config/root-allowlist.lock.json in the approved story commit.
 *
 * To loosen a per-directory rule: update the root lock entry and architecture/structure.md.
 */

// st_f6315f0b: gate.js is a structure/quarantine check, not a CPU-meaningful
// workload — readdir + small subprocess calls only. Also called from
// pre-commit (sync) where blocking on idle would be wrong.
export const IDLE_GATED = false;

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createNotificationTask } from '../lib/asana.js';
import { dotRobotdojoEntries, loadRootLock, sourceDirRules } from './root-lock-lib.js';

// --notify flag: when passed, structure violations (zones 1-4) also fire an
// Asana notification. Zone 5 (qgrace) always notifies — it is stop-the-line
// regardless of how gate.js was invoked. The LaunchAgent plist passes --notify;
// pre-commit hook does not (no latency penalty for normal commits).
const NOTIFY = process.argv.includes('--notify');

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DOTDIR = join(homedir(), '.robotdojo');

// ── Root lock ────────────────────────────────────────────────────────────────

const ROOT_LOCK = loadRootLock(REPO_ROOT);
const ROOT_ENTRIES = ROOT_LOCK.entries;
const ALLOWED_ROOT_ENTRIES = new Set(Object.keys(ROOT_ENTRIES));
const ALLOWED_DOTDIR_ENTRIES = dotRobotdojoEntries(ROOT_LOCK);

// ── Per-directory MECE rules ──────────────────────────────────────────────────
// Each top-level dir declares the file extensions it accepts. Files inside the
// dir (recursively) whose extension is not on the list are MECE violations.
//
// `.md` is accepted everywhere — README.md and inline docs are universal.
// Extensionless files are accepted everywhere (e.g., LICENSE, .gitkeep).
//
// Gitignored top-level dirs are excluded — the deep-tree check (zone 2) already
// guarantees their contents are not in the committed repo.

const UNIVERSAL_EXT = new Set([]);

const SOURCE_DIR_RULES = sourceDirRules(ROOT_LOCK);

// ── Zone 1: ~/robotdojo/ top-level allowlist + naming ────────────────────────
// Naming rule: root markdown files must be lowercase. Uppercase names
// (ARCHITECTURE.md, SITEMAP.md) are a naming violation — rename to lowercase.

function checkRepoRoot() {
  const entries = readdirSync(REPO_ROOT);
  const violations = entries.filter(e => !ALLOWED_ROOT_ENTRIES.has(e));
  if (violations.length === 0) return 0;

  console.error(`[check-structure] VIOLATIONS at ~/robotdojo/ root:`);
  for (const v of violations) {
    const note = /^[A-Z]/.test(v) && v.endsWith('.md')
      ? '(uppercase markdown — rename to lowercase)'
      : '(not in config/root-allowlist.lock.json)';
    console.error(`  - ~/robotdojo/${v}  ${note}`);
  }
  return violations.length;
}

// ── Zone 2: ~/robotdojo/ deep tree (untracked files) ──────────────────────────

function checkRepoDeep() {
  let raw;
  try {
    // Unset GIT_DIR / GIT_WORK_TREE so git auto-detects the repo from cwd.
    // When invoked via a worktree pre-commit hook, those env vars point to the
    // worktree's git dir — causing ls-files to scan REPO_ROOT as an unrelated
    // directory and flag main-repo-only files as untracked.
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_COMMON_DIR;
    delete env.GIT_INDEX_FILE;
    raw = execSync('git ls-files --others --exclude-standard', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env,
    }).trim();
  } catch {
    return 0; // not a git repo
  }

  const violations = raw ? raw.split('\n').filter(Boolean) : [];
  if (violations.length === 0) return 0;

  console.error(`[check-structure] advisory — untracked files in ~/robotdojo/:`);
  for (const v of violations) {
    const src = join(REPO_ROOT, v);
    console.error(`  UNTRACKED: ${src}`);
  }
  console.error(`  (smart-quarantine.js classifies these — fresh WIP passes; >24h stale becomes qgrace)`);
  return violations.length;
}

// ── Zone 3: Per-directory MECE check (tracked files) ──────────────────────────

function checkPerDirMece() {
  let raw;
  try {
    raw = execSync('git ls-files', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 0;
  }

  const allFiles = raw ? raw.split('\n').filter(Boolean) : [];
  const violations = [];

  for (const rel of allFiles) {
    const topDir = rel.split('/')[0];
    if (!SOURCE_DIR_RULES[topDir]) continue;   // top-level files or unmanaged dirs

    const file = basename(rel);
    if (file.startsWith('.')) continue;        // .gitkeep, .gitignore, etc.

    const ext = extname(file).toLowerCase();
    if (ext === '') continue;                  // extensionless files — accepted
    if (UNIVERSAL_EXT.has(ext)) continue;
    if (SOURCE_DIR_RULES[topDir].ext.includes(ext)) continue;

    violations.push({ rel, topDir, ext });
  }

  if (violations.length === 0) return 0;

  console.error(`[check-structure] VIOLATIONS — files in wrong directory (MECE):`);
  for (const { rel, topDir, ext } of violations) {
    const allowed = SOURCE_DIR_RULES[topDir].ext.join(', ');
    console.error(`  - ~/robotdojo/${rel}  (${ext} not allowed in ${topDir}/, allowed: ${allowed}, .md)`);
  }
  return violations.length;
}

// ── Zone 4: ~/.robotdojo/ whitelist ───────────────────────────────────────────

function checkDotdir() {
  if (!existsSync(DOTDIR)) return 0;

  const violations = [];
  for (const entry of readdirSync(DOTDIR)) {
    if (entry.startsWith('.')) continue;
    if (!ALLOWED_DOTDIR_ENTRIES.has(entry)) {
      violations.push(entry);
    }
  }
  if (violations.length === 0) return 0;

  console.error(`[check-structure] VIOLATIONS in ~/.robotdojo/:`);
  for (const v of violations) {
    console.error(`  - ~/.robotdojo/${v}  (not in config/root-allowlist.lock.json dot_robotdojo_entries)`);
  }
  return violations.length;
}

// ── Zone 5: 24h quarantine grace ──────────────────────────────────────────────
// Files that linger in quarantine/ for >24h are stop-the-line — quarantine is
// not a parking lot. The classifier (smart-quarantine.js) is supposed to
// resolve these. This zone is fail-on-aged only — never moves files.
//
// Disabled by setting ROBOTDOJO_QUARANTINE_GRACE_DISABLED=1 (used by the
// verification cascade in code-mutation/verify.js so a fix-code mutation
// doesn't trip on its own ageing quarantine state).

function checkQuarantineGrace() {
  if (process.env.ROBOTDOJO_QUARANTINE_GRACE_DISABLED === '1') return 0;
  const quarantineDir = join(REPO_ROOT, 'quarantine');
  if (!existsSync(quarantineDir)) return 0;

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const aged = [];

  function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile()) {
        if (e.name === 'README.md') continue;
        if (e.name.startsWith('.')) continue; // dotfiles are directory infrastructure
        try {
          const mt = statSync(p).mtimeMs;
          if (mt < cutoff) aged.push({ path: p, mtimeMs: mt });
        } catch { /* skip */ }
      }
    }
  }
  walk(quarantineDir);

  if (aged.length === 0) return 0;

  console.error(`[check-structure] STOP-THE-LINE — ${aged.length} file(s) older than 24h in quarantine/:`);
  for (const a of aged) {
    const ageH = Math.round((Date.now() - a.mtimeMs) / (60 * 60 * 1000));
    console.error(`  ${a.path}  (${ageH}h old)`);
  }
  console.error('  Quarantine is stop-the-line, not parking. Resolve via smart-quarantine.js or move manually.');
  return aged.length;
}

// ── Run all zones ─────────────────────────────────────────────────────────────
// All zone checks run synchronously — they do filesystem and git reads only.
// The async IIFE below wraps only the exit path so we can await notifications
// before exiting. Zone functions themselves stay synchronous.

const counts = {
  rootAllow:  checkRepoRoot(),
  untracked:  checkRepoDeep(),
  mece:       checkPerDirMece(),
  dotdir:     checkDotdir(),
  qgrace:     checkQuarantineGrace(),
};
// Zone 2 (untracked) is advisory — smart-quarantine.js is the intelligence layer
// for live untracked files. Real rot still blocks via zone 5 (qgrace).
const total = counts.rootAllow + counts.mece + counts.dotdir + counts.qgrace;

(async () => {
  // Zone 5 (qgrace) always fires Asana regardless of --notify. A quarantine
  // grace violation is stop-the-line — the operator needs to know even if
  // gate.js was invoked by the pre-commit hook (which does not pass --notify).
  if (counts.qgrace > 0) {
    await createNotificationTask(
      `[Robot Dojo] quarantine: ${counts.qgrace} file(s) older than 24h`,
      `Zone 5 quarantine grace violation detected at ${new Date().toISOString()}.\n` +
      `${counts.qgrace} file(s) in quarantine/ are older than 24h and blocking commits.\n` +
      `Check ~/robotdojo/quarantine/ to resolve.`
    );
  }

  // Zones 1-4 only fire Asana when --notify is set (scheduled LaunchAgent run).
  // Pre-commit hook skips this path to avoid adding ~300ms latency per commit.
  if (NOTIFY && (counts.rootAllow + counts.untracked + counts.mece + counts.dotdir) > 0) {
    const zoneCount = counts.rootAllow + counts.untracked + counts.mece + counts.dotdir;
    await createNotificationTask(
      `[Robot Dojo] structure: ${zoneCount} violation(s) detected`,
      `Structure violations detected at ${new Date().toISOString()}.\n` +
      `root:${counts.rootAllow} untracked:${counts.untracked} mece:${counts.mece} dotdir:${counts.dotdir}\n` +
      `Run: node ~/robotdojo/scripts/gate.js to see details.`
    );
  }

  if (total === 0) {
    console.error('[check-structure] clean — all zones pass');
    process.exit(0);
  }

  console.error('');
  console.error('════════════════════════════════════════════════════════════════');
  console.error('  STRUCTURE VIOLATIONS DETECTED — STOP THE LINE');
  console.error(`  root: ${counts.rootAllow}  untracked: ${counts.untracked} (advisory)  mece: ${counts.mece}  dotdir: ${counts.dotdir}  qgrace: ${counts.qgrace}`);
  console.error('────────────────────────────────────────────────────────────────');
  console.error('  How to resolve:');
  console.error('    untracked → (advisory — smart-quarantine classifies) git add <file>  OR  add canonical_paths entry');
  console.error('    root      → file does not belong; consult STRUCTURE.md for correct dir');
  console.error('    mece      → file in wrong dir; move per STRUCTURE.md "What belongs"');
  console.error('    dotdir    → file in ~/.robotdojo/ violates whitelist');
  console.error('  Read STRUCTURE.md before relocating. Quarantine is stop-the-line, not parking.');
  console.error('════════════════════════════════════════════════════════════════');
  process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
