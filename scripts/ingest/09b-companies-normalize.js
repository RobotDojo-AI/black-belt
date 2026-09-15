/**
 * Phase 9b — Company name normalization (st_93fddaf0 Phase 8)
 *
 * Walks all companies, applies normalizeCompanyName() from
 * lib/company-name-normalize.js, and updates `companies.name` for any row
 * whose normalized form differs from the stored form.
 *
 * INTELLIGENCE_TIER = 'extraction' (Openprise 9-rule pipeline + brand alias
 * lookup, no LLM).
 *
 * Idempotent: normalizeCompanyName is fixed-point on already-normalized names.
 * Re-runs are safe.
 *
 * WHY a targeted UPDATE not re-running Phase 2: Phase 2 (02-resolve.js)
 * creates companies; we don't want to wipe and rebuild them. A focused name
 * UPDATE preserves all relationships, identifiers, and people_count.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { normalizeCompanyName } from '../../lib/company-name-normalize.js';

/**
 * Phase 9b entry. Normalize all company names.
 *
 * @param {Function} log
 * @returns {{ scanned: number, updated: number }}
 */
export async function phaseCompaniesNormalize(log, database = null) {
  log('\n=== Phase 9b: Company Name Normalization ===');

  const db = database || (await import('../../lib/db.js')).default;

  // WAL checkpoint to avoid SQLITE_BUSY_SNAPSHOT on re-runs after killed processes.
  try { db.pragma('wal_checkpoint(RESTART)'); } catch { /* tolerated */ }

  const companies = db.prepare(
    "SELECT rowid, id, name, people_count FROM companies WHERE COALESCE(archived, 0) = 0 AND name IS NOT NULL AND name != ''"
  ).all();

  const update = db.prepare(
    "UPDATE companies SET name = ?, updated_at = datetime('now') WHERE id = ? AND name != ?"
  );
  const updateByRowid = db.prepare(
    "UPDATE companies SET name = ?, updated_at = datetime('now') WHERE rowid = ? AND name != ?"
  );
  // Archive companies that are pure-numeric / pure-symbolic names with zero
  // associated people (orphaned from domain extraction). They can never
  // satisfy "proper-cased name" — drop them from the visible set.
  // WHY archive not delete: keep the row so any historical FK reference is
  // preserved; archive=1 just removes them from the visible network.
  const archive = db.prepare(
    "UPDATE companies SET archived = 1, updated_at = datetime('now') WHERE id = ? AND COALESCE(archived, 0) = 0"
  );
  const archiveByRowid = db.prepare(
    "UPDATE companies SET archived = 1, updated_at = datetime('now') WHERE rowid = ? AND COALESCE(archived, 0) = 0"
  );

  let updated = 0;
  let archived = 0;
  let firstSamples = [];
  db.transaction(() => {
    for (const c of companies) {
      if (!c.id && (c.people_count || 0) === 0) {
        archived += archiveByRowid.run(c.rowid).changes;
        continue;
      }
      // Orphan-numeric guard: name with NO alphabetic characters and zero
      // people — archive instead of trying to title-case digits.
      if (!/[a-zA-Z]/.test(c.name) && (c.people_count || 0) === 0) {
        archived += (c.id ? archive.run(c.id) : archiveByRowid.run(c.rowid)).changes;
        continue;
      }
      const normalized = normalizeCompanyName(c.name);
      if (normalized && normalized !== c.name) {
        const result = c.id
          ? update.run(normalized, c.id, normalized)
          : updateByRowid.run(normalized, c.rowid, normalized);
        updated += result.changes;
        if (result.changes > 0 && firstSamples.length < 10) firstSamples.push(`  ${c.name} → ${normalized}`);
      }
    }
  })();

  log(`  Scanned: ${companies.length}, updated: ${updated}, archived: ${archived}`);
  for (const s of firstSamples) log(s);

  return { scanned: companies.length, updated, archived };
}

// CLI: run directly via `node scripts/ingest/09b-companies-normalize.js`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const log = (...args) => console.log(new Date().toISOString().slice(11,19), ...args);
  phaseCompaniesNormalize(log).then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
