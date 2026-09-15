#!/usr/bin/env node
/**
 * check-gitignore.js — gitignore architecture audit.
 *
 * Walks every .gitignore in the repo and runs four rules:
 *
 *   policy-vs-workaround  (legacy, registry-aware)
 *     A gitignore line is a WORKAROUND if it silences a misplaced file that
 *     has a known canonical home in config/structure.json. POLICY entries are
 *     legitimate (e.g. .vercel/, node_modules/). See registry rules below.
 *
 *   root-repo-wide-only  (st_6f2343ef Rule 1)
 *     Root .gitignore must contain only repo-wide patterns. A pattern starting
 *     with `<dir>/` where <dir> is in the root lock is dir-scoped — it belongs
 *     in <dir>/.gitignore, not at root. Exceptions: file-level patterns at the
 *     root (e.g. taxonomy.user.json, identity.json) that may legitimately
 *     appear at the root path in addition to inside config/.
 *
 *   dir-only-dir-scoped  (st_6f2343ef Rule 2)
 *     <dir>/.gitignore must contain only dir-scoped patterns. A repo-wide
 *     pattern (.DS_Store, .env, .vercel, etc.) belongs at root, never in a
 *     per-dir file. Exception: node_modules/ inside a dir that locally
 *     vendors deps (e.g. gateway/) is dir-scoped to that dir and allowed.
 *
 *   every-dir-policy  (st_6f2343ef Rule 3)
 *     Every dir in the root lock either has a <dir>/.gitignore on disk OR is
 *     declared in config/root-allowlist.lock.json with `gitignorePolicy` =
 *     "no_special_rules". Forces an explicit decision per architecture/structure.md MECE.
 *
 * CLI:
 *   node scripts/check-gitignore.js                    # run all rules
 *   node scripts/check-gitignore.js --rule <name>      # run only one rule
 *
 * Rule names: policy-vs-workaround, root-repo-wide-only, dir-only-dir-scoped,
 * every-dir-policy. Unknown rule name = non-zero exit.
 *
 * WHY split into rules with --rule: AC commands need to target specific rules
 * (per st_6f2343ef plan). The negative-test harness in
 * tests/check-gitignore-rules.test.js synthesizes one violation kind at a time
 * and asserts the matching rule fires.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { loadRegistry, resetRegistryCache } from '../lib/quarantine/registry.js';
import {
  gitignorePolicyDirs,
  loadRootLock,
  perDirNodeModulesOk,
  repoWideGitignorePatterns,
  rootFileGitignorePatterns,
} from './root-lock-lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.ROBOTDOJO_GITIGNORE_REPO_ROOT || join(__dirname, '..');

// ── Root lock ────────────────────────────────────────────────────────────────
const ROOT_LOCK = loadRootLock(REPO_ROOT);
const GITIGNORE_POLICY_DIRS = gitignorePolicyDirs(ROOT_LOCK);

// Repo-wide patterns that must live at root, never in a per-dir .gitignore.
// WHY explicit list: detecting "is this pattern repo-wide?" structurally is
// hard (a glob that matches everywhere). The list captures the universal
// patterns we know about; anything not in the list is treated as dir-scoped.
const REPO_WIDE_PATTERNS_FROM_LOCK = repoWideGitignorePatterns(ROOT_LOCK);

// Dirs allowed to declare `node_modules/` in their own .gitignore. Some dirs
// vendor deps locally (gateway/) — that's dir-scoped, not a repo-wide leak.
const PER_DIR_NODE_MODULES_OK_FROM_LOCK = perDirNodeModulesOk(ROOT_LOCK);

// File-level patterns legitimately at root. WHY: e.g. taxonomy.user.json may
// fall back to repo-root in some tooling paths even though canonical home is
// config/. Listing these prevents Rule 1 false-positives.
const ROOT_FILE_PATTERNS_OK_FROM_LOCK = rootFileGitignorePatterns(ROOT_LOCK);

// ── Rule registry ─────────────────────────────────────────────────────────────
const RULES = {
  'policy-vs-workaround': rulePolicyVsWorkaround,
  'root-repo-wide-only':  ruleRootRepoWideOnly,
  'dir-only-dir-scoped':  ruleDirOnlyDirScoped,
  'every-dir-policy':     ruleEveryDirPolicy,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * findAllGitignores — locate every .gitignore tracked or untracked in the tree.
 * Uses git ls-files first (fast, respects index) and falls back to a directory
 * walk if the repo isn't initialized (e.g., test fixtures).
 */
