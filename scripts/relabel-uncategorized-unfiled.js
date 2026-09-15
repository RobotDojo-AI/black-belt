#!/usr/bin/env node
/**
 * scripts/relabel-uncategorized-unfiled.js — st_2d941f89 (gap 3) OWNER-RUN
 * relabel of the LIVE catch-all topic row.
 *
 * WHY this is a separate owner-run script, not a migrate() block: lib/db.js's
 * seed migrations (uncategorized-root-topic-v1, uncategorized-routing-
 * residue-v2) and lib/taxonomy.js's syncTaxonomyToDb() both now write the
 * owner-confirmed label (UNCATEGORIZED_LABEL, lib/topic-routing-policy.js —
 * "Unfiled") for a BRAND-NEW install, but both are create-only (migrate() is
 * ledger-gated and never re-runs; syncTaxonomyToDb's upsert is
 * `ON CONFLICT(slug) DO NOTHING`, deliberately preserving user edits to an
 * EXISTING row across restarts). Neither path retroactively updates an
 * already-seeded live database's user_topics row — this script is that one
 * remaining step, and per the build brief it is a DATA migration the owner
 * runs deliberately, not something a build or boot silently applies.
 *
 * SCOPE: this ONLY updates the `label` column of the single 'uncategorized'
 * user_topics row. It does NOT rename the slug, does NOT move any of the
 * chunks currently tagged topic='uncategorized', and does NOT touch any
 * chunk_vec_* table — none of the higher-risk data-migration machinery this
 * story's research flagged (the UNIQUE(topic, source_type, source_id,
 * chunk_index) constraint, the reclassifier's collision-tolerant move logic)
 * is exercised here, because the slug itself is unchanged.
 *
 * SAFE BY DEFAULT: dry-run (the default) reports the current label and
 * whether a change is needed, and writes NOTHING. `--execute` performs the
 * single-row UPDATE. Idempotent — a second run (dry or executed) finds
 * nothing left to do once the label matches.
 *
 * Usage:
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/relabel-uncategorized-unfiled.js              # dry-run report
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/relabel-uncategorized-unfiled.js --execute     # apply
 *
 * INTELLIGENCE_TIER: extraction (deterministic single-row UPDATE, no LLM).
 */

export const INTELLIGENCE_TIER = 'extraction';

import db from '../lib/db.js';
import { UNCATEGORIZED_T1, UNCATEGORIZED_LABEL } from '../lib/topic-routing-policy.js';

const EXECUTE = process.argv.includes('--execute');

function main() {
  const row = db.prepare('SELECT slug, label FROM user_topics WHERE slug = ?').get(UNCATEGORIZED_T1);
  if (!row) {
    console.log(`[relabel-uncategorized-unfiled] no '${UNCATEGORIZED_T1}' row found — nothing to do (a fresh install already seeds the correct label).`);
    process.exit(0);
  }
  if (row.label === UNCATEGORIZED_LABEL) {
    console.log(`[relabel-uncategorized-unfiled] already '${UNCATEGORIZED_LABEL}' — nothing to do.`);
    process.exit(0);
  }

  console.log(`[relabel-uncategorized-unfiled] '${UNCATEGORIZED_T1}' label is currently '${row.label}' — target '${UNCATEGORIZED_LABEL}'.`);
  if (!EXECUTE) {
    console.log('[relabel-uncategorized-unfiled] dry-run — no write performed. Re-run with --execute to apply.');
    process.exit(0);
  }

  const result = db.prepare(`
    UPDATE user_topics SET label = ?, updated_at = datetime('now') WHERE slug = ? AND label != ?
  `).run(UNCATEGORIZED_LABEL, UNCATEGORIZED_T1, UNCATEGORIZED_LABEL);
  console.log(`[relabel-uncategorized-unfiled] updated ${result.changes} row(s) to label '${UNCATEGORIZED_LABEL}'.`);
  process.exit(0);
}

main();
