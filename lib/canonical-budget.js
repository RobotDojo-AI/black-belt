// lib/canonical-budget.js — read max_chars per surface from the registry.
//
// Story st_ae536261. The retired budget manifest's `max_chars` value moved to
// canonical-surfaces.json's per-entry `max_chars` field. This helper resolves
// budget by path. Used by:
//   - lib/topic-context.js  → per-topic char budget (separate ad-hoc field
//                              previously colocated; preserved via getExtra)
//   - scripts/claude.js     → CLAUDE.md budget gate (legacy writer; will be
//                              retired in Phase 3 of st_ae536261)
//
// Returns null for unregistered paths. Callers decide whether to fall back.

import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SURFACES_PATH = process.env.ROBOTDOJO_SURFACES_PATH
  || resolve(REPO_ROOT, 'architecture/surfaces.json');

let _cache = { mtime: 0, byPath: new Map() };

function _load() {
  let mtime;
  try { mtime = statSync(SURFACES_PATH).mtimeMs; } catch { return; }
  if (mtime === _cache.mtime) return;
  const data = JSON.parse(readFileSync(SURFACES_PATH, 'utf8'));
  const byPath = new Map();
  for (const s of data.surfaces || []) byPath.set(s.path, s);
  _cache = { mtime, byPath };
}

/**
 * maxCharsFor(path) — returns the registry max_chars for a path or null.
 *
 * @param {string} path Registry-normalized path (e.g. 'CLAUDE.md').
 * @returns {number|null}
 */
export function maxCharsFor(path) {
  _load();
  const e = _cache.byPath.get(path);
  if (!e) return null;
  if (e.max_chars == null) return null;
  return e.max_chars;
}
