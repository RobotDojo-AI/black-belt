#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import {
  LEGACY_RULES,
  activeTextFiles,
  failOrPass,
  fileExists,
  parseArgs,
  readText,
  scanLegacyReferences,
} from './check-final-structure-lib.js';

const { repoRoot } = parseArgs();
const errors = [];

if (!fileExists(repoRoot, 'lib/robotdojo-paths.js')) {
  errors.push('missing named path contract: lib/robotdojo-paths.js');
} else {
  const contract = readText(repoRoot, 'lib/robotdojo-paths.js');
  for (const token of [
    'AGENTS_ROOT',
    'AGENT_PERSONAS_DIR',
    'AGENT_SKILLS_DIR',
    'AGENT_DIST_DIR',
    'USER_ROOT',
    'USER_PROFILE_PATH',
    'USER_INBOX_DIR',
    'USER_IMPORTS_DIR',
    'USER_FILES_DIR',
    'USER_CONTEXTS_DIR',
    'USER_WORKBENCHES_DIR',
    'USER_TRANSCRIPTS_DIR',
    'USER_MEMORY_DIR',
    'USER_DATABASES_DIR',
  ]) {
    if (!new RegExp(`\\b${token}\\b`).test(contract)) {
      errors.push(`lib/robotdojo-paths.js missing ${token}`);
    }
  }
  for (const legacy of [
    'ROBOTDOJO_USERFILES_ROOT',
    'ROBOTDOJO_CONTEXTS_ROOT',
    'ROBOTDOJO_WORKBENCHES_ROOT',
    'ROBOTDOJO_TRANSCRIPTS_ROOT',
    'ROBOTDOJO_IMPORTS_ROOT',
    'ROBOTDOJO_DOCS_ROOT',
    'IDENTITY_ROOT',
    'SKILLS_ROOT',
    'LEGACY_',
  ]) {
    if (contract.includes(legacy)) {
      errors.push(`lib/robotdojo-paths.js exposes legacy alias/env: ${legacy}`);
    }
  }
}

const files = activeTextFiles(repoRoot, ['lib', 'routes', 'scripts'], [
  'scripts/check-final-structure',
  'scripts/check-agent-os',
]);
errors.push(...scanLegacyReferences(repoRoot, files, LEGACY_RULES));

failOrPass('check-final-structure-path-contract', errors, 'ok - runtime paths flow through final path contract');

