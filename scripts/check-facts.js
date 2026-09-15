#!/usr/bin/env node
/**
 * check-facts.js — verify CLAUDE.md LOC count is within 2% of live tokei output.
 *
 * WHY: CLAUDE.md contains an architecture LOC count that drifts as code grows.
 * This gate verifies the count stays accurate so the doc remains trustworthy.
 * The 2% tolerance accommodates minor additions between generate-facts.js runs
 * without false positives.
 *
 * Usage:
 *   node scripts/check-facts.js
 *
 * Exit 0: within tolerance. Exit 1: stale count. Non-zero if tokei not in PATH.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TOLERANCE = 0.02; // 2%

// ── Run tokei ─────────────────────────────────────────────────────────────────

let tokeiOutput;
try {
  tokeiOutput = execSync('tokei lib/ routes/ index.js --output json', {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
} catch (err) {
  if (err.code === 'ENOENT' || /not found|not recognized/i.test(String(err))) {
    process.stderr.write('ERROR: tokei is not in PATH. Install with: brew install tokei\n');
    process.exit(1);
  }
  process.stderr.write(`ERROR: tokei failed: ${err.message}\n`);
  process.exit(1);
}

const tokeiJson = JSON.parse(tokeiOutput);
const liveLoc = tokeiJson.Total?.code;
if (typeof liveLoc !== 'number') {
  process.stderr.write('ERROR: tokei JSON did not contain Total.code\n');
  process.exit(1);
}

// ── Read CLAUDE.md ────────────────────────────────────────────────────────────

const claudePath = resolve(REPO_ROOT, 'CLAUDE.md');
let claudeContent;
try {
  claudeContent = readFileSync(claudePath, 'utf8');
} catch {
  process.stderr.write(`ERROR: Cannot read ${claudePath}\n`);
  process.exit(1);
}

const match = claudeContent.match(/~([0-9,]+) LOC/);
if (!match) {
  process.stderr.write('ERROR: Could not find ~NNN LOC pattern in CLAUDE.md\n');
  process.exit(1);
}

const docLoc = parseInt(match[1].replace(/,/g, ''), 10);
const delta = Math.abs(liveLoc - docLoc) / liveLoc;

if (delta > TOLERANCE) {
  const pct = (delta * 100).toFixed(1);
  process.stderr.write(
    `STALE: CLAUDE.md says ~${docLoc.toLocaleString()} LOC, tokei reports ${liveLoc.toLocaleString()} (${pct}% drift — limit 2%)\n` +
    `Run: node scripts/generate-facts.js\n`
  );
  process.exit(1);
}

process.stdout.write(
  `ok — CLAUDE.md ${docLoc.toLocaleString()} LOC vs tokei ${liveLoc.toLocaleString()} (${(delta * 100).toFixed(1)}% drift, within 2%)\n`
);
process.exit(0);
