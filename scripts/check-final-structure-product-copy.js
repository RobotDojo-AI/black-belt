#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import {
  LEGACY_PRIVATE_RULES,
  activeTextFiles,
  failOrPass,
  parseArgs,
  readText,
  scanLegacyReferences,
} from './check-final-structure-lib.js';

const { repoRoot } = parseArgs();
const errors = [];

const files = activeTextFiles(repoRoot, [
  'apps',
  'routes',
  'lib/public-chat',
  'docs',
  'README.md',
  'architecture/product.md',
], ['apps/static/version.json']);

errors.push(...scanLegacyReferences(repoRoot, files, LEGACY_PRIVATE_RULES));

const combined = files.map((relPath) => {
  try {
    return readText(repoRoot, relPath);
  } catch {
    return '';
  }
}).join('\n');

for (const token of ['user/inbox', 'user/imports', 'user/files']) {
  if (!combined.includes(token)) {
    errors.push(`product/user-facing copy does not mention ${token}`);
  }
}

for (const word of ['status', 'retry', 'error', 'recovery']) {
  if (!new RegExp(word, 'i').test(combined)) {
    errors.push(`product/user-facing copy does not mention import ${word}`);
  }
}

failOrPass('check-final-structure-product-copy', errors, 'ok - user-facing copy uses final import/data boundaries');

