/**
 * executor.js — Layer 2 of the two-layer action enforcement.
 *
 * WHY a hard allowlist + destination validator before any handler runs:
 * Cursor CVE GHSA-82wg-qcm4-fp2w showed that schema-side enforcement (Layer 1)
 * fails alone — the LLM can be coaxed into outputting actions outside the
 * whitelist. We rebuild the same whitelist on this side and reject anything
 * that doesn't match BEFORE dispatch. Also rejects unregistered destinations
 * (so a coaxed `move-to-canonical` to `lib/secret-exfil/` fails too).
 *
 * Pattern: NEVER use a default-permissive switch. Branch from the allowlist
 * Set, throw on miss, dispatch only known actions.
 */

import { renameSync, mkdirSync, existsSync, statSync, readFileSync, copyFileSync, utimesSync } from 'node:fs';
import { join, dirname, basename, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ALLOWED_ACTIONS, validateDecision } from './schema.js';
import { canonicalPaths, loadRegistry } from './registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const _ALLOWED = new Set(ALLOWED_ACTIONS);

/**
 * defaultRepoRoot — REPO_ROOT/.. .. resolved from this module.
 */
function defaultRepoRoot() {
  return join(__dirname, '..', '..');
}

/**
 * validateDestination — rejects unregistered destinations.
 *
 * Accepts: any path under quarantine/, .robotdojo/ (dotdir canonical
 * destinations are valid), OR a path matching a canonical_paths entry.
 *
 * dest may be repo-relative ("config/taxonomy.user.json"), absolute under the
 * repo, or absolute under home (for ~/.robotdojo/* canonical paths).
 */
export function validateDestination(dest, opts = {}) {
  const repoRoot = opts.repoRoot || defaultRepoRoot();
  const home = opts.home || homedir();
  const registry = opts.registry || loadRegistry();

  if (typeof dest !== 'string' || dest.length === 0) {
    throw new Error('destination must be a non-empty string');
  }

  // Normalize to a repo-relative form for comparison if possible.
  let relPath = dest;
  if (isAbsolute(dest)) {
    if (dest.startsWith(repoRoot + '/')) {
      relPath = relative(repoRoot, dest);
    } else if (dest.startsWith(home + '/')) {
      relPath = relative(home, dest);
    } else {
      throw new Error(`destination outside repo and home: ${dest}`);
    }
  }

  // Reject backreferences and absolute-looking relpaths.
  if (relPath.includes('..')) {
    throw new Error(`destination contains backreference: ${dest}`);
  }

  // Allow quarantine/ and .robotdojo/ (the dotdir).
  const ALLOWED_PREFIXES = ['quarantine/', '.robotdojo/'];
  for (const prefix of ALLOWED_PREFIXES) {
    if (relPath.startsWith(prefix)) return relPath;
  }

  // Allow any path that exactly matches a canonical_paths entry, OR is under
  // a registered canonical directory (e.g. config/taxonomy.user.json is canonical;
  // config/health-ui.json under config/ is a registered dir, but we don't open
  // up the whole config/ — only exact-path matches count for canonical entries).
  for (const c of canonicalPaths(registry)) {
    if (relPath === c) return relPath;
  }

  throw new Error(`destination not registered: ${dest}`);
}

/**
 * sha256OfFile — used for never-delete duplicate routing.
 */
