#!/usr/bin/env node
/**
 * Update Robot Dojo to the latest version.
 * git pull + npm ci + restart launchd service.
 * Called by the `check_for_updates` chat tool.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, cwd: ROOT, encoding: 'utf8', ...opts });
}

async function main() {
  console.log('[update] checking for updates...');

  // Check current version
  const before = run('git rev-parse --short HEAD').stdout.trim();

  // Fetch + pull
  const fetch = run('git fetch origin main --quiet');
  if (fetch.status !== 0) {
    console.error('[update] git fetch failed:', fetch.stderr);
    process.exit(1);
  }

  const behind = run('git rev-list --count HEAD..origin/main').stdout.trim();
  if (behind === '0') {
    console.log('[update] already up to date');
    process.exit(0);
  }

  console.log(`[update] ${behind} new commit(s) — pulling...`);
  const pull = run('git pull origin main --ff-only');
  if (pull.status !== 0) {
    console.error('[update] git pull failed:', pull.stderr);
    process.exit(1);
  }

  // Install new deps
  console.log('[update] installing dependencies...');
  const install = run('npm ci --omit=dev --silent');
  if (install.status !== 0) {
    console.error('[update] npm ci failed:', install.stderr);
    process.exit(1);
  }

  const after = run('git rev-parse --short HEAD').stdout.trim();
  console.log(`[update] updated ${before} → ${after}`);

  // Restart launchd service
  const uid = run('id -u').stdout.trim();
  const restart = run(`launchctl kickstart -k gui/${uid}/com.robotdojo.server`);
  if (restart.status === 0) {
    console.log('[update] service restarted');
  } else {
    console.warn('[update] service restart failed (may need manual restart):', restart.stderr);
  }

  console.log('[update] done');
}

main().catch(err => { console.error('[update] error:', err.message); process.exit(1); });
