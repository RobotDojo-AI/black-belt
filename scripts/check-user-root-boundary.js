#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import {
  LEGACY_PRIVATE_RULES,
  RETIRED_PRIVATE_ROOTS,
  USER_CHILDREN,
  activeTextFiles,
  failOrPass,
  fileExists,
  parseArgs,
  readText,
  requireTrackedAbsent,
  scanLegacyReferences,
} from './check-final-structure-lib.js';

const { repoRoot } = parseArgs();
const errors = [];

if (!fileExists(repoRoot, 'user/.gitignore')) {
  errors.push('missing user/.gitignore');
} else {
  const ignore = readText(repoRoot, 'user/.gitignore');
  if (!/^\*$/m.test(ignore) || !/^!\.gitignore$/m.test(ignore)) {
    errors.push('user/.gitignore must self-ignore all private user content except .gitignore');
  }
}

for (const child of USER_CHILDREN) {
  if (!fileExists(repoRoot, `user/${child}`)) {
    errors.push(`missing canonical user substrate path: user/${child}`);
  }
}

requireTrackedAbsent(repoRoot, RETIRED_PRIVATE_ROOTS, errors);

const runtimeFiles = activeTextFiles(repoRoot, ['lib', 'routes', 'scripts'], [
  'lib/public-chat/',
  'scripts/check-final-structure',
  'scripts/check-agent-os',
]);

errors.push(...scanLegacyReferences(repoRoot, runtimeFiles, LEGACY_PRIVATE_RULES));

failOrPass('check-user-root-boundary', errors, 'ok - private substrate is rooted under user/');
