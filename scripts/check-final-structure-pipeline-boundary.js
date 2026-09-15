#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import {
  failOrPass,
  fileExists,
  listTrackedFiles,
  parseArgs,
} from './check-final-structure-lib.js';

const { repoRoot } = parseArgs();
const errors = [];

// Boundary-by-construction (st_9699c94f, owner-amended AC1): pipeline/ may still
// exist on disk holding UNTRACKED non-leaking subsystem data (quarantine manifest,
// archive, scratch). What must be true for the public/private boundary is that NO
// TRACKED file lives under pipeline/ — a fresh public clone then contains zero
// dev-pipeline artifacts by construction, with no manual scrub. The dev pipeline
// itself lives under user/workbenches/topics/work/robot-dojo/wk_robot_dojo/.
if (fileExists(repoRoot, 'agents/pipeline')) errors.push('pipeline must not be absorbed into agents/');
if (fileExists(repoRoot, 'user/pipeline')) errors.push('pipeline must not be absorbed into user/');

const trackedPipeline = listTrackedFiles(repoRoot).filter((relPath) => relPath.startsWith('pipeline/'));
if (trackedPipeline.length > 0) {
  errors.push(`pipeline/ must hold no tracked files (dev pipeline relocated to workbench); found ${trackedPipeline.length}: ${trackedPipeline.slice(0, 12).join(', ')}`);
}

const misplaced = listTrackedFiles(repoRoot).filter((relPath) =>
  relPath.startsWith('agents/stories/')
  || relPath.startsWith('agents/pipeline/')
  || relPath.startsWith('user/stories/')
  || relPath.startsWith('user/pipeline/'));

if (misplaced.length > 0) {
  errors.push(`tracked pipeline artifacts moved under agents/user: ${misplaced.slice(0, 12).join(', ')}`);
}

failOrPass('check-final-structure-pipeline-boundary', errors, 'ok - zero tracked files under pipeline/; dev pipeline lives under user/workbenches/topics/work/robot-dojo/wk_robot_dojo/');

