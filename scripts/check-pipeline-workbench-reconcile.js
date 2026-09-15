#!/usr/bin/env node
/**
 * check-pipeline-workbench-reconcile.js — AC2 helper for st_9699c94f.
 *
 * Proves disk-discovery (not just one-time insert) for the relocated
 * pipeline workbench. Steps:
 *   1. delete the wk_robot_dojo row from workbenches table
 *   2. call reconcileWorkbenchesFromDisk(db) from lib/workbenches.js
 *   3. re-query and exit 0 iff the row reappeared at the correct root_path
 *
 * The row deletion + re-discovery proves that the workbench is discoverable
 * from disk alone — without it, a one-time INSERT could create a row that
 * never gets re-created if it's lost. The reconcile invariant matters
 * because workbench rows are the bridge between filesystem state and the
 * product UI; if reconcile can't recover them, manual restoration is the
 * only fallback.
 */
import db from '../lib/db.js';
import { reconcileWorkbenchesFromDisk } from '../lib/workbenches.js';

export const INTELLIGENCE_TIER = 'extraction';

const EXPECTED_ROOT = 'user/workbenches/topics/work/robot-dojo/wk_robot_dojo';
const WORKBENCH_ID = 'wk_robot_dojo';

db.prepare(`DELETE FROM workbenches WHERE id = ?`).run(WORKBENCH_ID);

try {
  reconcileWorkbenchesFromDisk(db);
} catch (err) {
  process.stderr.write(
    `[check-pipeline-workbench-reconcile] FAIL — reconcileWorkbenchesFromDisk threw: ${err.message}\n`,
  );
  process.exit(1);
}

const row = db
  .prepare(`SELECT id, root_path, status FROM workbenches WHERE id = ?`)
  .get(WORKBENCH_ID);

if (!row) {
  process.stderr.write(
    `[check-pipeline-workbench-reconcile] FAIL — workbench row ${WORKBENCH_ID} did not reappear after reconcile\n`,
  );
  process.exit(1);
}

if (row.root_path !== EXPECTED_ROOT) {
  process.stderr.write(
    `[check-pipeline-workbench-reconcile] FAIL — workbench row ${WORKBENCH_ID} reappeared with wrong root_path: ${row.root_path} (expected ${EXPECTED_ROOT})\n`,
  );
  process.exit(1);
}

if (row.status === 'archived') {
  process.stderr.write(
    `[check-pipeline-workbench-reconcile] FAIL — workbench row ${WORKBENCH_ID} reappeared with status=archived\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `[check-pipeline-workbench-reconcile] ok — row ${WORKBENCH_ID} reappeared at ${EXPECTED_ROOT} via disk reconcile\n`,
);
