#!/usr/bin/env node
/**
 * check-readme.js — guards README.md invariants from regressing.
 *
 * Checks:
 *   1. No stale http://127.0.0.1 references (server is https://localhost:4338)
 *   2. No stale ~/.robotdojo/ path references (DB is ~/robotdojo/user/databases/)
 *   3. No hardcoded test counts in old '383 regression' format
 *   4. Port 4338 is mentioned (confirms the correct port is documented)
 *
 * Exit 0 = all clear. Exit 1 = violations found (list printed to stderr).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readmePath = join(__dirname, '..', 'README.md');
const content = readFileSync(readmePath, 'utf8');
const lines = content.split('\n');

const violations = [];

for (let i = 0; i < lines.length; i++) {
  const lineNum = i + 1;
  const line = lines[i];

  if (/127\.0\.0\.1/.test(line)) {
    violations.push(`Line ${lineNum}: stale 127.0.0.1 (should be localhost:4338) — ${line.trim()}`); // check-literals:ignore-line
  }
  if (/~\/\.robotdojo\//.test(line)) {
    violations.push(`Line ${lineNum}: stale ~/.robotdojo/ path (DB is ~/robotdojo/user/databases/) — ${line.trim()}`);
  }
  if (/\d+ regression tests/.test(line)) {
    violations.push(`Line ${lineNum}: hardcoded regression test count (derive dynamically or remove) — ${line.trim()}`);
  }
}

if (!content.includes('4338')) { // check-literals:ignore-line
  violations.push('README does not mention port 4338 — correct port must be documented'); // check-literals:ignore-line
}

if (violations.length > 0) {
  for (const v of violations) process.stderr.write(`[check-readme] ${v}\n`);
  process.exit(1);
}

process.stdout.write('[check-readme] ok\n');
