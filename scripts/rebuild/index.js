/**
 * Tantei — Network rebuild from source. Orchestrator.
 *
 * Hard-deletes people/companies/places/address_timeline, then re-derives them
 * from untouched source data (emails, iMessage, calendar, contacts).
 *
 * Phases are in sibling files — this file wires them together and writes the
 * final markdown report. Source data is never modified — safe to re-run.
 *
 * Entry point wrapper: scripts/tantei-rebuild.js (kept for back-compat).
 */
import db from '../../lib/db.js';
import { scanForDocuments } from '../../lib/document-vault.js';
import { loadModules } from '../../lib/module-loader.js';

import { snapshot, cleanupSnapshotTables } from './phase-00-snapshot.js';
import { hardDelete } from './phase-01-hard-delete.js';
import { phaseContacts } from './phase-02-contacts.js';
import { phaseCalendar } from './phase-03-calendar.js';
import { phaseIMessage } from './phase-04-imessage.js';
import { phaseEmail } from './phase-05-email.js';
import { restoreDerivedData } from './phase-06-restore.js';
import { phasePlaces } from './phase-07-places.js';
import { phaseScore } from './phase-08-score.js';
import { tightenedClassify } from './phase-09-classify.js';
import { classifyPlaces } from './phase-10-places.js';
import { buildSimpleAddressTimeline } from './phase-11-address.js';
import { writeReport } from './phase-12-report.js';

const log = (msg) => console.info(msg);

export async function runRebuild() {
  await loadModules();
  const t0 = Date.now();
  log('════════════════════════════════════════════════════════════');
  log('   Tantei — Network hard-delete + rebuild from source');
  log('════════════════════════════════════════════════════════════');

  const snap = snapshot(log);
  const before = hardDelete(log);

  phaseContacts(log);
  phaseCalendar(log);
  phaseIMessage(log);
  phaseEmail(log);

  const restored = restoreDerivedData(log);
  phasePlaces(log);

  const tierInfo = phaseScore(log);
  const classDist = await tightenedClassify(log);
  const placeCounts = classifyPlaces(log);

  // Run document vault scan to support any residual docs (will be empty — key_documents not populated)
  try { scanForDocuments({ verbose: false }); } catch (err) { log(`  doc scan: ${err.message}`); }

  const addrResult = await buildSimpleAddressTimeline(log);
  const { reportPath } = writeReport({
    log, before, snap, restored, tierInfo, classDist, placeCounts, addrResult, t0,
  });

  cleanupSnapshotTables();

  log(`\n════════════════════════════════════════════════════════════`);
  log(`   Done in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min. Report: ${reportPath}`);
  log(`════════════════════════════════════════════════════════════`);
}
