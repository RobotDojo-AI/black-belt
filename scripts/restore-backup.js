#!/usr/bin/env node
// scripts/restore-backup.js — st_7fcebb44
//
// Restores files from a backup taken by backup-substrate.js.
//
// CLI: node restore-backup.js <story_id> [--rung N|all] [--yes] [--home <path>]
//   - No --rung: restore from ~/robotdojo/.backup/<story_id>/ (the no-rung snapshot)
//   - --rung N: restore from rung-N
//   - --rung all: replay rung-1, rung-2, rung-3 in order (last wins)
//   - --yes: skip confirmation prompt (required for non-interactive use)
//
// Exit 0 on success, 1 on missing manifest or copy failure.
//
// Tier: orchestration (no LLM).

import { readFileSync, existsSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, posix, sep } from 'node:path';
import { homedir } from 'node:os';

const HOME_DEFAULT = homedir();

function parseArgs(argv) {
  const out = { storyId: null, rung: null, phase: null, yes: false, dryRun: false, home: HOME_DEFAULT };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--rung' && argv[i + 1]) {
      out.rung = String(argv[i + 1]); i++;
    } else if (argv[i] === '--phase' && argv[i + 1]) {
      const v = String(argv[i + 1]);
      if (v !== 'start' && v !== 'close') {
        process.stderr.write(`error: --phase must be 'start' or 'close', got '${v}'\n`);
        process.exit(1);
      }
      out.phase = v; i++;
    } else if (argv[i] === '--dry-run') {
      out.dryRun = true;
    } else if (argv[i] === '--yes') {
      out.yes = true;
    } else if (argv[i] === '--home' && argv[i + 1]) {
      out.home = argv[i + 1]; i++;
    } else {
      positional.push(argv[i]);
    }
  }
  out.storyId = positional[0];
  return out;
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// Convert POSIX-style relative path (as stored in manifest) to native abs path.
function manifestPathToAbs(rel, home) {
  const native = rel.split(posix.sep).join(sep);
  return isAbsolute(native) ? native : join(home, native);
}

function restoreFrom(backupDir, home, dryRun = false) {
  const manifestPath = join(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    process.stderr.write(`manifest missing: ${manifestPath}\n`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let restored = 0;
  for (const rel of Object.keys(manifest.files)) {
    const src = join(backupDir, rel.split(posix.sep).join(sep));
    const dest = manifestPathToAbs(rel, home);
    if (!existsSync(src)) {
      process.stderr.write(`backup source missing: ${src}\n`);
      process.exit(1);
    }
    if (dryRun) {
      process.stdout.write(`would restore: ${src} → ${dest}\n`);
    } else {
      ensureDir(dirname(dest));
      copyFileSync(src, dest);
    }
    restored += 1;
  }
  return restored;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.storyId) {
    process.stderr.write('usage: restore-backup.js <story_id> [--rung N|all | --phase start|close] [--dry-run] [--yes]\n');
    process.exit(1);
  }
  if (args.rung && args.phase) {
    process.stderr.write('error: --rung and --phase are mutually exclusive\n');
    process.exit(1);
  }
  if (!args.yes && !args.dryRun) {
    process.stderr.write('refusing to restore without --yes (interactive confirm not implemented)\n');
    process.exit(1);
  }
  const base = join(args.home, 'robotdojo', '.backup', args.storyId);
  if (!existsSync(base)) {
    process.stderr.write(`no backup root: ${base}\n`);
    process.exit(1);
  }
  let total = 0;
  if (args.rung === 'all') {
    for (const r of ['1', '2', '3']) {
      const d = join(base, `rung-${r}`);
      if (!existsSync(d)) continue;
      total += restoreFrom(d, args.home, args.dryRun);
    }
  } else if (args.rung) {
    total += restoreFrom(join(base, `rung-${args.rung}`), args.home, args.dryRun);
  } else if (args.phase) {
    total += restoreFrom(join(base, args.phase), args.home, args.dryRun);
  } else {
    total += restoreFrom(base, args.home, args.dryRun);
  }
  process.stdout.write(`${args.dryRun ? 'would restore' : 'restored'}: ${total} files\n`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { parseArgs, restoreFrom };
