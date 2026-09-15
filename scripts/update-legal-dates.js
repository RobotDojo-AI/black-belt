#!/usr/bin/env node
// update-legal-dates.js — pre-commit hook step for legal page date freshness.
// Reads staged files, updates "Last updated: YYYY-MM-DD" body text and
// JSON-LD "dateModified" value in staged legal pages, then re-stages them.
// Only fires when a legal page is actually part of the commit.
//
// WHY: legal pages have "Last updated:" in the visible body and "dateModified"
// in JSON-LD. Keeping them in sync manually is a failure-mode (you edit the
// page and forget to bump the date). This pre-commit step auto-syncs both
// fields to today's date whenever a legal page is staged (st_ba0a385d).
//
// INTELLIGENCE_TIER = 'extraction' (deterministic string replace, zero LLM)
export const INTELLIGENCE_TIER = 'extraction';

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEGAL_PAGES = ['apps/privacy.html', 'apps/terms.html', 'apps/licensing.html'];
const TODAY = new Date().toISOString().slice(0, 10);

const staged = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
const toUpdate = LEGAL_PAGES.filter(p => staged.includes(p));

if (toUpdate.length === 0) process.exit(0);

for (const relPath of toUpdate) {
  const abs = join(ROOT, relPath);
  let content = readFileSync(abs, 'utf8');

  // Update visible body date — "Last updated: YYYY-MM-DD"
  content = content.replace(
    /Last updated:\s*\d{4}-\d{2}-\d{2}/g,
    `Last updated: ${TODAY}`
  );

  // Update JSON-LD dateModified field
  content = content.replace(
    /"dateModified":\s*"\d{4}-\d{2}-\d{2}"/g,
    `"dateModified": "${TODAY}"`
  );

  writeFileSync(abs, content);
  execSync(`git add -- ${JSON.stringify(relPath)}`, { cwd: ROOT });
  console.log(`update-legal-dates: updated ${relPath} → ${TODAY}`);
}
