/**
 * registry.js — loads + queries config/structure.json.
 *
 * WHY a registry, not hardcoded constants: STRUCTURE.md prose is human-readable
 * but not machine-queryable. The registry is the machine-readable projection of
 * the same intent — "here is the canonical path for filename X." Code that needs
 * to answer "where does this file belong?" calls into here, never reaches into
 * the JSON directly. Future moves of the registry to a DB table or remote source
 * change one module instead of N callers.
 */

import { readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default registry path — REPO_ROOT/config/structure.json. Tests can override
// by passing { registryPath } or by setting ROBOTDOJO_QUARANTINE_REGISTRY.
function defaultRegistryPath() {
  if (process.env.ROBOTDOJO_QUARANTINE_REGISTRY) {
    return process.env.ROBOTDOJO_QUARANTINE_REGISTRY;
  }
  return join(__dirname, '..', '..', 'config', 'structure.json');
}

let _cached = null;
let _cachedPath = null;

export function loadRegistry({ registryPath } = {}) {
  const p = registryPath || defaultRegistryPath();
  if (_cached && _cachedPath === p) return _cached;
  const raw = readFileSync(p, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Fail-fast at module load with a clear error pointing at the registry.
    throw new Error(`config/structure.json malformed at ${p}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`config/structure.json must be a JSON object: ${p}`);
  }
  if (!Array.isArray(parsed.canonical_paths)) {
    throw new Error(`config/structure.json missing canonical_paths array: ${p}`);
  }
  _cached = parsed;
  _cachedPath = p;
  return parsed;
}

/**
 * Reset the cache — used by tests that swap in a different registry mid-process.
 */
export function resetRegistryCache() {
  _cached = null;
  _cachedPath = null;
}

/**
 * findByFilename — given a basename like "taxonomy.user.json", return the
 * registry entry or null.
 */
export function findByFilename(name, registry) {
  const reg = registry || loadRegistry();
  return reg.canonical_paths.find(e => e.filename === name) || null;
}

/**
 * findByRenameSource — given a current path that is the "rename_from" of an
 * entry, return the entry. Used to detect "config/taxonomy.json should be
 * renamed to config/taxonomy.user.json."
 */
export function findByRenameSource(relPath, registry) {
  const reg = registry || loadRegistry();
  return reg.canonical_paths.find(e => e.rename_from === relPath) || null;
}

/**
 * pendingMigrationFor — given a relPath like "research/2026-04-28-foo.md",
 * return { from, to, active } if a pending migration covers it.
 */
export function pendingMigrationFor(relPath, registry) {
  const reg = registry || loadRegistry();
  if (!Array.isArray(reg.pending_migrations)) return null;
  for (const mig of reg.pending_migrations) {
    if (!mig.active) continue;
    // Pending migrations are directory prefixes — match path startsWith.
    if (relPath.startsWith(mig.from)) return mig;
  }
  return null;
}

/**
 * isStrayDotdirDb — given a basename, return the stray-dotdir-db spec if it
 * matches *.db / *.db-shm / *.db-wal. Used by tier-0/db-redundancy and the
 * dotdir-walker.
 */
export function isStrayDotdirDb(name, registry) {
  const reg = registry || loadRegistry();
  if (!reg.stray_dotdir_db_pattern) return null;
  if (/\.db(-(shm|wal|journal))?$/.test(name)) {
    return reg.stray_dotdir_db_pattern;
  }
  return null;
}

/**
 * canonicalPaths — list of declared canonical destinations (resolved-relative
 * to repo). Used by destination validator.
 */
export function canonicalPaths(registry) {
  const reg = registry || loadRegistry();
  return reg.canonical_paths.map(e => e.path);
}
