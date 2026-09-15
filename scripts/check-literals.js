#!/usr/bin/env node
/**
 * check-literals.js — gate against hardcoded versioned model strings and port numbers.
 *
 * WHY: Hardcoded model strings (e.g. 'claude-sonnet-4-6') scattered across the codebase
 * break silently when a new model ships — one place to update, dozens of missed call sites.
 * Port numbers hardcoded outside config.js create the same drift risk.
 * This gate catches violations at commit time so the constants files remain the
 * single source of truth.
 *
 * Usage:
 *   node scripts/check-literals.js lib/              # check a directory
 *   node scripts/check-literals.js lib/chat.js       # check a single file
 *   node scripts/check-literals.js lib/ routes/ index.js  # multiple paths
 *
 * Exit codes: 0 = clean, 1 = violations found, 2 = usage error.
 *
 * Per-line escape: // check-literals:ignore-line
 * Comment filtering: lines that are pure comments (starting with //) are skipped.
 *
 * Allowlisted files (source-of-truth — allowed to contain literals):
 *   lib/compute-tier.js
 *   lib/config.js
 *   lib/public-chat/faq-bundle.js
 *   lib/public-chat/public-truth.js
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename, relative } from 'node:path';

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..');

// Files that are the canonical SOURCE of constants — allowed to contain literals.
const ALLOWLISTED = new Set([
  resolve(REPO_ROOT, 'lib/compute-tier.js'),
  resolve(REPO_ROOT, 'lib/config.js'),
  // Leaf allowlist for per-provider lane heads (df_a00a336b) — must hold versioned IDs.
  resolve(REPO_ROOT, 'lib/model-allowlists.js'),
  resolve(REPO_ROOT, 'lib/public-chat/faq-bundle.js'),
  resolve(REPO_ROOT, 'lib/public-chat/public-truth.js'),
  // Gate scripts that must reference the patterns they enforce.
  resolve(REPO_ROOT, 'scripts/check-literals.js'),
  resolve(REPO_ROOT, 'scripts/check-readme.js'),
]);

// Pattern classes to detect.
const PATTERNS = [
  {
    re: /claude-[a-z]+-[0-9]/,
    label: 'hardcoded versioned model string (use MODELS from lib/compute-tier.js)',
  },
  {
    re: /\b(4338|4336|8765)\b/,
    label: 'hardcoded port number (use config.ports from lib/config.js)',
  },
];

// --files support: if --files is present, treat subsequent args as an explicit
// file list (not walked). If the list is empty after --files, skip (no staged
// files relevant to this gate). Without --files, fall through to existing
// directory/file walk behavior.
const rawArgs = process.argv.slice(2);
const filesIdx = rawArgs.indexOf('--files');
let targets;
let explicitFiles = null; // non-null means --files mode

if (filesIdx !== -1) {
  explicitFiles = rawArgs.slice(filesIdx + 1).filter(a => !a.startsWith('--'));
  if (explicitFiles.length === 0) {
    // No staged files passed — nothing to check in this session.
    process.stdout.write('ok — no literal violations\n');
    process.exit(0);
  }
  targets = null; // not used in --files mode
} else {
  targets = rawArgs;
  if (targets.length === 0) {
    process.stderr.write('Usage: check-literals.js <file-or-dir> [...]\n');
    process.exit(2);
  }
}

function checkFile(filePath) {
  const resolved = resolve(filePath);

  // Skip allowlisted source files.
  if (ALLOWLISTED.has(resolved)) return [];

  let content;
  try {
    content = readFileSync(resolved, 'utf8');
  } catch {
    process.stderr.write(`Cannot read: ${resolved}\n`);
    return [];
  }

  const lines = content.split('\n');
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Skip pure comment lines (// line-comment or * block-comment continuation)
    if (/^\s*\/\//.test(raw)) continue;
    if (/^\s*\*/.test(raw)) continue;

    // Skip lines with the per-line escape annotation.
    if (raw.includes('// check-literals:ignore-line')) continue;

    for (const { re, label } of PATTERNS) {
      if (re.test(raw)) {
        violations.push({
          file: resolved,
          line: i + 1,
          text: raw.trimEnd(),
          label,
        });
      }
    }
  }

  return violations;
}

function collectFiles(p) {
  const resolved = resolve(p);
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    process.stderr.write(`Path not found: ${resolved}\n`);
    process.exit(2);
  }

  if (stat.isDirectory()) {
    const files = [];
    for (const entry of readdirSync(resolved, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Recurse into subdirectories
        files.push(...collectFiles(join(resolved, entry.name)));
      } else if (entry.name.endsWith('.js')) {
        files.push(join(resolved, entry.name));
      }
    }
    return files;
  } else {
    return [resolved];
  }
}

// Collect all files from all targets (or use the explicit --files list).
const allFiles = [];
if (explicitFiles !== null) {
  // --files mode: use the provided list directly. Filter to .js files only,
  // resolve absolute paths, skip non-existent (may be deleted files).
  for (const f of explicitFiles) {
    if (!f.endsWith('.js')) continue;
    const abs = resolve(f);
    allFiles.push(abs);
  }
} else {
  for (const t of targets) {
    allFiles.push(...collectFiles(t));
  }
}

// Deduplicate.
const uniqueFiles = [...new Set(allFiles)];

let totalViolations = 0;

for (const filePath of uniqueFiles.sort()) {
  const viols = checkFile(filePath);
  if (viols.length > 0) {
    const rel = relative(REPO_ROOT, filePath);
    for (const v of viols) {
      process.stderr.write(`${rel}:${v.line}: ${v.label}\n`);
      process.stderr.write(`  ${v.text.slice(0, 120)}\n`);
    }
    totalViolations += viols.length;
  }
}

if (totalViolations > 0) {
  process.stderr.write(`\nTotal: ${totalViolations} literal violation(s)\n`);
  process.exit(1);
} else {
  process.stdout.write('ok — no literal violations\n');
  process.exit(0);
}
