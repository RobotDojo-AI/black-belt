#!/usr/bin/env node
/**
 * scripts/qa/watchdog-protected-check.js — st_f6315f0b AC 6 / VC 6
 *
 * Asserts: the watchdog's OS_PROTECTED set contains every interactive
 * surface (WindowServer, loginwindow, kernel_task, launchd, Ghostty,
 * Claude, com.robotdojo.server) AND contains NO IDLE_GATED=true
 * com.robotdojo.* slot.
 *
 * Class definition (from scope):
 *   interactive  = loss would break the user's current session.
 *   background   = loss is recoverable on next launchd fire.
 *
 * Strategy:
 *   1. Grep `OS_PROTECTED="..."` line in scripts/ram-watchdog.sh.
 *   2. Parse the pipe-separated list into an array.
 *   3. Assert each required interactive surface is present.
 *   4. Enumerate IDLE_GATED=true workers — assert none appear in the list.
 *
 * Exit 0 with single OK line on pass.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const REQUIRED_INTERACTIVE = [
  'WindowServer', 'loginwindow', 'kernel_task',
  'launchd', 'Ghostty', 'Claude', 'com.robotdojo.server',
];

// 1. Parse OS_PROTECTED from ram-watchdog.sh.
const watchdog = readFileSync(`${REPO_ROOT}/scripts/ram-watchdog.sh`, 'utf8');
// The OS_PROTECTED= line might appear multiple times historically; we want
// the LAST non-comment one (the live definition).
const lines = watchdog.split('\n');
let osProtectedValue = null;
for (const line of lines) {
  const trimmed = line.replace(/\s+#.*$/, '').trim();
  const m = trimmed.match(/^OS_PROTECTED=["']([^"']*)["']/);
  if (m) osProtectedValue = m[1];
}
if (!osProtectedValue) fail('OS_PROTECTED line not found in scripts/ram-watchdog.sh');

const protected_set = new Set(osProtectedValue.split('|'));

// 2. Assert all required interactive surfaces are present.
const missing = REQUIRED_INTERACTIVE.filter(s => !protected_set.has(s));
if (missing.length > 0) {
  fail(`OS_PROTECTED missing interactive surfaces: ${missing.join(', ')}`);
}

// 3. Enumerate IDLE_GATED=true workers and assert none are in the set.
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

const launchAgents = join(homedir(), 'Library', 'LaunchAgents');
const plists = readdirSync(launchAgents)
  .filter(f => /^com\.robotdojo\..*\.plist$/.test(f));

const idleGatedSlots = [];
for (const plistFile of plists) {
  const plist = join(launchAgents, plistFile);
  const ep = resolveEntrypoint(plist);
  if (!ep) continue;
  const src = readFileSync(ep, 'utf8');
  let isJsTrue = false;
  for (const line of src.split('\n')) {
    const trimmed = line.replace(/^\s+/, '');
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    if (/^export\s+const\s+IDLE_GATED\s*=\s*true\b/.test(trimmed)) { isJsTrue = true; break; }
  }
  let isBashTrue = false;
  for (const line of src.split('\n').slice(0, 20)) {
    const m = line.match(/^#\s*IDLE_GATED\s*=\s*(true|false)\b/);
    if (m) { isBashTrue = m[1] === 'true'; break; }
  }
  if (isJsTrue || isBashTrue) {
    const label = plistFile.replace(/\.plist$/, '');
    idleGatedSlots.push(label);
  }
}

const violations = idleGatedSlots.filter(s => protected_set.has(s));
if (violations.length > 0) {
  fail(`OS_PROTECTED erroneously includes IDLE_GATED workers: ${violations.join(', ')}`);
}

console.log(
  `OK: OS_PROTECTED correct (${REQUIRED_INTERACTIVE.length} interactive surfaces included, ${violations.length} IDLE_GATED workers included)`
);
process.exit(0);
