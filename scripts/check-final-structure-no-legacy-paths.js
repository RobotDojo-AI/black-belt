#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import {
  LEGACY_RULES,
  activeTextFiles,
  failOrPass,
  parseArgs,
  scanLegacyReferences,
} from './check-final-structure-lib.js';

const { repoRoot } = parseArgs();
const errors = [];

const files = activeTextFiles(repoRoot, [
  '.',
  'agents',
  'apps',
  'config',
  'docs',
  'lib',
  'routes',
  'scripts',
  'tests',
], [
  'agents/dist/',
  'apps/static/version.json',
  'pipeline/',
]);

errors.push(...scanLegacyReferences(repoRoot, files, LEGACY_RULES, {
  allow: (relPath) => relPath === 'routes/identity.js',
}));

failOrPass('check-final-structure-no-legacy-paths', errors, 'ok - active repo text has no retired root paths');

