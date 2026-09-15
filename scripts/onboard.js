#!/usr/bin/env node
/**
 * 5-phase onboarding: contacts → calendar → iMessage (link) → email (link) → score+clean.
 * Usage: node scripts/onboard.js [--reset] [--dry-run] [--phase 1-5|contacts|calendar|imessage|email|score] [--limit N]
 *
 * Phase functions are also exported (phaseContacts/phaseCalendar/phaseIMessage/
 * phaseEmail/phaseScore) so lib/ingest-orchestrator.js can fire them on
 * permission grants without shelling out. The CLI surface is unchanged —
 * `node scripts/onboard.js …` still drives the same code path via main().
 */
import db from '../lib/db.js';
import { extractContacts } from '../lib/contacts-extractor.js';
import { extractCalendarEntities } from '../lib/calendar-extractor.js';
import { syncAppleCalendar } from '../lib/apple-calendar-reader.js';
import { syncApplePhotosMetadata } from '../lib/apple-photos-sync.js';
import { syncAppleCalls } from '../lib/apple-calls-reader.js';
import { syncAppleNotes } from '../lib/apple-notes-reader.js';
import { syncAppleMail } from '../lib/apple-mail-reader.js';
import { computeAllScores, computePlaceScores } from '../lib/scoring.js';
import { scanForDocuments } from '../lib/document-vault.js';
import { anchorDeclaredOwner } from '../lib/identity.js';
import { wbResolvePerson } from '../lib/wb-resolve-person.js';
// st_bc949e7c Phase 3.6: post-consolidation. BB code is statically imported;
// the runtime gate is `isBBActive()`. In WB mode, resolvePerson falls back
// to the SQL-only path below.
import { isBBActive } from '../lib/cohort/active.js';
import * as bb from '../lib/bb/index.js';

const _bbActive = await isBBActive();
const bbApi = _bbActive ? bb : null;

// BB functions with WB fallbacks. Fallbacks do basic SQL-only resolution
// (no probabilistic matching) — entity quality is lower but data still imports.
// WB fallback (BB inactive) is the shared wbResolvePerson helper (st_180aa017
// AC-4 — collapses the 3 diverged copies into one). Gate UNCHANGED — this is
// onboard.js's DISTINCT isBBActive()-based gate, NOT getBBModule(): that
// module cache is never populated in this standalone CLI, so switching to
// getBBModule() would silently drop BB entitlement to the WB fallback.
const resolvePerson = bbApi?.resolvePerson ?? ((c) => wbResolvePerson(db, c));
const linkPerson = bbApi?.linkPerson ?? function wbLinkPerson({ email, source }) {
  const normEmail = email?.toLowerCase().trim() || null;
  if (!normEmail) return null;
  return db.prepare('SELECT person_id as id FROM person_identifiers WHERE type=? AND value=? LIMIT 1').get('email', normEmail) || null;
};
const normalizeEmail = bbApi?.normalizeEmail ?? ((s) => (typeof s === 'string' ? s.toLowerCase().trim() : null));
const buildAddressTimeline = bbApi?.buildAddressTimeline ?? (() => {});
const FREEMAIL_DOMAINS = bbApi?.FREEMAIL_DOMAINS ?? new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com']);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const reset = args.includes('--reset');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : undefined;
const phaseIdx = args.indexOf('--phase');
const phaseArg = phaseIdx >= 0 ? args[phaseIdx + 1] : null;

const PHASE_MAP = { contacts: 1, calendar: 2, imessage: 3, email: 4, score: 5 };
const targetPhase = phaseArg ? (PHASE_MAP[phaseArg] || parseInt(phaseArg)) : null;

function shouldRun(n) { return !targetPhase || targetPhase === n; }
function log(msg) { console.info(msg); }

