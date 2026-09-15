#!/usr/bin/env node
/**
 * backfill-canonical-display-names.js — MANUAL MIGRATION TOOL (one-off use).
 *
 * st_87a0d072 picker-inline (2026-05-13): canonical-name picking is now
 * INLINE in Phase 2 Resolve (`scripts/ingest/02-resolve.js`). The live
 * pipeline picks the best display_name for every CREATE and LINK as
 * candidates resolve, using a pre-loaded emails-sender index for O(1)
 * lookups. THIS SCRIPT IS NO LONGER PART OF THE PIPELINE.
 *
 * When to use this script (rare):
 *   - Repairing display_name drift in production WITHOUT rerunning the
 *     full ingest pipeline.
 *   - Re-applying a scoring rule change to existing rows (e.g. tweaked
 *     `nameQuality` weights) when a `--reset` is too expensive.
 *
 * For everyday use, just run the pipeline (`node scripts/ingest/index.js
 * --reset`) — Phase 2 Resolve handles canonical names natively now, and
 * the standalone slow backfill (~1 hour against 9.5K people × 350K emails)
 * is no longer required.
 *
 * Usage:
 *   node scripts/backfill-canonical-display-names.js [--dry-run] [--limit N]
 *
 * Strategy (unchanged — the function it calls is the same one Phase 2 uses):
 *   - Iterate every active person row.
 *   - For each, call pickBestDisplayName(person, identifiers, db) — the
 *     score-based picker (see lib/canonical-name.js for scoring rules).
 *   - The picker treats the row's current display_name as a candidate, so it
 *     returns a different value ONLY when some other source (Gmail header,
 *     Apple Contacts, name identifier) carries a strictly higher-scoring name.
 *   - If the pick differs from the current value, UPDATE.
 *
 * Idempotent: a re-run on already-upgraded rows is a no-op (current name is
 * now the best candidate, picker returns it, equals current → no UPDATE).
 *
 * Performance note: this standalone path uses pickBestDisplayName WITHOUT a
 * pre-loaded emails-sender index, which means per-person SELECT queries
 * against the emails table — slow (~1 hour at 9.5K people). The inline
 * pipeline path is ~30x faster because it pre-loads the index once.
 *
 * === Compute Tier Protocol ===
 * Tier 0: no LLM. Pure header parsing + DB lookups + writes.
 *
 * Tier ladder declaration (per build-conventions.md INTELLIGENCE_TIER block):
 *   Pure extraction. No LLM calls. Declared as 'extraction'.
 */

export const INTELLIGENCE_TIER = 'extraction';

import db from '../lib/db.js';
import {
  pickBestDisplayName,
  loadContactsIndex,
  loadEmailsSenderIndex,
} from '../lib/canonical-name.js';

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.indexOf('--limit');
const LIMIT = LIMIT_ARG !== -1 ? parseInt(process.argv[LIMIT_ARG + 1] || '0', 10) : 0;

async function run() {
  // Pre-load Apple Contacts so the per-person picker is O(1) inside the loop.
  // WHY before the SELECT: we want to fail fast if the AddressBook is locked
  // (TCC denial) — better than silently returning empty contacts mid-run.
  console.log('[backfill] loading Apple Contacts index...');
  const contactsIndex = await loadContactsIndex();
  console.log(`[backfill] contacts indexed: ${contactsIndex.byEmail.size} email keys, ${contactsIndex.byPhone.size} phone keys`);

  // st_87a0d072 picker-inline (2026-05-13): pre-load the emails-sender
  // index too. Even in the manual-repair path, paying the one-time
  // ~2s indexed scan beats the ~1 hour of per-person SELECTs.
  console.log('[backfill] loading emails-sender index...');
  const emailsSenderIndex = loadEmailsSenderIndex(db);
  console.log(`[backfill] emails-sender indexed: ${emailsSenderIndex.size} addresses`);

  const people = db.prepare(
    "SELECT id, display_name, linkedin_url FROM people WHERE COALESCE(archived,0)=0 AND display_name IS NOT NULL ORDER BY display_name"
  ).all();
  console.log(`[backfill] scanning ${people.length} active people`);

  const idStmt = db.prepare("SELECT type, value FROM person_identifiers WHERE person_id = ?");
  const updateStmt = db.prepare("UPDATE people SET display_name = ?, updated_at = datetime('now') WHERE id = ?");

  let upgraded = 0;
  let skipped = 0;
  let scanned = 0;

  for (const p of people) {
    if (LIMIT && upgraded >= LIMIT) break;
    scanned++;

    const idents = idStmt.all(p.id);
    if (idents.length === 0) { skipped++; continue; }

    // Score-based picker: returns the best-scoring candidate across all
    // sources (current display_name is included). If picker returns the
    // same value (or null), no upgrade — the current name is already best.
    const picked = pickBestDisplayName(p, idents, db, { emailsSenderIndex, contactsIndex });
    if (!picked || picked === p.display_name) { skipped++; continue; }

    if (DRY_RUN) {
      console.log(`[dry-run] ${p.id}: "${p.display_name}" → "${picked}"`);
    } else {
      updateStmt.run(picked, p.id);
      console.log(`[upgrade] ${p.id}: "${p.display_name}" → "${picked}"`);
    }
    upgraded++;
  }

  console.log(`\n[backfill] scanned=${scanned} upgraded=${upgraded} skipped=${skipped}${DRY_RUN ? ' (dry-run)' : ''}`);
}

run().catch(err => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