function findAllGitignores() {
  const out = new Set();
  // Always include root if present.
  const rootIgnore = join(REPO_ROOT, '.gitignore');
  if (existsSync(rootIgnore)) out.add(rootIgnore);

  // Scan every top-level dir for a .gitignore. WHY no recursion: per-dir
  // architecture lives one level deep — the audit is concerned with
  // top-level dirs only.
  let entries;
  try {
    entries = readdirSync(REPO_ROOT, { withFileTypes: true });
  } catch {
    return [...out];
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    const p = join(REPO_ROOT, e.name, '.gitignore');
    if (existsSync(p)) out.add(p);
  }
  return [...out];
}

/**
 * parseLines — parse a .gitignore file into { lineNo, pattern } records,
 * filtering blank lines and comments.
 */
function parseLines(path) {
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    out.push({ lineNo: i + 1, pattern: trimmed });
  }
  return out;
}

/**
 * topDirOfPattern — for a pattern like "config/private.json" return "config".
 * Returns null if the pattern doesn't start with a known top-level dir
 * followed by '/'.
 */
function topDirOfPattern(pattern) {
  if (pattern.startsWith('!')) return null;     // negations passthrough
  // Strip leading slash.
  const p = pattern.replace(/^\//, '');
  const slashIdx = p.indexOf('/');
  if (slashIdx <= 0) return null;
  const dir = p.slice(0, slashIdx);
  if (GITIGNORE_POLICY_DIRS.includes(dir)) return dir;
  return null;
}

/**
 * normalizePattern — strip leading slash + inline comment for prefix
 * comparisons. Preserved from the legacy auditor for registry matching.
 */
function normalizePattern(line) {
  return line.replace(/^\//, '').replace(/\s+#.*$/, '').trim();
}

// ── Rule 0: policy vs workaround (legacy, registry-aware) ─────────────────────
// Preserved verbatim from the pre-st_6f2343ef implementation. Walks every
// .gitignore (was: only root) and applies the registry test to each line.

function isWorkaroundPattern(pattern, registry) {
  if (pattern.startsWith('!')) return null;
  if (pattern.includes('*')) return null;
  if (pattern.includes('?')) return null;
  if (pattern.includes('[')) return null;
  const norm = normalizePattern(pattern);
  if (!norm) return null;

  for (const c of registry.canonical_paths) {
    if (c.rename_from && (norm === c.rename_from || norm + '/' === c.rename_from)) {
      return { reason: `legacy filename per registry; canonical = ${c.path}`, canonical: c.path };
    }
  }
  for (const c of registry.canonical_paths) {
    if (norm.endsWith('/' + c.filename) && norm !== c.path) {
      return { reason: `${c.filename} canonical path is ${c.path}; gitignore at non-canonical position is a workaround`, canonical: c.path };
    }
  }
  if (Array.isArray(registry.pending_migrations)) {
    for (const m of registry.pending_migrations) {
      if (!m.active) continue;
      const from = m.from.replace(/\/$/, '');
      if (norm === from || norm + '/' === m.from || norm.startsWith(from + '/')) {
        return { reason: `pending migration: ${m.from} → ${m.to}; gitignoring the source masks the migration`, canonical: m.to };
      }
    }
  }
  return null;
}

function rulePolicyVsWorkaround() {
  const registry = loadRegistry();
  const errors = [];
  for (const file of findAllGitignores()) {
    const rel = file.replace(REPO_ROOT + '/', '');
    for (const { lineNo, pattern } of parseLines(file)) {
      const verdict = isWorkaroundPattern(pattern, registry);
      if (verdict) {
        errors.push(`${rel}:${lineNo}  "${pattern}"  — ${verdict.reason}`);
      }
    }
  }
  return errors;
}

// ── Rule 1: root-repo-wide-only ───────────────────────────────────────────────

function ruleRootRepoWideOnly() {
  const errors = [];
  const rootIgnore = join(REPO_ROOT, '.gitignore');
  if (!existsSync(rootIgnore)) return errors;

  for (const { lineNo, pattern } of parseLines(rootIgnore)) {
    if (pattern.startsWith('!')) continue;
    const topDir = topDirOfPattern(pattern);
    if (topDir) {
      errors.push(
        `.gitignore:${lineNo}  "${pattern}"  — Rule 1: dir-scoped pattern at root; move to ${topDir}/.gitignore`
      );
      continue;
    }
    // Allow file-only patterns even when repeated at root.
    const norm = normalizePattern(pattern);
    if (ROOT_FILE_PATTERNS_OK_FROM_LOCK.has(norm)) continue;
    if (REPO_WIDE_PATTERNS_FROM_LOCK.has(pattern) || REPO_WIDE_PATTERNS_FROM_LOCK.has(norm)) continue;
    // Patterns without a "/" at all are treated as repo-wide. WHY: gitignore
    // semantics say `foo` matches any path component; that's repo-wide.
    if (!norm.includes('/')) continue;
    errors.push(
      `.gitignore:${lineNo}  "${pattern}"  — Rule 1: root pattern with "/" is not approved in config/root-allowlist.lock.json`
    );
  }
  return errors;
}

// ── Rule 2: dir-only-dir-scoped ───────────────────────────────────────────────

function ruleDirOnlyDirScoped() {
  const errors = [];
  for (const file of findAllGitignores()) {
    if (file === join(REPO_ROOT, '.gitignore')) continue; // root excluded — Rule 1 covers it
    const rel = file.replace(REPO_ROOT + '/', '');
    const dirName = rel.replace(/\/\.gitignore$/, '');
    for (const { lineNo, pattern } of parseLines(file)) {
      if (pattern.startsWith('!')) continue;
      const norm = normalizePattern(pattern);
      // node_modules/ exception per allowlist.
      if (norm === 'node_modules/' && PER_DIR_NODE_MODULES_OK_FROM_LOCK.has(dirName)) continue;
      // Detect repo-wide patterns inside a per-dir .gitignore.
      if (REPO_WIDE_PATTERNS_FROM_LOCK.has(pattern) || REPO_WIDE_PATTERNS_FROM_LOCK.has(norm)) {
        errors.push(
          `${rel}:${lineNo}  "${pattern}"  — Rule 2: repo-wide pattern in dir-scoped file; move to root .gitignore`
        );
      }
    }
  }
  return errors;
}

// ── Rule 3: every-dir-policy ──────────────────────────────────────────────────

function ruleEveryDirPolicy() {
  const errors = [];
  for (const dir of GITIGNORE_POLICY_DIRS) {
    // Skip dirs that don't exist on disk yet; quarantine is created only when
    // needed.
    const onDisk = existsSync(join(REPO_ROOT, dir));
    if (!onDisk) continue;

    const hasIgnore = existsSync(join(REPO_ROOT, dir, '.gitignore'));
    const policy = ROOT_LOCK.entries[dir]?.gitignorePolicy;

    // Either the dir has its own .gitignore OR it explicitly opts out via
    // the registry. Anything else is an unspecified policy — reject.
    if (hasIgnore) continue;
    if (policy === 'no_special_rules') continue;
    errors.push(
      `${dir}/  — Rule 3: dir has no .gitignore and no root-lock gitignorePolicy entry (declare "no_special_rules" or add ${dir}/.gitignore)`
    );
  }
  return errors;
}

// ── Driver ────────────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const args = { rule: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rule') args.rule = argv[++i];
    else if (a.startsWith('--rule=')) args.rule = a.slice('--rule='.length);
  }
  return args;
}

