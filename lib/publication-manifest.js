/**
 * lib/publication-manifest.js — AC3: the published copy's contents are decided
 * by an explicit written list, not by whatever happens to be tracked
 * (st_dd0e19d8 Phase 3).
 *
 * TWO PROPERTIES, AND THEY ARE DIFFERENT PROPERTIES.
 *
 *   1. A tracked file that is not on the list cannot reach the published copy.
 *      That comes from CONSTRUCTION: the publication step materialises the file
 *      set by resolving this manifest, so a file the manifest excludes is never
 *      copied. It is not a filter applied to a tree that already contains
 *      everything — research Recommendation 8: a manifest fails closed, an
 *      after-the-fact allowlist fails open.
 *
 *   2. Adding a tracked file does not SILENTLY add it to what ships. That is a
 *      different property and globs alone cannot give it, because a broad
 *      include glob happily absorbs a new file. It comes from the LOCK: the
 *      manifest records the file count and a digest of the resolved set, and the
 *      publication step refuses when today's resolution differs. The owner then
 *      either accepts the new file into the lock or excludes it. Either way he
 *      decided.
 *
 * WHY GLOBS PLUS A LOCK RATHER THAN 1,496 LITERAL PATHS (design §3.2). Both
 * shapes give property 2. The literal list also costs a 1,496-line file that
 * churns on every commit, and a diff that large is a diff nobody reads — which
 * is how a real addition slips through a review. The lock is one digest; a
 * changed digest is unmissable.
 *
 * WHY THE LOCK CARRIES A COMMIT. A digest tells the owner THAT the set moved.
 * It cannot tell him WHICH file moved, and a refusal he cannot act on is a
 * refusal he learns to bypass. The repository already stores the answer: the
 * file list at the commit the lock was written against. So the lock records that
 * commit, and a mismatch is reported as the actual added and removed paths,
 * derived rather than duplicated. When the commit is unreachable (a shallow
 * clone, an export tree) the check degrades to counts and SAYS SO instead of
 * pretending to know.
 *
 * NO OWNER DATA LIVES IN THIS FILE, and none may enter config/publication-
 * manifest.json: it is tracked and it ships. Path globs only.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_FILE = 'publication-manifest.json';

/**
 * Glob syntax, stated in full because a matcher whose semantics are guessed is a
 * gate whose scope is guessed:
 *
 *   **   matches ZERO OR MORE whole path segments. `**\/tests/**` therefore
 *        matches `tests/a.js` (zero leading segments) and `scripts/qa/tests/a.js`.
 *   *    matches any run of characters WITHIN one segment; it never crosses `/`.
 *   ?    matches exactly one character within a segment.
 *
 * Everything else is literal. Matching is whole-path anchored and case-sensitive
 * — the repository is case-sensitive in git regardless of the filesystem it is
 * checked out on, and a case-insensitive rule would silently widen every
 * exclusion.
 */
export function globToRegExp(glob) {
  const segment = (s) =>
    s
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
  const parts = String(glob).split('/');
  let source = '^';
  parts.forEach((part, i) => {
    const isLast = i === parts.length - 1;
    if (part === '**') {
      // Trailing `**` swallows the remainder, slashes included. An interior one
      // consumes whole segments only — zero or more, each with its separator —
      // so a leading `**` matches a root-level path as well as a nested one.
      source += isLast ? '.*' : '(?:[^/]+/)*';
      return;
    }
    source += segment(part);
    if (!isLast) source += '/';
  });
  return new RegExp(`${source}$`);
}

/** Compile `[{glob, reason}]` into matchers, preserving the reason for reporting. */
export function compileRules(rules) {
  return (rules || []).map((r) => ({ ...r, re: globToRegExp(r.glob) }));
}

/**
 * Validate the manifest's shape. Returns human-readable errors; empty means
 * sound. Callers treat a non-empty result as fatal — a manifest that cannot be
 * read must never degrade to "ship everything".
 *
 * Every rule carries a REASON, include rules as well as exclude rules. The
 * posture table already holds that line (`skip_paths` entries require one) and
 * it holds for the same argument: an exclusion nobody can justify later is an
 * exclusion nobody can audit.
 */
export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return ['manifest is absent or not an object'];
  for (const key of ['include', 'exclude']) {
    const rules = manifest[key];
    if (!Array.isArray(rules)) {
      errors.push(`manifest has no "${key}" array`);
      continue;
    }
    rules.forEach((r, i) => {
      const at = `${key}[${i}]`;
      if (!r || typeof r !== 'object') {
        errors.push(`${at}: not an object — every rule is {glob, reason}`);
        return;
      }
      if (typeof r.glob !== 'string' || !r.glob.trim()) errors.push(`${at}: "glob" is missing or empty`);
      if (typeof r.reason !== 'string' || !r.reason.trim()) {
        errors.push(`${at}: "reason" is missing — a rule nobody can justify is a rule nobody can audit`);
      }
    });
  }
  if (Array.isArray(manifest.include) && manifest.include.length === 0) {
    errors.push('manifest "include" is empty — that resolves to an empty published set, which is not a manifest');
  }
  if (manifest.lock !== undefined) {
    const lock = manifest.lock;
    if (!lock || typeof lock !== 'object') errors.push('manifest "lock" is present but not an object');
    else {
      if (!Number.isInteger(lock.files) || lock.files < 0) errors.push('manifest lock has no integer "files" count');
      if (typeof lock.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(lock.digest)) {
        errors.push('manifest lock has no "digest" of the form sha256:<64 hex>');
      }
    }
  }
  return errors;
}

