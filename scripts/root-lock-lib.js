#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(__dirname, '..');

export const CORE_PROTECTED_FILES = Object.freeze([
  '.gitignore',
  '.vercelignore',
  '.github/CODEOWNERS',
  '.github/workflows/root-lock.yml',
  'CLAUDE.md',
  'architecture/architecture.md',
  'architecture/ontology.md',
  'architecture/product.md',
  'architecture/sitemap.md',
  'architecture/structure.md',
  'architecture/surfaces.json',
  'config/root-allowlist.lock.json',
  'config/root-allowlist.schema.json',
  'config/structure.json',
  'docs/launch-agents.md',
  'lib/private-data-roots.js',
  'scripts/check-backup-recoverability.js',
  'scripts/check-final-structure-lib.js',
  'scripts/check-final-structure-registries.js',
  'scripts/check-final-structure-root-model.js',
  'scripts/check-final-structure.js',
  'scripts/check-gitignore.js',
  'scripts/check-root-lock.js',
  'scripts/check-vercelignore-private-data.js',
  'scripts/gate.js',
  'scripts/gate-human-authored.js',
  'scripts/generate-ontology.js',
  'scripts/pre-commit.sh',
  'scripts/root-lock-lib.js',
]);

export function normalizeRelPath(path) {
  return path.split('\\').join('/');
}

export function rootLockPath(repoRoot = DEFAULT_REPO_ROOT) {
  const override = process.env.ROBOTDOJO_ROOT_LOCK_PATH;
  if (override) return isAbsolute(override) ? override : resolve(repoRoot, override);
  return join(repoRoot, 'config', 'root-allowlist.lock.json');
}

export function loadRootLock(repoRoot = DEFAULT_REPO_ROOT) {
  const path = rootLockPath(repoRoot);
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateRootLock(lock);
  if (errors.length) {
    throw new Error(`root allowlist lock malformed:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }
  return lock;
}

export function rootLockApprovalPath() {
  return join(homedir(), '.robotdojo', 'root-lock-approvals.json');
}

export function validateRootLock(lock) {
  const errors = [];
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    return ['lock must be a JSON object'];
  }
  if (lock.owner_approval_required !== true) errors.push('owner_approval_required must be true');
  if (!lock.owner_codeowner || !/^@[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/.test(lock.owner_codeowner)) {
    errors.push('owner_codeowner must be a GitHub user or team slug like @owner or @org/team');
  }
  if (!lock.entries || typeof lock.entries !== 'object' || Array.isArray(lock.entries)) {
    errors.push('entries must be an object');
  }
  for (const [name, entry] of Object.entries(lock.entries || {})) {
    if (!name || name.includes('/')) errors.push(`entry key must be a root name, got ${name}`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${name}: entry must be an object`);
      continue;
    }
    if (!['dir', 'file'].includes(entry.type)) errors.push(`${name}: type must be dir or file`);
    if (!['github', 'gcp', 'mixed', 'regenerable'].includes(entry.class)) {
      errors.push(`${name}: class must be github, gcp, mixed, or regenerable`);
    }
    if (typeof entry.required !== 'boolean') errors.push(`${name}: required must be boolean`);
    if (!entry.purpose) errors.push(`${name}: purpose is required`);
    if (entry.extensions && !Array.isArray(entry.extensions)) errors.push(`${name}: extensions must be an array`);
    if (entry.gitignorePolicy && !['has_gitignore', 'no_special_rules', 'repo_wide'].includes(entry.gitignorePolicy)) {
      errors.push(`${name}: invalid gitignorePolicy`);
    }
  }
  for (const name of lock.retired || []) {
    if (lock.entries?.[name]) errors.push(`${name}: cannot be both retired and allowed`);
  }
  return errors;
}

export function protectedFiles(lock) {
  return [...new Set([...CORE_PROTECTED_FILES, ...(lock.protected_files || [])])].sort();
}

export function canonicalSurfaceFiles(repoRoot = DEFAULT_REPO_ROOT) {
  const path = join(repoRoot, 'architecture', 'surfaces.json');
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const surfaces = Array.isArray(parsed) ? parsed : parsed.surfaces || [];
  return surfaces
    .map((surface) => surface?.path)
    .filter((path) => path && !path.startsWith('~/') && !path.startsWith('user/'))
    .map(normalizeRelPath);
}

