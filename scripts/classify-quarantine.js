#!/usr/bin/env node
/**
 * classify-quarantine.js — route files out of quarantine/ to their correct home.
 *
 * Walks quarantine/, infers the correct destination per STRUCTURE.md rules,
 * prints proposed moves, and optionally executes them.
 *
 * Usage:
 *   node scripts/classify-quarantine.js           # dry-run (default)
 *   node scripts/classify-quarantine.js --dry-run # explicit dry-run
 *   node scripts/classify-quarantine.js --execute # actually move files
 *   node scripts/classify-quarantine.js --execute --force  # overwrite existing
 */

import { readdirSync, statSync, renameSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const QUARANTINE = join(REPO_ROOT, 'quarantine');

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--execute');
const FORCE = args.includes('--force');

if (!existsSync(QUARANTINE)) {
  console.log('quarantine/ does not exist — nothing to classify');
  process.exit(0);
}

function classify(file) {
  const name = basename(file);
  const ext = extname(name).toLowerCase();
  const lower = name.toLowerCase();

  // Skill files
  if (lower === 'skill.md') return { dest: 'agents/skills/', confidence: 'manual', reason: 'skill definition — determine correct skill subdir' };

  // Test files
  if (lower.endsWith('.test.js') || lower.endsWith('.spec.js')) return { dest: 'tests/', confidence: 'high', reason: 'test file by name convention' };

  // Pipeline / story artifacts
  if (/^\d{2}-/.test(name) && ext === '.md') return { dest: 'pipeline/', confidence: 'manual', reason: 'looks like a pipeline stage artifact — find the right story dir' };

  // Scripts
  if (ext === '.js' || ext === '.mjs' || ext === '.sh' || ext === '.py') {
    // Check if it exports something (lib) vs runs something (scripts)
    return { dest: 'scripts/', confidence: 'medium', reason: 'executable script — verify it does not belong in lib/' };
  }

  // Library modules — harder to distinguish from scripts without reading content
  if (ext === '.js' && (lower.includes('util') || lower.includes('helper') || lower.includes('lib'))) {
    return { dest: 'lib/', confidence: 'medium', reason: 'name suggests a library module' };
  }

  // Documentation
  if (ext === '.md' && !lower.startsWith('skill')) return { dest: 'docs/', confidence: 'medium', reason: 'markdown document' };

  // Config
  if (ext === '.json' && (lower.includes('config') || lower.includes('settings') || lower.includes('model'))) {
    return { dest: 'config/', confidence: 'medium', reason: 'JSON config file by name' };
  }

  // User files
  if (['.pdf', '.docx', '.xlsx', '.csv', '.pptx'].includes(ext)) {
    return { dest: 'user/files/', confidence: 'high', reason: 'user-supplied document' };
  }

  // Media
  if (['.jpg', '.jpeg', '.png', '.gif', '.mp4', '.mov', '.heic'].includes(ext)) {
    return { dest: 'media/', confidence: 'high', reason: 'media file by extension' };
  }

  return null;
}

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    if (entry === 'README.md') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

const files = walk(QUARANTINE);

if (files.length === 0) {
  console.log('quarantine/ is empty — nothing to classify');
  process.exit(0);
}

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Classifying ${files.length} file(s) in quarantine/\n`);

let moved = 0;
let manual = 0;

for (const file of files) {
  const name = basename(file);
  const result = classify(file);

  if (!result) {
    console.log(`[MANUAL] ${name} — cannot determine destination. Read STRUCTURE.md and move manually.`);
    manual++;
    continue;
  }

  const dest = join(REPO_ROOT, result.dest, name);
  const tag = result.confidence === 'high' ? '[MOVE]' : result.confidence === 'medium' ? '[LIKELY]' : '[MANUAL]';

  if (result.confidence === 'manual') {
    console.log(`[MANUAL] ${name} → ${result.dest} — ${result.reason}`);
    manual++;
    continue;
  }

  console.log(`${tag} ${name} → ${result.dest} (${result.reason})`);

  if (!DRY_RUN) {
    if (existsSync(dest) && !FORCE) {
      console.log(`  SKIP — ${dest} already exists. Use --force to overwrite.`);
      continue;
    }
    renameSync(file, dest);
    console.log(`  MOVED`);
    moved++;
  }
}

console.log(`\n${DRY_RUN ? 'Dry run complete' : `Moved ${moved} file(s)`}. ${manual} file(s) require manual review.`);
if (manual > 0) {
  console.log('Read STRUCTURE.md to determine correct locations for manual items.');
}
