#!/usr/bin/env node
/**
 * Enforces MECE ownership of every top-level directory the backup touches:
 * each is unambiguously GitHub's job (git-tracked source) or GCP's job
 * (whole-directory cloud sync), never both.
 *
 * The scan scope is an EXPLICIT manifest, deliberately NOT derived purely from
 * PRIVATE_DATA_ROOTS membership. `config/` and `docs/` were removed from
 * PRIVATE_DATA_ROOTS (st_e0776b46) precisely because they mix ownership — but
 * they still need auditing forever. If this checker derived its scope solely
 * from PRIVATE_DATA_ROOTS, removing a directory from the backup config would
 * also silently remove it from the MECE audit. So the named-exception
 * directories below are hardcoded, independent of PRIVATE_DATA_ROOTS.
 *
 * Two manifest categories:
 *
 *   1. Whole-directory GCP roots (derived from PRIVATE_DATA_ROOTS — the roots
 *      GCP fully owns). Assert: zero git-tracked files exist under each, EXCEPT
 *      a bare `.gitignore` housekeeping marker whose content is exactly
 *      `*` / `!.gitignore` (the marker that makes a directory GCP-only while
 *      keeping the folder itself in git).
 *
 *   2. Named-exception directories (config/, docs/ — hardcoded). These leave the
 *      whole-directory backup roots but stay under audit:
 *        - config/: every untracked file must be covered by the backup file set
 *          — the static PRIVATE_DATA_FILES entries plus the DERIVED class
 *          (every gitignored file directly under config/). A gitignored file in
 *          a config SUBDIRECTORY is not covered by the derived rule and is the
 *          real failure this arm still catches.
 *        - docs/: every untracked file must match rebuild-report-*.md and
 *          nothing else untracked may exist (regenerable build output only).
 *
 * df_3df1f108 AC3(e): CONFIG_EXPECTED_UNTRACKED used to RESTATE the config
 * secrets that lib/private-data-roots.js already listed, and the two copies
 * drifted — `config/source-topic-routing.user.json` was backed up and flagged
 * as unexpected at the same time. A detector that names one wrong file
 * alongside three right ones trains the owner to discount it. The two lists are
 * now one list, derived.
 *
 * Exit 0 on full pass; exit 1 naming the offending file(s) on any violation.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve, join, basename, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRIVATE_DATA_FILES, PRIVATE_DATA_ROOTS } from '../lib/private-data-roots.js';
import { discoverPrivateConfigFiles, isPrivateConfigFile } from '../lib/backup-coverage.js';

export const INTELLIGENCE_TIER = 'extraction';

// The tree under audit. Defaults to the repository this script lives in;
// `--repo` / ROBOTDOJO_REPO_ROOT point it at another checkout, which is what
// makes the gate runnable from a build worktree against the live tree.
function resolveRepoRoot(argv = process.argv) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--repo') return resolve(argv[i + 1]);
  }
  if (process.env.ROBOTDOJO_REPO_ROOT) return resolve(process.env.ROBOTDOJO_REPO_ROOT);
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

const repoRoot = resolveRepoRoot();

// The bare git-housekeeping marker: a `.gitignore` whose only job is to keep an
// otherwise-empty, fully GCP-owned directory present in git. Content is exactly
// `*` then `!.gitignore` (trailing newline tolerated). Such a file does not count
// against a directory's GCP ownership.
const GITIGNORE_MARKER_CONTENT = '*\n!.gitignore';

const DOCS_UNTRACKED_PATTERN = /^docs\/rebuild-report-.*\.md$/;

/**
 * The config/ files the backup covers, DERIVED rather than restated: the static
 * PRIVATE_DATA_FILES entries under config/, plus every gitignored file directly
 * under config/. One list, so it cannot drift out of agreement with the backup.
 */
function coveredConfigFiles() {
  const statics = PRIVATE_DATA_FILES.map((file) => file.local).filter((local) => local.startsWith('config/'));
  const discovered = discoverPrivateConfigFiles(repoRoot).map((file) => file.local);
  return new Set([...statics, ...discovered]);
}

/** Tracked (git ls-files) paths under `dir`, repo-relative POSIX, sorted. */
function gitTracked(dir) {
  const result = spawnSync('git', ['ls-files', '-z', '--', dir], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.toString('utf8') || `git ls-files failed for ${dir}`);
  }
  return result.stdout.toString('utf8').split('\0').filter(Boolean).sort();
}

/** Every physical file under `dir`, repo-relative POSIX, sorted. Includes
 *  gitignored files (untracked = physical − tracked, matching AC verification). */
function physicalFiles(dir) {
  const absDir = join(repoRoot, dir);
  if (!existsSync(absDir)) return [];
  const out = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        walk(child);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(relative(repoRoot, child).split(sep).join('/'));
      }
    }
  };
  walk(absDir);
  return out.sort();
}

/** True when `relPath` is a bare `.gitignore` marker (`*` / `!.gitignore`). */
function isGitignoreMarker(relPath) {
  if (basename(relPath) !== '.gitignore') return false;
  try {
    return readFileSync(join(repoRoot, relPath), 'utf8').trim() === GITIGNORE_MARKER_CONTENT;
  } catch {
    return false;
  }
}

/** Untracked files under `dir` = physical − tracked (includes gitignored). */
function untrackedFiles(dir) {
  const tracked = new Set(gitTracked(dir));
  return physicalFiles(dir).filter((p) => !tracked.has(p));
}

function checkWholeDirRoot(dir, errors) {
  const offenders = gitTracked(dir).filter((p) => !isGitignoreMarker(p));
  if (offenders.length) {
    errors.push(`GCP-owned root '${dir}/' has git-tracked file(s) — mixed ownership: ${offenders.join(', ')}`);
  }
}

function checkConfigExact(errors) {
  const covered = coveredConfigFiles();
  // The failure this still catches: a gitignored file in a config SUBDIRECTORY.
  // The derived rule reaches only files directly under config/, so a secret one
  // level down is uncovered — and that is exactly the silent miss the original
  // exact-list check existed to prevent.
  const uncovered = untrackedFiles('config').filter((p) => !covered.has(p) && !isPrivateConfigFile(p));
  if (uncovered.length) {
    errors.push(`config/ has untracked file(s) no backup rule covers (the derived rule reaches only files directly under config/): ${uncovered.join(', ')}`);
  }
}

function checkDocsPattern(errors) {
  const bad = untrackedFiles('docs').filter((p) => !DOCS_UNTRACKED_PATTERN.test(p));
  if (bad.length) {
    errors.push(`docs/ has untracked file(s) outside the regenerable rebuild-report-*.md pattern: ${bad.join(', ')}`);
  }
}

function main() {
  const errors = [];

  // Category 1: whole-directory GCP roots (from PRIVATE_DATA_ROOTS), minus any
  // that are named exceptions (defensive — config/docs are already removed).
  const NAMED_EXCEPTIONS = new Set(['config', 'docs']);
  const wholeDirRoots = PRIVATE_DATA_ROOTS.map((r) => r.local).filter((d) => !NAMED_EXCEPTIONS.has(d));
  for (const dir of wholeDirRoots) checkWholeDirRoot(dir, errors);

  // Category 2: named-exception directories — hardcoded, always audited.
  checkConfigExact(errors);
  checkDocsPattern(errors);

  if (errors.length) {
    console.error('BLOCKED: backup ownership is not MECE:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  console.log('[check-backup-mece] ok — every backup directory is unambiguously GitHub-owned or GCP-owned');
}

main();
