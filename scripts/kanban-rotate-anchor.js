#!/usr/bin/env node
/**
 * kanban-rotate-anchor.js — shift Day-N labels in the robotdojo section
 * of the canonical kanban.md (PIPELINE_KANBAN_PATH) so Day 0 always refers
 * to today (st_c5e0de43 AC 17).
 *
 * WHY this exists: the robotdojo launch arc uses a Day-N convention
 * anchored at a fixed calendar date — "Day 0 = 2026-05-18". When a session
 * opens on a later date, every Day N label is stale by `today - anchor`
 * days. Re-anchoring manually is error-prone (some labels get shifted,
 * others miss). This script does the rotation deterministically.
 *
 * Algorithm:
 *   1. Find the `## Domain: robotdojo` section.
 *   2. Find the `Anchor: Day 0 = YYYY-MM-DD` line within it.
 *   3. delta = today - anchor_date (in days).
 *   4. Shift every `Day N` token in the robotdojo block by -delta
 *      (excluding the Anchor line itself, which gets rewritten with today).
 *   5. Rewrite the file with the updated anchor + shifted labels.
 *
 * Idempotent: same-day re-run computes delta=0 and is a no-op write.
 *
 * Usage:
 *   node scripts/kanban-rotate-anchor.js [--file <path>] [--today YYYY-MM-DD]
 *
 * Defaults: --file PIPELINE_KANBAN_PATH, --today = today's date in ET.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PIPELINE_KANBAN_PATH } from '../lib/robotdojo-paths.js';

export const INTELLIGENCE_TIER = 'extraction';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--today') args.today = argv[++i];
  }
  return args;
}

function todayET() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
}

function parseISODate(s) {
  // s is YYYY-MM-DD; construct a UTC Date so day arithmetic is stable.
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function daysBetween(a, b) {
  // Returns whole-day count (b - a). Both args are Date objects.
  return Math.round((b - a) / 86400000);
}

const args = parseArgs(process.argv);
const filePath = args.file ?? PIPELINE_KANBAN_PATH;
const today = args.today ?? todayET();

if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  process.stderr.write(`FAIL — invalid --today date "${today}" (expected YYYY-MM-DD)\n`);
  process.exit(1);
}

let text;
try { text = readFileSync(filePath, 'utf8'); }
catch (e) { process.stderr.write(`FAIL — cannot read ${filePath}: ${e.message}\n`); process.exit(1); }

const lines = text.split('\n');

// Locate the robotdojo section.
let sectionStart = -1, sectionEnd = lines.length;
for (let i = 0; i < lines.length; i++) {
  if (/^## Domain: robotdojo\s*$/.test(lines[i])) { sectionStart = i; break; }
}
if (sectionStart === -1) {
  process.stderr.write(`FAIL — no '## Domain: robotdojo' section found in ${filePath}\n`);
  process.exit(1);
}
for (let i = sectionStart + 1; i < lines.length; i++) {
  if (/^## /.test(lines[i])) { sectionEnd = i; break; }
}

// Locate the anchor line.
let anchorIdx = -1, anchorDate = null;
for (let i = sectionStart + 1; i < sectionEnd; i++) {
  const m = lines[i].match(/^Anchor: Day 0 = (\d{4}-\d{2}-\d{2})\s*$/);
  if (m) { anchorIdx = i; anchorDate = m[1]; break; }
}
if (anchorIdx === -1) {
  process.stderr.write(`FAIL — no 'Anchor: Day 0 = YYYY-MM-DD' line in robotdojo section\n`);
  process.exit(1);
}

const delta = daysBetween(parseISODate(anchorDate), parseISODate(today));

if (delta === 0) {
  process.stdout.write(`OK — anchor already at ${today}; no rotation needed.\n`);
  process.exit(0);
}

// Shift every `Day N` token in the robotdojo block. Match `Day -?\d+` so
// negative labels (past dates after rotation) round-trip cleanly. Skip the
// anchor line itself — it gets rewritten outright.
const shifted = [...lines];
const dayRe = /\bDay (-?\d+)\b/g;
for (let i = sectionStart + 1; i < sectionEnd; i++) {
  if (i === anchorIdx) continue;
  shifted[i] = lines[i].replace(dayRe, (_, n) => `Day ${parseInt(n, 10) - delta}`);
}

// Rewrite the anchor line to today.
shifted[anchorIdx] = `Anchor: Day 0 = ${today}`;

writeFileSync(filePath, shifted.join('\n'));
process.stdout.write(`OK — rotated anchor from ${anchorDate} to ${today} (delta=${delta} days); shifted Day labels in robotdojo section.\n`);
process.exit(0);
