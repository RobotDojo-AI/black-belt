/**
 * tier-0/db-redundancy.js — detect JSON/YAML files whose content is already in
 * the SQLite DB.
 *
 * WHY: example #1 — config/health-markers.json has 91 markers, the DB has 655.
 * The JSON is a stale legacy export, not the source of truth. Tier 0 detects
 * "JSON shape resembles a DB table's columns" and proposes routing to
 * quarantine/legacy-data/ for human review (never delete).
 *
 * Detection strategy: shallow JSON shape match on top-level keys against a
 * small list of known {filename → table} mappings. We do NOT actually query
 * the DB at this tier — we'd need to import lib/db.js which has top-level
 * await + cipher init. Instead, we recognize structural patterns deterministically.
 *
 * Known patterns:
 *   { groups: [...], markers: [...] }  → health-markers (DB has health_markers)
 *
 * If matched, recommend route to `quarantine/legacy-data/<basename>`.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

const PATTERNS = [
  {
    test: (data) => Array.isArray(data?.groups) && Array.isArray(data?.markers),
    table: 'health_markers',
    canonical_quarantine: 'quarantine/legacy-data/',
    reason: 'JSON shape mirrors health_markers DB table; data is in DB',
  },
];

export function detectDbRedundancy(absPath) {
  if (!existsSync(absPath)) return null;
  try {
    if (!statSync(absPath).isFile()) return null;
  } catch {
    return null;
  }
  const ext = extname(absPath).toLowerCase();
  if (ext !== '.json') return null;

  let data;
  try {
    data = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }

  for (const p of PATTERNS) {
    if (p.test(data)) {
      const dest = `${p.canonical_quarantine}${basename(absPath)}`;
      return {
        signal_name: 'db-redundancy',
        destination: dest,
        confidence: 0.85,
        reason: `${p.reason}; route to legacy-data per never-delete`,
        action: 'move-to-canonical',
        table: p.table,
      };
    }
  }
  return null;
}
