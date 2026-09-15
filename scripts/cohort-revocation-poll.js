#!/usr/bin/env node
/**
 * Hourly cohort revocation poller + soft-delete tick.
 *
 * Responsibilities:
 *   1. Fetch https://robotdojo.ai/api/bb-revocation.json, verify signature,
 *      replace the cached document at ~/.robotdojo/cohort-revocation.json.
 *      On failure the cache is left untouched and last_failed_poll_at is
 *      updated. (Original responsibility — st_5a63545d AC 19.)
 *
 *   2. Compute days-since-expiry against BB_VALID_UNTIL. If within the
 *      7-day warning window: write `days_until_delete` to
 *      ~/.robotdojo/state/days_until_delete.json — the server-health route
 *      reads this file and surfaces the field. If past the 14-day grace
 *      period: walk `config/bb-files.json#bb_repo_paths` and
 *      `bb_user_data_paths` and rm -rf each, then kickstart the server so
 *      the freshly stripped BB modules reload as WB. (st_bc949e7c AC 14/15.)
 *
 * Installed as a launchd timer (com.robotdojo.cohort-poll.plist) running
 * every 3600s with RunAtLoad=true.
 *
 * CLI flags:
 *   --dry-run             skip the real revocation fetch (smoke test only)
 *   --mock-expiry-days=N  override days-since-expiry to N (testing)
 *   --manifest <path>     override config/bb-files.json (testing)
 *   --root <path>         repo root for resolving manifest paths (testing)
 *   --state-dir <path>    override ~/.robotdojo/state (testing)
 *
 * INTELLIGENCE_TIER annotation: this script is plumbing (no LLM calls).
 * The `extraction` tier formally applies (deterministic signal extraction +
 * deterministic filesystem ops) — no DB writes.
 */

export const INTELLIGENCE_TIER = 'extraction';
export const IDLE_GATED = false;

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { pollRevocation } from '../lib/cohort/revocation.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

