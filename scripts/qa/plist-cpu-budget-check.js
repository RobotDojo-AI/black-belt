#!/usr/bin/env node
/**
 * scripts/qa/plist-cpu-budget-check.js — st_f6315f0b AC 4 / VC 4
 *
 * Asserts: every IDLE_GATED=true worker's launchd plist sets
 * `ProcessType=Background` AND `Nice=10`. These kernel scheduling primitives
 * confine the worker to E-cores at ~1050 MHz on Apple Silicon — the platform
 * IS the CPU budget. No cpulimit, no setrlimit wrappers.
 *
 * Strategy:
 *   1. List com.robotdojo.*.plist files in ~/Library/LaunchAgents.
 *   2. For each, resolve the entrypoint and parse IDLE_GATED declaration.
 *   3. For IDLE_GATED=true workers, assert PlistBuddy reports both keys.
 *
 * Exit 0 with single OK line on pass.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const LAUNCH_AGENTS = join(homedir(), 'Library', 'LaunchAgents');
const REPO_ROOT = join(homedir(), 'robotdojo');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function plistArg(plist, key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function resolveEntrypoint(plist) {
  const args = [];
  for (let i = 0; i < 10; i++) {
    try {
      const out = execFileSync('/usr/libexec/PlistBuddy', [
        '-c', `Print :ProgramArguments:${i}`, plist,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      args.push(out);
    } catch { break; }
  }
  if (args.length === 0) return null;
  if (args[0] === '/bin/sh' && args[1] === '-c' && args[2]) {
    const m = args[2].match(new RegExp(`${REPO_ROOT.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}/[^\\s&]+\\.(js|sh)`));
    return m ? m[0] : null;
  }
  for (const a of args) if (a && a.startsWith(REPO_ROOT) && /\.(js|sh)$/.test(a)) return a;
  if (args.some(a => a && a.endsWith('/index.js'))) return args.find(a => a.endsWith('/index.js'));
  return null;
}

function isIdleGatedTrue(path) {
  if (!path || !existsSync(path)) return false;
  const c = readFileSync(path, 'utf8');
  // JS form: walk lines, skip JSDoc / `//` comments.
  for (const line of c.split('\n')) {
    const trimmed = line.replace(/^\s+/, '');
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    if (/^export\s+const\s+IDLE_GATED\s*=\s*true\b/.test(trimmed)) return true;
  }
  // Bash convention: the FIRST `# IDLE_GATED=...` comment in the file is
  // the declaration. Walk lines until we find one. Anything after is
  // documentation (e.g., examples showing both true/false).
  for (const line of c.split('\n').slice(0, 20)) {
    const m = line.match(/^#\s*IDLE_GATED\s*=\s*(true|false)\b/);
    if (m) return m[1] === 'true';
  }
  return false;
}

const plists = readdirSync(LAUNCH_AGENTS)
  .filter(f => /^com\.robotdojo\..*\.plist$/.test(f))
  .map(f => join(LAUNCH_AGENTS, f));

const idleGatedPlists = [];
for (const plist of plists) {
  const ep = resolveEntrypoint(plist);
  if (isIdleGatedTrue(ep)) idleGatedPlists.push({ plist, entrypoint: ep });
}

if (idleGatedPlists.length === 0) {
  fail('no IDLE_GATED=true plists found');
}

const failures = [];
for (const { plist, entrypoint } of idleGatedPlists) {
  const processType = plistArg(plist, 'ProcessType');
  const nice = plistArg(plist, 'Nice');
  if (processType !== 'Background') {
    failures.push(`${plist} (${entrypoint}): ProcessType=${processType} (expected Background)`);
  }
  if (nice !== '10') {
    failures.push(`${plist} (${entrypoint}): Nice=${nice} (expected 10)`);
  }
}

if (failures.length > 0) {
  fail(`${failures.length} plist key(s) missing/wrong:\n  ${failures.join('\n  ')}`);
}

console.log(`OK: every IDLE_GATED worker plist (${idleGatedPlists.length} checked) has ProcessType=Background and Nice=10`);
process.exit(0);