function main() {
  const args = parseCliArgs(process.argv);
  resetRegistryCache(); // tests can swap registry mid-process

  let toRun;
  if (args.rule) {
    if (!RULES[args.rule]) {
      console.error(`check-gitignore: unknown rule "${args.rule}"`);
      console.error(`available: ${Object.keys(RULES).join(', ')}`);
      process.exit(2);
    }
    toRun = [[args.rule, RULES[args.rule]]];
  } else {
    toRun = Object.entries(RULES);
  }

  const allErrors = [];
  for (const [name, fn] of toRun) {
    let errs = [];
    try {
      errs = fn();
    } catch (err) {
      console.error(`check-gitignore: rule ${name} threw: ${err.message}`);
      process.exit(2);
    }
    if (errs.length) {
      allErrors.push({ rule: name, errors: errs });
    }
  }

  if (!allErrors.length) {
    console.log('check-gitignore: clean');
    process.exit(0);
  }

  console.error('check-gitignore: violations detected:');
  for (const { rule, errors } of allErrors) {
    console.error(`\n  [${rule}]`);
    for (const e of errors) console.error(`    ${e}`);
  }
  console.error('');
  console.error('Resolve by either correcting the .gitignore line or relocating the file.');
  console.error('See CLAUDE.md "gitignore is policy" for the architecture rationale.');
  process.exit(1);
}

main();
