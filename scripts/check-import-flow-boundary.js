#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import {
  LEGACY_PRIVATE_RULES,
  failOrPass,
  fileExists,
  parseArgs,
  readText,
  scanLegacyReferences,
} from './check-final-structure-lib.js';

const { repoRoot } = parseArgs();
const errors = [];

for (const relPath of ['user/inbox', 'user/imports', 'user/files']) {
  if (!fileExists(repoRoot, relPath)) errors.push(`missing import boundary path: ${relPath}`);
}

const flowFiles = [
  'lib/drop-folder/paths.js',
  'lib/drop-folder/watcher.js',
  'routes/files.js',
  'routes/accounts.js',
  'routes/setup/steps/drop-folder.js',
  'apps/chat/components/drop-events.js',
  'scripts/init-drop-folder.sh',
].filter((relPath) => fileExists(repoRoot, relPath));

for (const relPath of ['lib/drop-folder/paths.js', 'routes/files.js', 'routes/accounts.js']) {
  if (!fileExists(repoRoot, relPath)) errors.push(`missing import flow implementation file: ${relPath}`);
}

const combined = flowFiles.map((relPath) => readText(repoRoot, relPath)).join('\n');
for (const token of ['user/inbox', 'user/imports', 'user/files']) {
  if (!combined.includes(token)) {
    errors.push(`import flow does not reference canonical ${token}`);
  }
}

if (!/status/i.test(combined)) errors.push('import flow copy/API does not expose status');
if (!/retry/i.test(combined)) errors.push('import flow copy/API does not expose retry');
if (!/error/i.test(combined)) errors.push('import flow copy/API does not expose error state');
if (!/recover|recovery/i.test(combined)) errors.push('import flow copy/API does not expose recovery guidance');

errors.push(...scanLegacyReferences(repoRoot, flowFiles, LEGACY_PRIVATE_RULES));

failOrPass('check-import-flow-boundary', errors, 'ok - import flow uses inbox/imports/files boundary');
