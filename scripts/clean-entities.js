#!/usr/bin/env node
/**
 * Entity cleanup: archive unanchored people, remove empty companies, backfill source_count.
 * Usage: node scripts/clean-entities.js [--dry-run]
 */
import db from '../lib/db.js';
import { companyStandaloneGuardSql, personStandaloneGuardSql } from '../lib/entity-standalone.js';

const dryRun = process.argv.includes('--dry-run');

function log(msg) { console.info(msg); }

function main() {
  log('=== Entity Cleanup ===');
  if (dryRun) log('DRY RUN — no writes\n');

  const before = {
    people: db.prepare('SELECT COUNT(*) as n FROM people WHERE archived = 0').get().n,
    companies: db.prepare('SELECT COUNT(*) as n FROM companies').get().n,
  };
  log(`Before: ${before.people} active people, ${before.companies} companies`);

  // 1. Archive genuinely signal-less people. A person STANDS ALONE (owner
  // directive st_483361e2): a research marker (uuid), facts, edges, or a phone
  // identifier keep it — regardless of connections. We still archive the
  // auto-extracted email-only noise (no contacts-source identifier AND no
  // standalone signal), but the guard ensures cleanup can never touch a
  // real/promoted/edge-having person. Rule shared via lib/entity-standalone.js.
  const unanchored = db.prepare(`
    SELECT p.id FROM people p
    WHERE p.archived = 0
      AND NOT EXISTS (
        SELECT 1 FROM person_identifiers pi
        WHERE pi.person_id = p.id AND pi.source = 'contacts'
      )
      AND ${personStandaloneGuardSql('p')}
  `).all();
  log(`\nSignal-less people to archive (no contacts id, no uuid, no phone, no curated edge): ${unanchored.length}`);

  if (!dryRun && unanchored.length > 0) {
    const stmt = db.prepare('UPDATE people SET archived = 1 WHERE id = ?');
    const txn = db.transaction((rows) => { for (const { id } of rows) stmt.run(id); });
    txn(unanchored);
  }

  // 2. Remove ONLY genuine no-signal company stubs. A company STANDS ALONE:
  // having no people is NOT grounds for deletion (owner directive st_483361e2 —
  // "companies entity stands alone with people attached, i never made a people
  // rule"). Delete only when it also has no domain, no research marker (uuid),
  // no facts, and no edges. Rule shared via lib/company-standalone.js so this
  // and scripts/maintenance-phases.js can never drift.
  const emptyCompanies = db.prepare(`
    SELECT c.id, c.name FROM companies c
    WHERE NOT EXISTS (
      SELECT 1 FROM people p WHERE p.company_id = c.id AND p.archived = 0
    )
      AND ${companyStandaloneGuardSql('c')}
  `).all();
  log(`No-signal company stubs (no people, domain, uuid, facts, or edges): ${emptyCompanies.length}`);

  if (!dryRun && emptyCompanies.length > 0) {
    const delDomains = db.prepare('DELETE FROM company_domains WHERE company_id = ?');
    const delCompany = db.prepare('DELETE FROM companies WHERE id = ?');
    const txn = db.transaction((rows) => {
      for (const { id } of rows) {
        delDomains.run(id);
        delCompany.run(id);
      }
    });
    txn(emptyCompanies);
  }

  // 3. Backfill source_count from person_identifiers
  if (!dryRun) {
    db.exec(`
      UPDATE people SET source_count = (
        SELECT COUNT(DISTINCT source) FROM person_identifiers WHERE person_id = people.id
      ) WHERE archived = 0
    `);
    log('\nBackfilled source_count from person_identifiers');
  }

  const after = {
    people: db.prepare('SELECT COUNT(*) as n FROM people WHERE archived = 0').get().n,
    companies: db.prepare('SELECT COUNT(*) as n FROM companies').get().n,
  };
  log(`\nAfter: ${after.people} active people, ${after.companies} companies`);
  log(`Delta: ${before.people - after.people} people archived, ${before.companies - after.companies} companies removed`);
}

main();