// --- Phase 1: Contacts ---
export function phaseContacts() {
  log('\n--- Phase 1: Contacts ---');
  const contacts = extractContacts();
  const stats = { total: contacts.length, created: 0, matched: 0, skipped: 0 };

  for (const contact of contacts) {
    try {
      if (contact.emails.length > 0) {
        const result = resolvePerson({
          name: contact.name, email: contact.emails[0],
          phone: contact.phones[0] || null, source: 'contacts',
        });
        if (result) { result.created ? stats.created++ : stats.matched++; } else { stats.skipped++; }
        for (let i = 1; i < contact.emails.length; i++) {
          resolvePerson({ name: contact.name, email: contact.emails[i], source: 'contacts' });
        }
      } else if (contact.phones?.length > 0) {
        // phone-only contact: valid per email-or-phone creation rule
        const result = resolvePerson({ name: contact.name, phone: contact.phones[0], source: 'contacts' });
        if (result) { result.created ? stats.created++ : stats.matched++; } else { stats.skipped++; }
      } else {
        // name-only contacts: silently skip — no identifier means no entity
        // WHY: entity resolution requires email OR phone. Name-only creates pollute the graph
        // with unresolvable entities that can never be matched to future data.
        stats.skipped++;
      }
    } catch (err) {
      log(`  [skip] ${contact.name || contact.emails[0]}: ${err.message}`);
      stats.skipped++;
    }
  }
  log(`  ${stats.total} contacts: ${stats.created} created, ${stats.matched} matched, ${stats.skipped} skipped`);
  return stats;
}

// --- Phase 2: Calendar ---
export function phaseCalendar(opts = {}) {
  const callLimit = opts.limit ?? limit;
  log('\n--- Phase 2: Calendar ---');
  // AC10 — read the on-device macOS calendars (Full Disk Access) into
  // calendar_events first, so the Apple Suite populates calendars (incl. work/
  // subscribed calendars) even with no Google account. Full history, no window.
  let localSynced = 0;
  try {
    const local = syncAppleCalendar();
    if (local.error) log(`  local Apple calendar: ${local.error}`);
    else { localSynced = local.synced; log(`  local Apple calendar: ${local.synced} events synced`); }
  } catch (err) {
    log(`  local Apple calendar read failed: ${err.message}`);
  }
  const events = extractCalendarEntities();
  const stats = { events: events.length, resolved: 0, created: 0, local_synced: localSynced };
  const items = callLimit ? events.slice(0, callLimit) : events;

  for (const event of items) {
    for (const email of event.attendeeEmails) {
      try {
        const result = resolvePerson({ email, source: 'calendar' });
        stats.resolved++;
        if (result.created) stats.created++;
      } catch (err) {
        log(`  [skip] ${email}: ${err.message}`);
      }
    }
  }
  log(`  ${stats.events} events: ${stats.resolved} attendees resolved, ${stats.created} created`);
  return stats;
}

// --- Phase 3: iMessage (link only) ---
export function phaseIMessage() {
  log('\n--- Phase 3: iMessage (link only) ---');
  const rows = db.prepare(`
    SELECT DISTINCT json_extract(metadata, '$.participant') as participant
    FROM chunks WHERE source_type = 'imessage' AND metadata IS NOT NULL
  `).all();

  const stats = { total: rows.length, linked: 0 };
  for (const row of rows) {
    if (!row.participant) continue;
    const email = normalizeEmail(row.participant);
    if (email && email.includes('@')) {
      const result = linkPerson({ email, source: 'imessage' });
      if (result) stats.linked++;
    }
  }
  log(`  ${stats.total} participants: ${stats.linked} linked`);

  // st_fcdbe84f — Full Disk Access also unlocks the rest of the local Apple
  // Suite: Photos metadata, Call/FaceTime history, Notes, and local Mail. Each
  // reader is graceful when its store is absent or empty (so a machine without
  // that data, or before a multi-machine sync, simply imports nothing).
  stats.local = {};
  for (const [name, fn] of [
    ['photos', () => syncApplePhotosMetadata()],
    ['calls', () => syncAppleCalls()],
    ['notes', () => syncAppleNotes()],
    ['mail', () => syncAppleMail()],
  ]) {
    try {
      const r = fn() || {};
      stats.local[name] = r.imported ?? r.synced ?? 0;
      log(`  ${name}: ${stats.local[name]} imported${r.error ? ` (${r.error})` : ''}`);
    } catch (err) {
      stats.local[name] = 0;
      log(`  ${name}: read failed — ${err.message}`);
    }
  }
  return stats;
}

