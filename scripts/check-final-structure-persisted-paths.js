#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import {
  failOrPass,
  fileExists,
  parseArgs,
  readJson,
} from './check-final-structure-lib.js';

const { repoRoot, story } = parseArgs();
const storyId = story || 'st_608fe3ed';
const errors = [];
const relPath = `user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/${storyId}/migration-manifest.json`;

if (!fileExists(repoRoot, relPath)) {
  errors.push(`missing migration manifest: ${relPath}`);
  failOrPass('check-final-structure-persisted-paths', errors);
}

const manifest = readJson(repoRoot, relPath, errors);
const audit = manifest?.persisted_path_audit || manifest?.verification?.persisted_path_audit;

function numericLeaves(value, prefix = '') {
  if (typeof value === 'number') return [{ key: prefix, value }];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => numericLeaves(child, prefix ? `${prefix}.${key}` : key));
}

if (!audit || typeof audit !== 'object') {
  errors.push('persisted_path_audit missing from migration manifest');
} else {
  const leaves = numericLeaves(audit);
  const legacyLeaves = leaves.filter(({ key }) => /(legacy|retired|old|remaining)/i.test(key));
  if (legacyLeaves.length === 0) {
    errors.push('persisted_path_audit must include numeric legacy/retired/old/remaining counts');
  }
  for (const { key, value } of legacyLeaves) {
    if (value !== 0) errors.push(`persisted legacy path count is non-zero: ${key}=${value}`);
  }
}

failOrPass('check-final-structure-persisted-paths', errors, 'ok - persisted path audit reports zero legacy references');