function sha256OfFile(p) {
  const buf = readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * touchToNow — refresh atime+mtime to the current instant. Used after moving
 * a file into quarantine/ so the 24h grace timer in check-structure.js
 * starts at the moment of entry, not the file's original mtime. Without this,
 * `renameSync` preserves the original mtime and a freshly-quarantined file
 * can immediately trip the grace alarm if the original was already old.
 */
function touchToNow(p) {
  try {
    const now = new Date();
    utimesSync(p, now, now);
  } catch {
    // best-effort — never fail the move because of a stat update
  }
}

/**
 * resolveDest — convert a repo-relative destination string to an absolute
 * path. Paths starting with `.robotdojo/` resolve under HOME, everything else
 * resolves under REPO_ROOT.
 */
function resolveDest(relPath, opts = {}) {
  const repoRoot = opts.repoRoot || defaultRepoRoot();
  const home = opts.home || homedir();
  if (relPath.startsWith('.robotdojo/')) {
    return join(home, relPath);
  }
  return join(repoRoot, relPath);
}

/**
 * resolveSrc — accept absolute or repo-relative source paths.
 */
function resolveSrc(src, opts = {}) {
  const repoRoot = opts.repoRoot || defaultRepoRoot();
  if (isAbsolute(src)) return src;
  return join(repoRoot, src);
}

// ── Action handlers ──────────────────────────────────────────────────────────

/**
 * moveToCanonical — atomic move from src to destination. If destination
 * exists with matching content, no-op (idempotent). If destination exists with
 * different content, fall back to quarantine/duplicates/<sha>-<basename> per
 * the never-delete rule (both copies retained).
 */
export function moveToCanonical(decision, opts = {}) {
  const repoRoot = opts.repoRoot || defaultRepoRoot();
  const srcAbs = resolveSrc(decision.file, { repoRoot });
  let destAbs = resolveDest(decision.destination, opts);

  // If destination is a directory (trailing slash, OR the path resolves to an
  // existing directory), append a timestamped basename. WHY: signals like
  // db-redundancy and pending-migration emit a directory destination — they
  // don't know the final filename. The mover is responsible for landing it.
  const destIsDir = decision.destination.endsWith('/') ||
    (existsSync(destAbs) && statSync(destAbs).isDirectory());
  if (destIsDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    destAbs = join(destAbs, `${ts}-${basename(srcAbs)}`);
  }

  if (!existsSync(srcAbs)) {
    return { result: 'skipped', reason: 'source missing', src: srcAbs };
  }

  if (existsSync(destAbs)) {
    // Content equal → idempotent no-op.
    const srcHash = sha256OfFile(srcAbs);
    const dstHash = sha256OfFile(destAbs);
    if (srcHash === dstHash) {
      return { result: 'noop', reason: 'destination has identical content', src: srcAbs, dest: destAbs };
    }
    // Different content → never-delete: route the source to duplicates.
    const dupDir = join(repoRoot, 'quarantine', 'duplicates');
    mkdirSync(dupDir, { recursive: true });
    const dupName = `${srcHash}-${basename(srcAbs)}`;
    const dupPath = join(dupDir, dupName);
    if (!existsSync(dupPath)) {
      renameSync(srcAbs, dupPath);
      touchToNow(dupPath); // start the 24h grace from entry time, not original mtime
    }
    return {
      result: 'duplicate-routed',
      reason: 'destination existed with different content; preserved both copies',
      src: srcAbs,
      dest: dupPath,
    };
  }

  mkdirSync(dirname(destAbs), { recursive: true });
  renameSync(srcAbs, destAbs);
  // If the destination is inside quarantine/, refresh mtime so the 24h grace
  // timer measures time-in-quarantine, not original file age.
  if (destAbs.includes(`${repoRoot}/quarantine/`)) touchToNow(destAbs);
  return { result: 'moved', src: srcAbs, dest: destAbs };
}

/**
 * quarantineAction — move to quarantine/<subdir>/<timestamp>-<basename>.
 * Default subdir is `quarantine/general/` if destination doesn't already
 * encode one.
 */
export function quarantineAction(decision, opts = {}) {
  const repoRoot = opts.repoRoot || defaultRepoRoot();
  const srcAbs = resolveSrc(decision.file, { repoRoot });
  // The classifier's `destination` for quarantine should already start with
  // "quarantine/<subdir>/" — destination validator ensures this.
  let destAbs = resolveDest(decision.destination, opts);

  // If the destination is just a directory (ends with /) or doesn't include a
  // basename, append a timestamped basename.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (decision.destination.endsWith('/')) {
    destAbs = join(destAbs, `${ts}-${basename(srcAbs)}`);
  }

  if (!existsSync(srcAbs)) {
    return { result: 'skipped', reason: 'source missing', src: srcAbs };
  }
  mkdirSync(dirname(destAbs), { recursive: true });
  renameSync(srcAbs, destAbs);
  // Quarantine entries always start the 24h grace from the moment they land here.
  touchToNow(destAbs);
  return { result: 'quarantined', src: srcAbs, dest: destAbs };
}

/**
 * fixCodeAction — placeholder that delegates to code-mutation. The handler
 * is wired by the orchestrator to avoid a circular dep at import time.
 *
 * Default behavior: throw, telling the caller they need to inject the handler.
 * The orchestrator (lib/quarantine/index.js) overrides this via the `handlers`
 * argument to `execute()`.
 */
export function fixCodeAction() {
  throw new Error('fix-code handler not wired; call execute(decision, { handlers: { "fix-code": ... } })');
}

const DEFAULT_HANDLERS = Object.freeze({
  'move-to-canonical': moveToCanonical,
  'quarantine':        quarantineAction,
  'fix-code':          fixCodeAction,
});

/**
 * execute — the gate. Both Layer 2 enforcement points happen here:
 *   1. ALLOWED_ACTIONS allowlist (Set membership; throws on miss)
 *   2. validateDestination (registry-aware; throws on unregistered)
 *
 * NEVER use a default-permissive switch. ALWAYS branch from the Set.
 */
export function execute(decision, opts = {}) {
  const v = validateDecision(decision);
  if (!v.ok) throw new Error(`invalid decision: ${v.error}`);

  if (!_ALLOWED.has(decision.action)) {
    // Belt-and-suspenders — validateDecision already checked, but this is the
    // explicit security boundary. NEVER drop this guard even if it's redundant.
    throw new Error(`rejected action: ${decision.action}`);
  }

  validateDestination(decision.destination, opts);

  const handlers = { ...DEFAULT_HANDLERS, ...(opts.handlers || {}) };
  const handler = handlers[decision.action];
  if (!handler) throw new Error(`no handler for action: ${decision.action}`);
  return handler(decision, opts);
}