export function repoTopLevelEntries(repoRoot = DEFAULT_REPO_ROOT) {
  return readdirSync(repoRoot).sort();
}

export function sourceDirRules(lock) {
  const out = {};
  for (const [name, entry] of Object.entries(lock.entries || {})) {
    if (entry.type === 'dir' && Array.isArray(entry.extensions)) {
      out[name] = { ext: entry.extensions };
    }
  }
  return out;
}

export function gitignorePolicyDirs(lock) {
  return Object.entries(lock.entries || {})
    .filter(([, entry]) => entry.type === 'dir' && !entry.hidden && entry.gitignorePolicy && entry.gitignorePolicy !== 'repo_wide')
    .map(([name]) => name)
    .sort();
}

export function repoWideGitignorePatterns(lock) {
  return new Set(lock.gitignore?.repo_wide_patterns || []);
}

export function rootFileGitignorePatterns(lock) {
  return new Set(lock.gitignore?.root_file_patterns || []);
}

export function perDirNodeModulesOk(lock) {
  return new Set(lock.gitignore?.per_dir_node_modules_ok || []);
}

export function dotRobotdojoEntries(lock) {
  return new Set(lock.dot_robotdojo_entries || []);
}

export function gitFiles(repoRoot, args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.toString('utf8') || `git ${args.join(' ')} failed`);
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(normalizeRelPath)
    .sort();
}

export function stagedFiles(repoRoot = DEFAULT_REPO_ROOT) {
  if (process.env.ROBOTDOJO_STAGED_FILES) {
    return process.env.ROBOTDOJO_STAGED_FILES.split('\n').filter(Boolean).map(normalizeRelPath);
  }
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACMRD', {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean).map(normalizeRelPath);
  } catch {
    return [];
  }
}

export function sameOrUnder(path, root) {
  const p = root.endsWith('/') ? root : `${root}/`;
  return path === root || path.startsWith(p);
}

export function trackedUnder(repoRoot, root) {
  const tracked = gitFiles(repoRoot, ['ls-files', '-z']);
  return tracked.filter((path) => sameOrUnder(path, root));
}

export function fileExists(repoRoot, relPath) {
  return existsSync(join(repoRoot, relPath));
}

/**
 * refreshDeterministicApproval(repoRoot, files, { storyId, ownerQuote }) → number
 *
 * st_a5baa72c AC2/AC3. The pre-commit de-tax auto-stages deterministic
 * regenerated protected outputs; check-root-lock would otherwise demand a
 * local approval keyed to the just-regenerated blob, which cannot exist yet.
 * This writes/refreshes that approval keyed to the STAGED sha for exactly
 * those files under the active story — safe because a deterministic regen
 * is a byte-exact projection of committed sources, not a hand-edit.
 * check-root-lock still requires the file be in an open story's
 * meta.touches; this only satisfies the sha match, and only changed shas
 * are written. `files` are repo-relative.
 */
export function refreshDeterministicApproval(repoRoot, files, { storyId, ownerQuote } = {}) {
  if (!storyId || !Array.isArray(files) || files.length === 0) return 0;
  const approvalPath = rootLockApprovalPath();
  let doc = { approvals: [] };
  if (existsSync(approvalPath)) {
    const parsed = JSON.parse(readFileSync(approvalPath, 'utf8'));
    doc = Array.isArray(parsed) ? { approvals: parsed } : (parsed.approvals ? parsed : { approvals: [] });
  }
  let entry = doc.approvals.find((a) => a && a.story_id === storyId);
  if (!entry) {
    entry = { story_id: storyId, owner_quote: ownerQuote || 'deterministic de-tax regeneration (owner sources)', files: {} };
    doc.approvals.push(entry);
  }
  if (ownerQuote) entry.owner_quote = ownerQuote;
  entry.files = entry.files || {};
  let n = 0;
  for (const file of files) {
    const sha = stagedBlobSha256(repoRoot, file);
    if (!sha) continue;
    if (entry.files[file] !== sha) {
      entry.files[file] = sha;
      n++;
    }
  }
  if (n > 0) {
    mkdirSync(dirname(approvalPath), { recursive: true });
    writeFileSync(approvalPath, JSON.stringify(doc, null, 2) + '\n');
  }
  return n;
}

