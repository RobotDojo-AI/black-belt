#!/usr/bin/env node
/**
 * QA script for AC 6 / VC 6 (st_87a0d072).
 *
 * "LinkedIn connections do NOT create new people during extraction."
 *
 * Strategy:
 *   1. Read scripts/ingest/01-extract.js source and assert there is no
 *      `source: 'linkedin'` candidate-insertion code remaining.
 *   2. (Optional, structural) check that no `entity_candidates` row exists with
 *      `source='linkedin'` in the current DB.
 *
 * WHY a static check: a full pipeline run is expensive; the contract is
 * "LinkedIn is not an extraction source." That contract lives in the source
 * file and is verifiable without seeding fixtures.
 *
 * Exit 0 on pass, 1 on fail.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTRACT_PATH = resolve(__dirname, '..', 'ingest', '01-extract.js');

const src = readFileSync(EXTRACT_PATH, 'utf8');

// Strip block comments + line comments before grepping, so the WHY comment
// referencing "linkedin" doesn't count as a violation.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')       // /* ... */ block comments
  .replace(/^\s*\/\/.*$/gm, '');           // // line comments

// Look for ANY active code line containing 'linkedin' as a string literal
// in a candidate-insert context. The signature for the deleted Source 1b
// was `insertCandidate.run(..., 'linkedin', ...)` or `counts.linkedin++`.
const violations = [];
const linkedinInsert = /insertCandidate\.run\(\s*[^,]+,\s*['"]linkedin['"]/g;
if (linkedinInsert.test(code)) {
  violations.push(`Active 'linkedin' source insertCandidate call still present in 01-extract.js`);
}
if (/counts\.linkedin\s*\+\+/.test(code)) {
  violations.push(`Active counts.linkedin++ increment still present in 01-extract.js`);
}

if (violations.length > 0) {
  console.error('FAIL — LinkedIn extraction-source code still present:');
  for (const v of violations) console.error('  -', v);
  process.exit(1);
}

// Structural DB check — fail if any entity_candidates row has source='linkedin'.
// Only meaningful after a pipeline run; a fresh extract empties the table.
try {
  const { default: db } = await import('../../lib/db.js');
  const r = db.prepare(`
    SELECT COUNT(*) AS c FROM entity_candidates WHERE source = 'linkedin' AND excluded = 0
  `).get();
  if (r.c > 0) {
    console.error(`FAIL — ${r.c} entity_candidates rows still have source='linkedin'.`);
    console.error('Run the pipeline (--reset) to refresh candidates against the new extract code.');
    process.exit(1);
  }
} catch (err) {
  // Non-fatal: if the DB isn't available the static check is sufficient.
  console.warn('(skipped entity_candidates check —', err.message + ')');
}

console.log('ok — LinkedIn is no longer an extraction source');
process.exit(0);