function parseArgs(argv) {
  const out = {
    dryRun: false,
    mockExpiryDays: null,
    manifest: resolve(REPO_ROOT, 'config/bb-files.json'),
    root: REPO_ROOT,
    stateDir: resolve(homedir(), '.robotdojo', 'state'),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--mock-expiry-days=')) out.mockExpiryDays = parseInt(a.split('=')[1], 10);
    else if (a === '--mock-expiry-days') out.mockExpiryDays = parseInt(argv[++i], 10);
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--state-dir') out.stateDir = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: cohort-revocation-poll.js [--dry-run] [--mock-expiry-days=N] [--manifest <path>] [--root <path>] [--state-dir <path>]');
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

async function getDaysSinceExpiry(mockExpiryDays) {
  if (mockExpiryDays !== null && Number.isFinite(mockExpiryDays)) {
    return mockExpiryDays;
  }
  // Read BB_VALID_UNTIL from build-info.js (the canonical source the
  // entitlement check reads). When build-info.js is absent (dev/no key
  // shipped yet), treat as "not expired" → days_since_expiry < 0 forever.
  try {
    const mod = await import('../lib/cohort/build-info.js');
    if (!mod?.BB_VALID_UNTIL) return Number.NEGATIVE_INFINITY;
    const exp = Date.parse(mod.BB_VALID_UNTIL);
    if (!Number.isFinite(exp)) return Number.NEGATIVE_INFINITY;
    return Math.floor((Date.now() - exp) / 86400000);
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

function writeDaysUntilDelete(stateDir, days) {
  mkdirSync(stateDir, { recursive: true });
  const path = resolve(stateDir, 'days_until_delete.json');
  writeFileSync(path, JSON.stringify({ days, updated_at: new Date().toISOString() }, null, 2));
  console.log(`[cohort-poll] days_until_delete=${days} → ${path}`);
}

function clearDaysUntilDelete(stateDir) {
  const path = resolve(stateDir, 'days_until_delete.json');
  if (existsSync(path)) {
    rmSync(path);
    console.log(`[cohort-poll] cleared days_until_delete state at ${path}`);
  }
}

function archiveDestination(abs, archiveRoot) {
  const home = homedir();
  const rel = abs.startsWith(home + '/') ? abs.slice(home.length + 1) : abs.replace(/^\/+/, '');
  let dest = resolve(archiveRoot, rel);
  if (existsSync(dest)) dest = `${dest}.${Date.now()}`;
  return dest;
}

function archiveUserPath(abs, archiveRoot) {
  const dest = archiveDestination(abs, archiveRoot);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(abs, dest);
  console.log(`[cohort-poll] archived ${abs} -> ${dest}`);
  return dest;
}

function softDelete(manifest, root, archiveRoot) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch (e) {
    console.error(`[cohort-poll] cannot read manifest ${manifest}: ${e.message}`);
    return { deleted: 0, error: e.message };
  }

  let deleted = 0;
  let archived = 0;
  const errors = [];
  const repoPaths = Array.isArray(cfg.bb_repo_paths) ? cfg.bb_repo_paths : [];
  const userPaths = Array.isArray(cfg.bb_user_data_paths) ? cfg.bb_user_data_paths : [];

  for (const p of repoPaths) {
    const abs = resolve(root, p);
    try {
      if (existsSync(abs)) {
        rmSync(abs, { recursive: true, force: true });
        deleted++;
        console.log(`[cohort-poll] deleted ${abs}`);
      }
    } catch (e) { errors.push(`${p}: ${e.message}`); }
  }
  for (const p of userPaths) {
    const abs = expandTilde(p);
    try {
      if (existsSync(abs)) {
        archiveUserPath(abs, archiveRoot);
        archived++;
      }
    } catch (e) { errors.push(`${p}: ${e.message}`); }
  }

  return { deleted, archived, archiveRoot, errors };
}

function kickstartServer() {
  try {
    execSync('launchctl kickstart -k system/com.robotdojo.server', { stdio: 'inherit' });
    console.log('[cohort-poll] server kickstart → WB mode');
  } catch (e) {
    console.warn(`[cohort-poll] kickstart failed: ${e.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.dryRun) {
    console.log('[cohort-revocation-poll] --dry-run — skipping actual fetch');
    process.exit(0);
  }

  // Step 1: revocation fetch. Skipped under --mock-expiry-days because tests
  // never want to make real network calls.
  if (args.mockExpiryDays === null) {
    const r = await pollRevocation();
    if (r.ok) {
      console.log(`[cohort-revocation-poll] ok — ${r.weeks.length} revoked week(s) cached`);
    } else {
      console.warn(`[cohort-revocation-poll] failed: ${r.reason}`);
      // Exit 0 even on failure — the cached cache is still valid for 48h
      // and a non-zero exit would spam launchd error logs on every failed
      // poll. The reason is captured in the cache's last_failed_poll_at.
    }
  }

  // Step 2: soft-delete tick.
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(args.manifest, 'utf8'));
  } catch (e) {
    console.warn(`[cohort-poll] manifest read failed (${args.manifest}): ${e.message} — skipping soft-delete`);
    process.exit(0);
  }
  const warningDays = cfg.warning_period_days ?? 7;
  const graceDays = cfg.grace_period_days ?? 14;

  const daysSinceExpiry = await getDaysSinceExpiry(args.mockExpiryDays);

  if (daysSinceExpiry < 0) {
    // Key still valid — clear any prior warning state and exit.
    clearDaysUntilDelete(args.stateDir);
    console.log(`[cohort-poll] key still valid (days_since_expiry=${daysSinceExpiry})`);
    process.exit(0);
  }

  if (daysSinceExpiry < graceDays) {
    // Within the warning / grace window — surface days_until_delete.
    const daysUntilDelete = graceDays - daysSinceExpiry;
    if (daysSinceExpiry < warningDays) {
      // 0..warningDays: full grace minus elapsed = warningDays + (graceDays - warningDays - elapsed).
      // Simpler: days_until_delete = graceDays - daysSinceExpiry.
      writeDaysUntilDelete(args.stateDir, daysUntilDelete);
    } else {
      // warningDays..graceDays: same expression, smaller value.
      writeDaysUntilDelete(args.stateDir, daysUntilDelete);
    }
    console.log(`[cohort-poll] in warning window: days_since_expiry=${daysSinceExpiry} days_until_delete=${daysUntilDelete}`);
    process.exit(0);
  }

  // daysSinceExpiry >= graceDays — remove repo-owned BB code and archive
  // user-owned BB artifacts. Entitlement enforcement must not destroy local
  // user data; archived files remain recoverable under the state directory.
  console.log(`[cohort-poll] grace exceeded (days_since_expiry=${daysSinceExpiry} >= ${graceDays}) — disabling BB files`);
  const archiveRoot = resolve(args.stateDir, 'bb-expired-archive');
  const result = softDelete(args.manifest, args.root, archiveRoot);
  console.log(`[cohort-poll] disable complete: ${result.deleted} repo path(s) removed, ${result.archived} user path(s) archived`);
  if (result.errors?.length) {
    console.warn(`[cohort-poll] errors: ${result.errors.join('; ')}`);
  }

  // Clear the warning state — soft-delete is final, no banner needed.
  clearDaysUntilDelete(args.stateDir);

  // Skip server kickstart in mock mode (tests are sandboxed).
  if (args.mockExpiryDays === null) kickstartServer();
  process.exit(0);
}

main().catch((e) => {
  console.error('[cohort-revocation-poll] fatal:', e.message);
  process.exit(1);
});
