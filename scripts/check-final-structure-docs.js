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
  'docs',
  'apps/static',
  'lib/public-chat',
  'CLAUDE.md',
  'README.md',
  'architecture/architecture.md',
  'architecture/structure.md',
  'architecture/product.md',
  'architecture/ontology.md',
  'architecture/sitemap.md',
  'config',
], ['apps/static/version.json']);

errors.push(...scanLegacyReferences(repoRoot, files, LEGACY_RULES));

failOrPass('check-final-structure-docs', errors, 'ok - docs and generated inventories do not teach retired roots');