// --- Phase 4: Email headers (link only) ---
export function phaseEmail(opts = {}) {
  const callLimit = opts.limit ?? limit;
  log('\n--- Phase 4: Email headers (link only) ---');
  const rows = db.prepare(`
    SELECT DISTINCT sender_email FROM emails WHERE sender_email IS NOT NULL
  `).all();

  const stats = { total: rows.length, linked: 0 };
  const items = callLimit ? rows.slice(0, callLimit) : rows;

  for (const row of items) {
    const email = normalizeEmail(row.sender_email);
    if (!email) continue;
    const result = linkPerson({ email, source: 'email' });
    if (result) stats.linked++;
  }
  log(`  ${stats.total} senders: ${stats.linked} linked`);
  return stats;
}

// --- Phase 5: Score + clean ---
// async: the owner anchor now folds declared-identifier aliases through the
// shared merge (df_cbd30a5a FIX 2), which loads lib/people-merge.js via a
// dynamic import. lib/ingest-orchestrator.js awaits phase fns via
// `await Promise.resolve(fn())`, so an async phase is transparent there.
export async function phaseScore(opts = {}) {
  const callDryRun = opts.dryRun ?? dryRun;
  log('\n--- Phase 5: Score + clean ---');

  // Archive people with source_count=0 and no contacts-source identifier
  const orphans = db.prepare(`
    SELECT p.id FROM people p
    WHERE p.archived = 0 AND p.source_count = 0
      AND NOT EXISTS (
        SELECT 1 FROM person_identifiers pi WHERE pi.person_id = p.id AND pi.source = 'contacts'
      )
  `).all();
  log(`  ${orphans.length} orphans to archive`);

  if (!callDryRun && orphans.length > 0) {
    const archiveStmt = db.prepare('UPDATE people SET archived = 1 WHERE id = ?');
    const txn = db.transaction((ids) => { for (const { id } of ids) archiveStmt.run(id); });
    txn(orphans);
  }

  // Dedup: find people sharing the same email identifier
  const dupes = db.prepare(`
    SELECT pi.value, GROUP_CONCAT(pi.person_id) as ids
    FROM person_identifiers pi
    JOIN people p ON p.id = pi.person_id AND p.archived = 0
    WHERE pi.type = 'email'
    GROUP BY pi.value HAVING COUNT(DISTINCT pi.person_id) > 1
  `).all();
  log(`  ${dupes.length} email-based duplicate groups`);

  // Recompute company people_count
  if (!callDryRun) {
    db.exec(`
      UPDATE companies SET people_count = (
        SELECT COUNT(*) FROM people WHERE company_id = companies.id AND archived = 0
      ) WHERE EXISTS (SELECT 1 FROM people WHERE company_id = companies.id)
    `);
  }

  // Recompute interaction_count, first_seen, last_seen from person_interactions
  if (!callDryRun) {
    log('  Recomputing interaction counts...');
    db.exec(`
      UPDATE people SET
        interaction_count = COALESCE((SELECT COUNT(*) FROM person_interactions WHERE person_id = people.id), 0),
        first_seen = COALESCE((SELECT MIN(date) FROM person_interactions WHERE person_id = people.id), people.first_seen),
        last_seen = COALESCE((SELECT MAX(date) FROM person_interactions WHERE person_id = people.id), people.last_seen),
        imessage_msg_count = COALESCE((SELECT COUNT(*) FROM person_interactions WHERE person_id = people.id AND channel = 'imessage' AND direction NOT IN ('group_in','group_out')), 0),
        imessage_group_count = COALESCE((SELECT COUNT(*) FROM person_interactions WHERE person_id = people.id AND channel = 'imessage' AND direction IN ('group_in','group_out')), 0)
      WHERE archived = 0
    `);
    const withInteractions = db.prepare('SELECT COUNT(*) as n FROM people WHERE archived=0 AND interaction_count > 0').get();
    log(`  ${withInteractions.n} people with interactions`);
  }

  // Score all people (dual-track personal + business)
  if (!callDryRun) {
    log('  Computing scores...');
    const { tierCounts, breaks } = computeAllScores({ verbose: true });
    log(`  Tier breaks: core=${breaks.core.toFixed(1)}, network=${breaks.network.toFixed(1)}, extended=${breaks.extended.toFixed(1)}`);

    // Score places
    log('  Computing place scores...');
    computePlaceScores();

    // Scan email for high-value documents
    log('  Scanning for high-value documents...');
    scanForDocuments({ verbose: true });

    // Build address timeline from vault + calendar
    log('  Building address timeline...');
    buildAddressTimeline({ verbose: true });
  }

  // df_cbd30a5a — wire the declared owner anchor after resolve/score so
  // owner_person_id is set on the first CLI ingest. Without this the
  // owner-anchor guard falls back to declared-email membership only and every
  // ownerPersonId()-dependent path (ego-render, mine-relations, people-write)
  // has no anchor. Idempotent + deterministic (Tier-0, no LLM). Skipped in
  // dry-run — anchoring writes owner_person_id and may create the owner row.
  if (!callDryRun) {
    try {
      const r = await anchorDeclaredOwner(db);
      if (r.anchored) log(`  Owner anchored: owner_person_id=${r.owner_person_id}${r.created ? ' (created)' : ''}${r.consolidated?.merged ? ` (+${r.consolidated.merged} declared alias(es) folded)` : ''}`);
      else log(`  Owner not anchored (${r.reason}) — declared identity absent or un-resolvable`);
    } catch (err) {
      log(`  Owner anchor skipped: ${err.message}`);
    }
  }

  const active = db.prepare('SELECT COUNT(*) as n FROM people WHERE archived = 0').get();
  const companies = db.prepare('SELECT COUNT(*) as n FROM companies').get();
  log(`  Active people: ${active.n}, Companies: ${companies.n}`);
}

