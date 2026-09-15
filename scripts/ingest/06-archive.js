/**
 * Phase 6 — Archive: low-signal entities, recompute company counts, cleanup.
 *
 * 1. Archive people: interaction_count=0 AND not in contacts → set archived=1
 * 2. Recompute companies.people_count from active people
 * 3. Drop snapshot tables (no longer needed after restore)
 * 4. Write rebuild report to docs/
 *
 * WHY archive-not-delete: archived entities remain queryable for debugging.
 * They don't appear in scoring or the Network app but can be recovered if
 * a source later provides interaction evidence.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { ownerPersonId } from '../../lib/identity.js';

// st_f67bc2eb — THE OWNER ROW IS NEVER PIPELINE-ARCHIVED. identity.json's
// owner_person_id anchors the entire ego graph (who-is-who block, the
// relationship walker, every owner-anchored edge). The live failure this
// guard closes: the vendor classifier flagged the owner's own row
// service_vendor=1 (role-token heuristic over his 56 identifiers) and the
// vendor archive pass buried the identity anchor — every owner edge then
// read as "active edge touches archived person". '' when identity is not
// yet configured (fresh install): `id != ''` matches every row, no-op guard.
function ownerGuardId() {
  return String(ownerPersonId() || '');
}

export function archiveServiceVendorRows(db) {
  return db.prepare(`
    UPDATE people SET archived = 1, needs_regen = 0
    WHERE archived = 0 AND service_vendor = 1
      AND verified = 0
      AND tier_override IS NULL
      AND relation_tag IS NULL
      AND id != ?
  `).run(ownerGuardId());
}

// df_19c11899 — this pass was the ONLY archive pass missing the three guards its
// four siblings carry (interaction_count / verified / tier_override, documented
// at the bottom of this file: "anyone with ANY interaction survives", "a
// manually verified person is kept", "an owner tier pin is kept").
//
// Without them it archived any row whose display_name merely CONTAINS '@' — and
// 02-resolve.js sets display_name to the email address whenever a candidate has
// no separate name, so this swept up real correspondents wholesale. Measured at
// the time of the fix: 13,123 archived identifier-holders had genuine
// interaction history, including 5,862 calendar contacts — 100% of them. Those
// are real people that went missing from the owner's graph.
//
// The '@' heuristic is retained: an address-as-display-name with no history is
// still header noise. The guards restore the contract the siblings share.
export function archiveRawEmailDisplayRows(db) {
  return db.prepare(`
    UPDATE people SET archived = 1, needs_regen = 0
    WHERE archived = 0
      AND display_name LIKE '%@%'
      AND relation_tag IS NULL
      AND interaction_count = 0
      AND verified = 0
      AND tier_override IS NULL
      AND id != ?
  `).run(ownerGuardId());
}

export function clearOrphanNeedsRegenFlags(db) {
  return db.prepare(`
    UPDATE people SET needs_regen = 0
    WHERE archived = 0
      AND needs_regen = 1
      AND (context_file_path IS NULL OR context_file_path = '')
  `).run();
}

export function clearNonEnrichmentNeedsRegenFlags(db) {
  return db.prepare(`
    UPDATE people SET needs_regen = 0
    WHERE archived = 0
      AND needs_regen = 1
      AND context_file_path IS NOT NULL
      AND context_file_path != ''
      AND (n2 IS NULL OR n2 NOT IN ('Family', 'Partners', 'Customers', 'Core', 'Network'))
  `).run();
}

export function clearArchivedNeedsRegenFlags(db) {
  return db.prepare(`
    UPDATE people SET needs_regen = 0
    WHERE archived = 1
      AND needs_regen = 1
  `).run();
}

export function archiveZeroSignalEmailRows(db) {
  return db.prepare(`
    UPDATE people SET archived = 1, needs_regen = 0
    WHERE archived = 0
      AND interaction_count = 0
      AND primary_source = 'email'
      AND verified = 0
      AND tier_override IS NULL
      AND relation_tag IS NULL
      AND id != ?
      AND NOT EXISTS (
        SELECT 1 FROM person_identifiers pi
        WHERE pi.person_id = people.id AND pi.source IN ('contacts', 'google_contacts')
      )
  `).run(ownerGuardId());
}

export function archiveZeroSignalUnresolvableRows(db) {
  return db.prepare(`
    UPDATE people SET archived = 1, needs_regen = 0
    WHERE archived = 0
      AND interaction_count = 0
      AND verified = 0
      AND tier_override IS NULL
      AND relation_tag IS NULL
      AND id != ?
      AND context_file_path IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM person_identifiers pi
        WHERE pi.person_id = people.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM person_interactions px
        WHERE px.person_id = people.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM chunk_entities ce
        WHERE ce.entity_id = people.id AND ce.entity_type = 'person'
      )
  `).run(ownerGuardId());
}

export async function archivePartialIngestNoise(log = () => {}) {
  const { default: db } = await import('../../lib/db.js');
  const emailNoiseArchive = archiveZeroSignalEmailRows(db);
  const unresolvableArchive = archiveZeroSignalUnresolvableRows(db);
  const orphanRegenClear = clearOrphanNeedsRegenFlags(db);
  const nonEnrichmentRegenClear = clearNonEnrichmentNeedsRegenFlags(db);
  const archivedRegenClear = clearArchivedNeedsRegenFlags(db);
  if (emailNoiseArchive.changes) {
    log(`  Partial cleanup archived ${emailNoiseArchive.changes} zero-signal email-only rows before slice exit`);
  }
  if (unresolvableArchive.changes) {
    log(`  Partial cleanup archived ${unresolvableArchive.changes} zero-signal no-identifier rows before slice exit`);
  }
  if (orphanRegenClear.changes) {
    log(`  Partial cleanup cleared ${orphanRegenClear.changes} orphan needs_regen flags before slice exit`);
  }
  if (nonEnrichmentRegenClear.changes) {
    log(`  Partial cleanup cleared ${nonEnrichmentRegenClear.changes} non-enrichment needs_regen flags before slice exit`);
  }
  if (archivedRegenClear.changes) {
    log(`  Partial cleanup cleared ${archivedRegenClear.changes} archived needs_regen flags before slice exit`);
  }
  return {
    changes: emailNoiseArchive.changes + unresolvableArchive.changes + orphanRegenClear.changes + nonEnrichmentRegenClear.changes + archivedRegenClear.changes,
    emailNoise: emailNoiseArchive.changes,
    unresolvable: unresolvableArchive.changes,
    orphanRegen: orphanRegenClear.changes,
    nonEnrichmentRegen: nonEnrichmentRegenClear.changes,
    archivedRegen: archivedRegenClear.changes,
  };
}

export async function phaseArchive(log, scored) {
  log('\n=== Phase 6: Archive + cleanup ===');

  const { default: db } = await import('../../lib/db.js');

  // 0. (st_f1a40461) NO blanket un-archive. The earlier E9 reset flipped every
  //    archived=1 row back to 0 so low-signal archiving could be re-derived each
  //    run. But signal-based archiving is now disabled, so that reset has no job
  //    left — and it actively RESURRECTED dedup losers (Phase 2 `mergeInto`
  //    archives merged-away duplicate rows), making merged people like
  //    "Sam Okafor" reappear as empty phantom rows. The only archived rows now
  //    are (a) dedup losers — must STAY archived — and (b) service-vendor
  //    non-people, re-applied below from the current flag. Both are pure
  //    functions of this run, so no reset is needed.

  // 1. (st_f1a40461) Keep everyone who resolves to a REAL PERSON; archive only
  //    the non-people the pipeline already detects. NO signal/interaction-count
  //    cutoff — an arbitrary threshold (e.g. "<3 interactions") hides exactly
  //    the new-but-important contacts (a high-stakes thread you just started has
  //    1-2 interactions), which is the bug this story fixes. Visibility is
  //    governed by the continuous `score` (noise sinks to the bottom), not a
  //    binary hide. Newsletters are already excluded upstream at extraction
  //    (is_newsletter / list_unsubscribe); transactional/vendor senders are
  //    flagged service_vendor=1 in Phase 3b. We archive those unless the owner
  //    explicitly verified, pinned, or relation-tagged the row.
  const vendorArchive = archiveServiceVendorRows(db);
  log(`  Archived ${vendorArchive.changes} service-vendor / transactional non-people (real people kept, ranked by score)`);

  // 1b. (st_2cd1af73 Phase 3) RESTORE the zero-signal email cutoff.
  //     The prior story (st_f1a40461) removed every interaction-count cutoff
  //     to avoid hiding new-but-important contacts. That over-corrected: the
  //     ~19k email-only rows with ZERO interactions are not "new contacts you
  //     just started a thread with" — a thread you started HAS an interaction.
  //     interaction_count=0 AND primary_source='email' is the pure header-only
  //     residue: an address that appeared in a To/Cc list but never produced a
  //     single recorded interaction. Those rows flatten the score distribution
  //     so natural breaks collapse to a few hundred meaningful people. We
  //     archive ONLY that exact zero-signal email cohort.
  //
  //     Preserved by construction (each clause is a guard, not a heuristic):
  //       - interaction_count = 0   → anyone with ANY interaction survives
  //                                   (the new high-stakes thread is kept).
  //       - primary_source = 'email'→ contacts / calendar / imessage origins
  //                                   are never touched, regardless of count.
  //       - verified = 0            → a manually verified person is kept.
  //       - tier_override IS NULL   → an owner tier pin is kept.
  //       - NOT EXISTS contacts id  → if any identifier came from contacts,
  //                                   the person was deliberately saved → keep.
  //     This is a binary hide of pure noise; the continuous score still ranks
  //     everyone who survives. It is the inverse of the inflation the merge
  //     cleanup above removes.
  const emailNoiseArchive = archiveZeroSignalEmailRows(db);
  log(`  Archived ${emailNoiseArchive.changes} zero-signal email-only rows (interaction_count=0; contacts/calendar/imessage + verified + tagged kept)`);

  // 1c. Active humans need at least one piece of resolving/enrichment evidence:
  // a hard identifier, a recorded interaction, chunk coverage, or a context
  // file. Calendar/contact slices can emit name+company shells with none of
  // those. They cannot resolve to a unique person and only pollute search, so
  // archive them unless the owner verified, tagged, or pinned the row.
  const unresolvableArchive = archiveZeroSignalUnresolvableRows(db);
  log(`  Archived ${unresolvableArchive.changes} zero-signal no-identifier rows`);

  // 1d. If every name repair pass still leaves a row displaying as an email
  // address, the pipeline has not resolved that row to an actual human. Keep it
  // for forensics, but remove it from the active entity graph.
  const rawEmailDisplayArchive = archiveRawEmailDisplayRows(db);
  log(`  Archived ${rawEmailDisplayArchive.changes} unresolved raw-email display rows`);

  // 1e. A dirty context flag with no context file is not actionable. It cannot
  // be regenerated by the enrichment worker and it keeps the quality gate red
  // after otherwise-successful full-corpus runs.
  const orphanRegenClear = clearOrphanNeedsRegenFlags(db);
  log(`  Cleared ${orphanRegenClear.changes} orphan needs_regen flags`);

  // 1f. Timeline links only feed the richer enrichment pass for the higher-value
  // relationship tiers. Acquaintance context files are free templates, so a
  // broad old post-link dirty flag is not actionable work.
  const nonEnrichmentRegenClear = clearNonEnrichmentNeedsRegenFlags(db);
  log(`  Cleared ${nonEnrichmentRegenClear.changes} non-enrichment needs_regen flags`);

  const archivedRegenClear = clearArchivedNeedsRegenFlags(db);
  log(`  Cleared ${archivedRegenClear.changes} archived needs_regen flags`);

  const cleanupChanges = vendorArchive.changes + emailNoiseArchive.changes + unresolvableArchive.changes +
    rawEmailDisplayArchive.changes + orphanRegenClear.changes + nonEnrichmentRegenClear.changes +
    archivedRegenClear.changes;

  // 2. Recompute companies.people_count, but only write rows whose count changed.
  const peopleCountUpdate = db.prepare(`
    UPDATE companies SET people_count = (
      SELECT COUNT(*) FROM people WHERE company_id = companies.id AND archived = 0
    )
    WHERE COALESCE(people_count, 0) != (
      SELECT COUNT(*) FROM people WHERE company_id = companies.id AND archived = 0
    )
  `).run();
  log(`  Recomputed company people_count (${peopleCountUpdate.changes} changed)`);

  // 2b. (st_f1a40461) Context-link clearing DISABLED. Previously this nulled
  //     context_file_path for Acquaintance/untiered people, stripping their
  //     context from chat. Every entity should keep its context document
  //     (free template at minimum), so we retain the pointer for all tiers.

  // 3. Drop snapshot tables
  try {
    db.exec(`
      DROP TABLE IF EXISTS tantei_interactions_snap;
      DROP TABLE IF EXISTS tantei_edges_snap;
      DROP TABLE IF EXISTS tantei_groups_snap;
      DROP TABLE IF EXISTS tantei_topics_snap;
    `);
    log('  Dropped snapshot tables');
  } catch (err) {
    log(`  Snapshot cleanup: ${err.message}`);
  }

  // 4. Write rebuild report only when this cleanup phase changed visible data.
  // A no-op stability pass must not create a fresh report file.
  try {
    if (cleanupChanges + peopleCountUpdate.changes === 0 && process.env.ROBOTDOJO_FORCE_REBUILD_REPORT !== '1') {
      log('  Report skipped: no archive/count changes');
    } else {
      const docsDir = resolve(process.cwd(), 'docs');
      mkdirSync(docsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const reportPath = resolve(docsDir, `rebuild-report-${ts}.md`);

      const n1Counts = db.prepare(`
        SELECT n1, COUNT(*) as n FROM people WHERE archived=0 AND n1 IS NOT NULL GROUP BY n1
      `).all();
      const n2Counts = db.prepare(`
        SELECT n1, n2, COUNT(*) as n FROM people WHERE archived=0 AND n1 IS NOT NULL AND n2 IS NOT NULL GROUP BY n1, n2 ORDER BY n1, n DESC
      `).all();
      const auditCounts = db.prepare(`
        SELECT decision, COUNT(*) as n FROM resolve_audit GROUP BY decision
      `).all();
      const totalPeople = db.prepare("SELECT COUNT(*) as n FROM people WHERE archived=0").get().n;
      const totalCompanies = db.prepare("SELECT COUNT(*) as n FROM companies").get().n;
      const totalPlaces = db.prepare("SELECT COUNT(*) as n FROM places").get().n;

      const report = [
        `# Rebuild Report — ${new Date().toISOString()}`,
        '',
        `## Summary`,
        `- Active people: ${totalPeople}`,
        `- Companies: ${totalCompanies}`,
        `- Places: ${totalPlaces}`,
        '',
        `## Resolution`,
        auditCounts.map(r => `- ${r.decision}: ${r.n}`).join('\n'),
        '',
        `## N1 Distribution`,
        n1Counts.map(r => `- ${r.n1}: ${r.n}`).join('\n'),
        '',
        `## N2 Distribution`,
        n2Counts.map(r => `- ${r.n1} > ${r.n2}: ${r.n}`).join('\n'),
        '',
        `## Score Phase Output`,
        scored ? `- People scored: ${scored.people}\n- Companies: ${scored.companies}\n- Places: ${scored.places}` : 'N/A',
      ].join('\n');

      writeFileSync(reportPath, report, 'utf8');
      log(`  Report written: ${reportPath}`);
    }
  } catch (err) {
    log(`  Report write failed: ${err.message}`);
  }

  return {
    changes: cleanupChanges + peopleCountUpdate.changes,
    vendor: vendorArchive.changes,
    emailNoise: emailNoiseArchive.changes,
    unresolvable: unresolvableArchive.changes,
    rawEmailDisplay: rawEmailDisplayArchive.changes,
    orphanRegen: orphanRegenClear.changes,
    nonEnrichmentRegen: nonEnrichmentRegenClear.changes,
    archivedRegen: archivedRegenClear.changes,
    peopleCount: peopleCountUpdate.changes,
  };
}