/** Load and validate. Throws on a manifest that cannot be trusted. */
export function loadManifest(configDir) {
  const path = join(configDir, MANIFEST_FILE);
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`publication manifest ${path} is unreadable: ${err.message}`);
  }
  const errors = validateManifest(parsed);
  if (errors.length > 0) throw new Error(`publication manifest ${path} is unusable:\n  ${errors.join('\n  ')}`);
  return parsed;
}

/**
 * Apply the manifest to a list of tracked paths. Exclusion wins over inclusion —
 * the include glob bounds the universe and the exclude list refines inside it
 * (Copybara's shape, research External §3).
 *
 * Returns paths SORTED, because the digest is taken over this list and a digest
 * that depends on the order git happened to return files is not a digest.
 */
export function applyManifest(manifest, trackedPaths) {
  const include = compileRules(manifest.include);
  const exclude = compileRules(manifest.exclude);
  const paths = trackedPaths.filter(
    (p) => include.some((r) => r.re.test(p)) && !exclude.some((r) => r.re.test(p))
  );
  return paths.sort();
}

/**
 * Resolve the manifest against the live tracked set.
 *
 * `deps.trackedFiles()` is injected so this module never shells out; the CLI
 * facade owns git (build-conventions thin-facade rule).
 *
 * REFUSES on an empty tracked set. Every other guard in this story exists
 * because a check that scans nothing reports clean; a manifest that resolves to
 * nothing would publish an empty repository and call it success.
 */
export function resolveManifest(deps, manifest) {
  const tracked = deps.trackedFiles();
  if (!Array.isArray(tracked) || tracked.length === 0) {
    throw new Error('the tracked file set is empty — refusing to resolve a manifest against nothing');
  }
  const paths = applyManifest(manifest, tracked);
  if (paths.length === 0) {
    throw new Error(
      `the manifest resolved ${tracked.length} tracked file(s) to an empty published set — `
        + 'check the include globs'
    );
  }
  return { paths, tracked: tracked.length, excluded: tracked.length - paths.length };
}

/** The lock's comparison unit: a digest over the sorted resolved path list. */
export function manifestDigest(paths) {
  return `sha256:${createHash('sha256').update(paths.join('\n')).digest('hex')}`;
}

/**
 * Compare today's resolved set against the recorded lock.
 *
 * Returns `{ ok, errors, added, removed, named }`. `named` is false when the
 * lock's commit could not be read here, in which case `added`/`removed` are
 * empty and the caller must say so rather than imply the set is unchanged in
 * detail it never checked.
 *
 * `deps.filesAtCommit(commit)` returns the tracked paths at that commit, or null
 * when it is unreachable.
 */
export function assertManifestLock(deps, manifest, resolved) {
  const lock = manifest.lock;
  const digest = manifestDigest(resolved.paths);
  if (!lock) {
    return {
      ok: false,
      errors: [
        'the manifest carries no lock. Without one, a newly tracked file joins the published set silently, '
          + 'which is exactly what AC3 forbids. Record one with --write-lock.',
      ],
      added: [],
      removed: [],
      named: false,
      digest,
    };
  }
  if (lock.digest === digest && lock.files === resolved.paths.length) {
    return { ok: true, errors: [], added: [], removed: [], named: true, digest };
  }

  const errors = [
    `the published set no longer matches the lock: ${lock.files} file(s) locked, ${resolved.paths.length} today`,
    `  locked digest ${lock.digest}`,
    `  today         ${digest}`,
  ];
  let added = [];
  let removed = [];
  let named = false;
  const at = lock.commit ? deps.filesAtCommit(lock.commit) : null;
  if (at) {
    const before = new Set(applyManifest(manifest, at));
    const now = new Set(resolved.paths);
    added = [...now].filter((p) => !before.has(p)).sort();
    removed = [...before].filter((p) => !now.has(p)).sort();
    named = true;
    // A lock whose own commit does not reproduce its digest has been edited by
    // hand or against a different manifest. Say so — the numbers below would
    // otherwise be attributed to the working tree.
    const lockedDigest = manifestDigest([...before].sort());
    if (lockedDigest !== lock.digest) {
      errors.push(
        `  WARNING: resolving the manifest at ${lock.commit} yields ${lockedDigest}, not the recorded `
          + `${lock.digest}. The lock was not written from that commit, so the paths below are approximate.`
      );
    }
  } else {
    errors.push(
      `  the lock's commit (${lock.commit || 'none recorded'}) is not readable here, so the specific files `
        + 'cannot be named — only the counts above are known.'
    );
  }
  return { ok: false, errors, added, removed, named, digest };
}
