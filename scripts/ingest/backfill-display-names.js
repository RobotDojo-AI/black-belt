#!/usr/bin/env node
/**
 * st_93fddaf0 Phase 2 — one-shot backfill that re-picks display_name for any
 * people row carrying a polluted name. Two pollution classes targeted:
 *
 *   1. `display_name LIKE '% (via %'` — Gmail Workspace "(via Service)" suffix
 *      that inflates nameQuality token count and beats clean candidates.
 *   2. `display_name GLOB '[A-Z]*, [A-Z]*'` — "Last, First" formatted names
 *      that break Stage B merge guards and look ugly in the UI.
 *
 * For each row, re-runs `pickBestDisplayName()` against the row's identifiers
 * + the live emails/contacts indexes. The picker uses the strict normalizer,
 * so the cleaned form wins.
 *
 * INTELLIGENCE_TIER = 'extraction' (no LLM calls, regex/lookup only).
 *
 * Safe to re-run: idempotent on already-cleaned rows because the normalizer
 * leaves already-clean names alone.
 *
 * Usage:
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/ingest/backfill-display-names.js
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/ingest/backfill-display-names.js --dry-run
 *
 * WHY a standalone script: Phase 2 of the pipeline picks every CREATE/LINK
 * candidate's display_name inline — once that's fixed, full --reset rebuilds
 * are clean. But existing DBs carry pollution from prior runs. The backfill
 * is the one-time fix for them.
 */

export const INTELLIGENCE_TIER = 'extraction';

import db from '../../lib/db.js';
import { pickBestDisplayName, loadContactsIndex, loadEmailsSenderIndex, normalizeNameString } from '../../lib/canonical-name.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const log = (...args) => console.log(...args);
  log('=== backfill-display-names — st_93fddaf0 Phase 2 ===');
  log(DRY_RUN ? '(dry-run: no UPDATEs will be issued)' : '(live run)');

  // Pre-load indexes once for the whole walk.
  const emailsSenderIndex = loadEmailsSenderIndex(db);
  const contactsIndex = await loadContactsIndex();
  log(`Indexes pre-loaded: emails ${emailsSenderIndex.size}, contacts ${contactsIndex.byEmail.size + contactsIndex.byPhone.size}`);

  // Target the pollution classes: "(via X)" suffix OR "Last, First" comma.
  const polluted = db.prepare(`
    SELECT id, display_name, linkedin_url FROM people
    WHERE archived = 0
      AND (display_name LIKE '% (via %' OR display_name GLOB '[A-Z]*, [A-Z]*')
  `).all();

  log(`Polluted rows: ${polluted.length}`);
  if (polluted.length === 0) {
    log('Nothing to do.');
    return;
  }

  const update = db.prepare(
    "UPDATE people SET display_name = ?, updated_at = datetime('now') WHERE id = ?"
  );
  const getIdents = db.prepare(
    "SELECT type, value FROM person_identifiers WHERE person_id = ?"
  );

  let updated = 0;
  let unchanged = 0;
  const tx = db.transaction(() => {
    for (const p of polluted) {
      const identifiers = getIdents.all(p.id);
      const picked = pickBestDisplayName(p, identifiers, db, {
        emailsSenderIndex,
        contactsIndex,
      });
      // Fall back to the normalized current name if the picker returns the
      // same name or nothing better — a row whose only candidate is the
      // polluted form still benefits from a literal strip.
      const candidate = picked || normalizeNameString(p.display_name);
      if (candidate && candidate !== p.display_name) {
        if (!DRY_RUN) update.run(candidate, p.id);
        updated++;
        if (updated <= 20) log(`  ${p.id}: "${p.display_name}" → "${candidate}"`);
      } else {
        unchanged++;
      }
    }
  });
  tx();

  log(`Updated: ${updated}`);
  log(`Unchanged (already clean after normalization): ${unchanged}`);
  log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
