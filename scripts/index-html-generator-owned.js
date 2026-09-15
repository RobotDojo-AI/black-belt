#!/usr/bin/env node
/**
 * Exit 0 when apps/index.html's working-tree delta vs HEAD is confined to
 * generator-owned homepage FAQ + belt-price stamps. Exit 1 otherwise
 * (hand-authored marketing copy changed, or the file is missing).
 *
 * Used by scripts/detax.sh so those stamps commit with public-truth, without
 * auto-staging an unrelated homepage copy edit sitting in the same file.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexHtmlDiffIsGeneratorOwned } from './generate-public-truth.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_REL = 'apps/index.html';

function headHtml() {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'show', `HEAD:${INDEX_REL}`], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

const work = readFileSync(join(REPO_ROOT, INDEX_REL), 'utf8');
process.exit(indexHtmlDiffIsGeneratorOwned(headHtml(), work) ? 0 : 1);
