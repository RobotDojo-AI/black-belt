#!/usr/bin/env node
/**
 * check-pipeline-workbench-row.js — AC2 helper for st_9699c94f.
 *
 * Exit 0 iff exactly one workbenches row exists with
 *   root_path = 'user/workbenches/topics/work/robot-dojo/wk_robot_dojo'
 * AND status != 'archived'. Any other count is a fail.
 *
 * Why: AC2 of the pipeline-data-plane story asserts the relocated workbench
 * is registered exactly once in the DB. Dual-registration or missing rows
 * silently break taxonomy + workbench resolution; this check fails loudly.
 */
import db from '../lib/db.js';

export const INTELLIGENCE_TIER = 'extraction';

const EXPECTED_ROOT = 'user/workbenches/topics/work/robot-dojo/wk_robot_dojo';

const row = db
  .prepare(`SELECT count(*) AS n FROM workbenches WHERE root_path = ? AND status != 'archived'`)
  .get(EXPECTED_ROOT);

const count = row?.n ?? 0;

if (count !== 1) {
  process.stderr.write(
    `[check-pipeline-workbench-row] FAIL — expected exactly 1 active workbenches row with root_path=${EXPECTED_ROOT}; found ${count}\n`,
  );
  process.exit(1);
}

process.stdout.write(`[check-pipeline-workbench-row] ok — 1 active row at ${EXPECTED_ROOT}\n`);
