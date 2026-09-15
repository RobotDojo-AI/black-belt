#!/usr/bin/env node
/**
 * check-bb-files-manifest.js — pre-commit validator for config/bb-files.json.
 *
 * st_bc949e7c Pass B Phase 5.2 (2026-05-15).
 *
 * Validates that every path listed under `bb_repo_paths` exists in the repo.
 * Catches typos at commit time so the cohort-revocation-poll's soft-delete
 * walk doesn't silently no-op against a path that was renamed or removed
 * after the manifest was written.
 *
 * Why catch this at commit time: cohort soft-delete is a destructive
 * operation that runs on user machines on grace expiry. A path that
 * silently doesn't match means a BB surface stays installed past the grace
 * window — bad for the entitlement guarantee, bad for the user's trust
 * that lapsed-key behavior is predictable.
 *
 * Args:
 *   --manifest <path>  default ../config/bb-files.json (relative to this script)
 *   --root <path>      default ../  (so we resolve manifest paths relative to repo root)
 *
 * Exit codes:
 *   0  all listed paths exist in the repo
 *   1  at least one path is missing — error includes which paths
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_MANIFEST = resolve(DEFAULT_ROOT, 'config/bb-files.json');

function parseArgs(argv) {
  const out = { manifest: DEFAULT_MANIFEST, root: DEFAULT_ROOT };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: check-bb-files-manifest.js [--manifest <path>] [--root <path>]');
      process.exit(0);
    }
  }
  return out;
}

function expandTilde(p) {
  if (typeof p !== 'string') return p;
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

function main() {
  const { manifest, root } = parseArgs(process.argv);

  let cfg;
  try {
    cfg = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch (e) {
    console.error(`[check-bb-files-manifest] cannot read ${manifest}: ${e.message}`);
    process.exit(1);
  }

  const repoPaths = Array.isArray(cfg.bb_repo_paths) ? cfg.bb_repo_paths : [];
  if (repoPaths.length === 0) {
    console.error('[check-bb-files-manifest] bb_repo_paths missing or empty');
    process.exit(1);
  }

  const missing = [];
  for (const p of repoPaths) {
    // bb_repo_paths are repo-relative — never use ~ here (those are user data).
    const abs = resolve(root, p);
    if (!existsSync(abs)) missing.push(p);
  }

  if (missing.length > 0) {
    console.error('[check-bb-files-manifest] missing bb_repo_paths:');
    for (const p of missing) console.error('  - ' + p);
    process.exit(1);
  }

  // bb_user_data_paths are NOT validated for existence — they may not exist
  // until the user has populated them (e.g. ~/.robotdojo/contexts/ is created
  // lazily by the entity pipeline). We only validate that ~ expansion works.
  const userPaths = Array.isArray(cfg.bb_user_data_paths) ? cfg.bb_user_data_paths : [];
  for (const p of userPaths) {
    const expanded = expandTilde(p);
    if (typeof expanded !== 'string' || expanded.length === 0) {
      console.error(`[check-bb-files-manifest] bad bb_user_data_paths entry: ${JSON.stringify(p)}`);
      process.exit(1);
    }
  }

  console.log(`ok — ${repoPaths.length} repo paths verified, ${userPaths.length} user data paths declared`);
  process.exit(0);
}

main();
