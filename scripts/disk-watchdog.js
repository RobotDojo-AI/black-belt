#!/usr/bin/env node
/**
 * Disk watchdog — bounds Robot Dojo launchd logs before ENOSPC can break relay.
 *
 * LaunchAgent StandardOutPath/StandardErrorPath files do not rotate on their
 * own. The relay depends on the Mac being able to write DB state, certs, and
 * tunnel logs, so unbounded logs are an uptime risk.
 */
export const IDLE_GATED = false;

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIG_DIR = process.env.ROBOTDOJO_CONFIG || resolve(homedir(), '.robotdojo');
const LOG_DIR = process.env.ROBOTDOJO_LOG_DIR || resolve(CONFIG_DIR, 'logs');
const MAX_LOG_BYTES = Number(process.env.ROBOTDOJO_DISK_WATCHDOG_MAX_LOG_BYTES || 10 * 1024 * 1024);
const KEEP_LOG_BYTES = Number(process.env.ROBOTDOJO_DISK_WATCHDOG_KEEP_LOG_BYTES || 1024 * 1024);
const DISK_FLOOR_GB = Number(process.env.ROBOTDOJO_DISK_WATCHDOG_FLOOR_GB || 8);

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => process.stderr.write(`[${ts()}] ${m}\n`);

export function parseDfAvailableGb(output) {
  const lines = String(output || '').trim().split(/\n+/);
  if (lines.length < 2) return null;
  const fields = lines[1].trim().split(/\s+/);
  const availableKb = Number(fields[3]);
  return Number.isFinite(availableKb) ? availableKb / 1024 / 1024 : null;
}

export function diskFreeGb(path = CONFIG_DIR) {
  try {
    return parseDfAvailableGb(execFileSync('df', ['-Pk', path], { encoding: 'utf8', timeout: 5000 }));
  } catch {
    return null;
  }
}

export function isPrunableLog(filename) {
  return /\.(?:log|out|err|json)$/.test(filename);
}

export function pruneLargeLog(file, {
  maxBytes = MAX_LOG_BYTES,
  keepBytes = KEEP_LOG_BYTES,
  dryRun = DRY_RUN,
} = {}) {
  const size = statSync(file).size;
  if (size <= maxBytes) return { file, pruned: false, size };
  const keep = Math.max(0, Math.min(keepBytes, size));
  const fdTail = readFileSync(file).subarray(size - keep);
  const header = Buffer.from(`[robotdojo disk-watchdog pruned ${size - keep} bytes at ${new Date().toISOString()}]\n`);
  if (!dryRun) writeFileSync(file, Buffer.concat([header, fdTail]));
  return { file, pruned: true, size, kept: keep, dryRun };
}

export function pruneLogDir(dir = LOG_DIR, opts = {}) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const name of readdirSync(dir)) {
    if (!isPrunableLog(name)) continue;
    const file = resolve(dir, name);
    try {
      if (statSync(file).isFile()) results.push(pruneLargeLog(file, opts));
    } catch {}
  }
  return results;
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  const before = diskFreeGb(CONFIG_DIR);
  const results = pruneLogDir(LOG_DIR);
  const after = diskFreeGb(CONFIG_DIR);
  const pruned = results.filter((r) => r.pruned);

  if (pruned.length) {
    log(`pruned ${pruned.length} log(s): ${pruned.map((r) => `${r.file.split('/').pop()}:${r.size}`).join(', ')}`);
  } else {
    log('no oversized logs');
  }
  if (after !== null && after < DISK_FLOOR_GB) {
    log(`LOW DISK: ${after.toFixed(2)}GB free below ${DISK_FLOOR_GB}GB floor`);
    process.exitCode = 1;
  } else {
    log(`disk ok: free=${after === null ? 'unknown' : `${after.toFixed(2)}GB`} before=${before === null ? 'unknown' : `${before.toFixed(2)}GB`}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
