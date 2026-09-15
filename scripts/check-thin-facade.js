#!/usr/bin/env node
/**
 * check-thin-facade.js — structural gate for the thin facade pattern.
 *
 * WHY: Routes must contain zero db.prepare calls. Any db.prepare in a route
 * makes the query untestable without a live server. This gate exits non-zero
 * when violations are found, enabling enforcement in CI, skill gates, and
 * pre-commit hooks.
 *
 * Usage:
 *   node scripts/check-thin-facade.js routes/network.js   # single file
 *   node scripts/check-thin-facade.js routes/             # full directory
 *
 * Exit 0: no violations. Exit 1: violations found. Exit 2: usage error.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const target = process.argv[2];
if (!target) {
  process.stderr.write('Usage: check-thin-facade.js <file-or-dir>\n');
  process.exit(2);
}

function checkFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    process.stderr.write(`Cannot read: ${filePath}\n`);
    return [];
  }
  const lines = content.split('\n');
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\//.test(line)) continue; // skip comment lines
    if (/db\.prepare/.test(line)) {
      violations.push({ line: i + 1, text: line.trimEnd() });
    }
  }
  return violations;
}

function checkPath(p) {
  const resolved = resolve(p);
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    process.stderr.write(`Path not found: ${resolved}\n`);
    process.exit(2);
  }

  let totalViolations = 0;

  if (stat.isDirectory()) {
    const files = readdirSync(resolved)
      .filter(f => f.endsWith('.js'))
      .sort();
    for (const file of files) {
      const v = checkFile(join(resolved, file));
      if (v.length > 0) {
        process.stderr.write(`${file}: ${v.length} db.prepare violation(s)\n`);
        for (const viol of v) {
          process.stderr.write(`  L${viol.line}: ${viol.text.slice(0, 120)}\n`);
        }
        totalViolations += v.length;
      }
    }
  } else {
    const v = checkFile(resolved);
    if (v.length > 0) {
      process.stderr.write(`${basename(resolved)}: ${v.length} db.prepare violation(s)\n`);
      for (const viol of v) {
        process.stderr.write(`  L${viol.line}: ${viol.text.slice(0, 120)}\n`);
      }
      totalViolations += v.length;
    }
  }

  return totalViolations;
}

const total = checkPath(target);
if (total > 0) {
  process.stderr.write(`\nTotal: ${total} thin-facade violation(s) — routes must contain zero db.prepare calls\n`);
  process.exit(1);
} else {
  process.stdout.write('ok — no thin-facade violations\n');
  process.exit(0);
}