// --- Reset ---
function doReset() {
  log('\n=== RESET: archiving all, zeroing counters ===');
  if (dryRun) { log('  (dry run — no changes)'); return; }

  db.exec(`UPDATE people SET archived = 1, source_count = 0, confidence = 0`);
  db.exec(`DELETE FROM person_identifiers WHERE source IN ('contacts', 'calendar', 'resolver')`);
  log('  Reset complete');
}

// --- Main ---
// async: phaseScore awaits the owner anchor + declared-alias consolidation.
async function main() {
  const t0 = Date.now();
  log('=== Robot Dojo Onboarding ===');
  log(`Options: reset=${reset}, dryRun=${dryRun}, limit=${limit || 'all'}, phase=${phaseArg || 'all'}`);

  if (dryRun) log('DRY RUN — no writes');

  if (reset) doReset();

  if (shouldRun(1)) phaseContacts();
  if (shouldRun(2)) phaseCalendar();
  if (shouldRun(3)) phaseIMessage();
  if (shouldRun(4)) phaseEmail();
  if (shouldRun(5)) await phaseScore();

  log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// Run main() only when invoked as a CLI (`node scripts/onboard.js …`).
// When imported as a module (e.g. by lib/ingest-orchestrator.js) we expose
// the phase functions but do NOT auto-execute the pipeline.
import { fileURLToPath } from 'node:url';
const __invokedAsScript = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
})();
if (__invokedAsScript) main().catch((err) => { console.error('[onboard] fatal:', err?.message || err); process.exit(1); });