/**
 * addStagedTouches(repoRoot, files, { storyId }) → count (st_fdd414de AC1).
 * Unions staged de-tax outputs into the story's meta.touches so check-root-lock
 * (needs an open story listing each staged protected path) passes. Only staged
 * files are added; writes back only on change. Story dir via
 * PIPELINE_STORIES_DIR (ROBOTDOJO_STORIES_DIR retargets it in tests).
 */
export function addStagedTouches(repoRoot, files, { storyId } = {}) {
  if (!storyId || !Array.isArray(files) || files.length === 0) return 0;
  const metaPath = join(PIPELINE_STORIES_DIR, storyId, 'meta.json');
  if (!existsSync(metaPath)) return 0;
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return 0;
  }
  const existing = new Set(Array.isArray(meta.touches) ? meta.touches.map(normalizeRelPath) : []);
  let added = 0;
  for (const raw of files) {
    const file = normalizeRelPath(raw);
    // Only union files actually staged — never list a path the commit lacks.
    const staged = spawnSync('git', ['cat-file', '-e', `:${file}`], { cwd: repoRoot });
    if (staged.status !== 0) continue;
    if (!existing.has(file)) {
      existing.add(file);
      added++;
    }
  }
  if (added > 0) {
    meta.touches = [...existing].sort();
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  }
  return added;
}

/**
 * bootstrapDeterministicCommit(repoRoot, files, { storyId, ownerQuote })
 *   → { touchesAdded, approvalsRefreshed }
 * st_fdd414de AC1. The de-tax's single post-stage call: injects staged paths
 * into meta.touches AND refreshes the local approval, both keyed to one
 * storyId, so a regen-triggered commit is hands-off. Safe: deterministic
 * regen is a byte-exact projection of committed sources, not a hand-edit.
 */
export function bootstrapDeterministicCommit(repoRoot, files, { storyId, ownerQuote } = {}) {
  const touchesAdded = addStagedTouches(repoRoot, files, { storyId });
  const approvalsRefreshed = refreshDeterministicApproval(repoRoot, files, { storyId, ownerQuote });
  return { touchesAdded, approvalsRefreshed };
}

/**
 * committedBlobSha256(repoRoot, file) → sha256 hex | null
 *
 * sha256 of the file's bytes as COMMITTED at HEAD (`git show HEAD:<file>`),
 * mirroring check-root-lock.js's own staged-blob helper. st_a5baa72c AC3
 * needs the committed blob: the /build commit lands (SKILL step 6) before
 * the owner's countersign, so by `--approve build` time the protected file
 * is already committed and the index entry is empty. No edit occurs
 * between the build commit and the close commit, so the committed sha
 * equals what close will stage — an approval keyed to it matches
 * check-root-lock's localApprovalMatches. Returns null if the file is not
 * in HEAD (untracked / new-in-index); effectiveBlobSha256 below returns
 * the staged blob for that case (st_5e810098 AC4).
 */
export function committedBlobSha256(repoRoot, file) {
  const exists = spawnSync('git', ['cat-file', '-e', `HEAD:${file}`], { cwd: repoRoot });
  if (exists.status !== 0) return null;
  const result = spawnSync('git', ['show', `HEAD:${file}`], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return createHash('sha256').update(result.stdout).digest('hex');
}

// Staged index blob sha256 (`git show :<file>`), mirrors check-root-lock.js's
// private helper — exported for check-preseal-protected-touches.js (st_5e810098).
export function stagedBlobSha256(repoRoot, file) {
  const exists = spawnSync('git', ['cat-file', '-e', `:${file}`], { cwd: repoRoot });
  if (exists.status !== 0) return null;
  const r = spawnSync('git', ['show', `:${file}`], { cwd: repoRoot, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return createHash('sha256').update(r.stdout).digest('hex');
}

// Staged blob if anything is staged, else the committed blob at HEAD. The
// approval writeRootLockApprovalForBuild records must key to what the commit
// will contain — the STAGED bytes — because check-root-lock compares the
// approval against the staged blob. The old committed-first order keyed a
// MODIFIED protected file's approval to stale HEAD content, so the staged blob
// no longer matched: mismatch, commit blocked (st_5e810098). Falling back to
// committed only when nothing is staged still covers the new-file (committed
// null) and already-landed (staged null) cases.
export function effectiveBlobSha256(repoRoot, file) {
  return stagedBlobSha256(repoRoot, file) ?? committedBlobSha256(repoRoot, file);
}
