#!/usr/bin/env node
/**
 * scripts/check-idle-gated.js — st_f6315f0b AC 10 / VC 10
 *
 * Pre-commit hook that rejects any commit which adds a new com.robotdojo.*
 * launchd plist whose entrypoint script does NOT declare IDLE_GATED.
 *
 * Strategy:
 *   1. Find staged files via `git diff --cached --name-only --diff-filter=A`
 *      AND staged plist files in any path (added or modified) that match
 *      com.robotdojo.*.plist.
 *   2. For each, parse ProgramArguments (use PlistBuddy when the plist is
 *      installed at ~/Library/LaunchAgents, otherwise read the file
 *      directly with a small XML regex — plists are small + structured).
 *   3. Resolve the entrypoint to a repo-relative path.
 *   4. Assert the entrypoint declares `export const IDLE_GATED = true|false`
 *      (or the bash `# IDLE_GATED=true|false` comment form).
 *   5. If missing, exit 1 with a specific message naming the entrypoint.
 *
 * Stage path: this hook is wired into scripts/pre-commit.sh AFTER gate.js,
 * so structure violations surface first.
 *
 * Test fixture path: scripts/qa/idle-gate-precommit-fixture.sh creates
 * a fixture plist + entrypoint missing IDLE_GATED and asserts the hook
 * rejects it.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const FIXTURE_PLIST = args[0] || null;   // QA mode: check a specific file

function fail(msg) {
  console.error(`[check-idle-gated] FAIL: ${msg}`);
  console.error(`\nFix: add \`export const IDLE_GATED = true|false\` (or for bash: \`# IDLE_GATED=true|false\`) to the entrypoint script before committing.`);
  console.error(`See lib/idle-gate.js + docs/launch-agents.md for context.`);
  process.exit(1);
}

function stagedPlists() {
  if (FIXTURE_PLIST) return [FIXTURE_PLIST];
  try {
    const out = execSync('git diff --cached --name-only', { cwd: REPO_ROOT, encoding: 'utf8' });
    return out.split('\n').filter(f => /com\.robotdojo\..*\.plist$/.test(f));
  } catch {
    return [];
  }
}

/**
 * Parse ProgramArguments from a plist file as a flat array of strings.
 * We bypass PlistBuddy because the staged plist may not be installed yet —
 * we want to validate the FILE, not the live registry.
 */
function readProgramArguments(plistPath) {
  if (!existsSync(plistPath)) return [];
  const xml = readFileSync(plistPath, 'utf8');
  // Find the <key>ProgramArguments</key> block + the immediately-following <array>.
  const m = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!m) return [];
  // Pull every <string>…</string> in order.
  const strings = [];
  const rx = /<string>([\s\S]*?)<\/string>/g;
  let match;
  while ((match = rx.exec(m[1])) !== null) strings.push(match[1]);
  return strings;
}

function resolveEntrypoint(plistPath) {
  const args = readProgramArguments(plistPath);
  if (args.length === 0) return null;
  // Resolve script under the repo. Three forms:
  //  - ['node', '/abs/path/script.js']
  //  - ['__NODE__', '__ROBOTDOJO_HOME__/script.js'] in install templates
  //  - ['/bin/sh', '-c', '... script.js ...']
  //  - ['/abs/path/script.sh']  (shebang)
  // .mjs accepted alongside .js/.sh — st_2cd1af73 added the first .mjs daemon
  // entrypoint (chunk-embed-daemon.mjs); without .mjs the resolver could not
  // find it and falsely reported the plist as missing an IDLE_GATED declaration.
  if (args[0] === '/bin/sh' && args[1] === '-c' && args[2]) {
    const m = args[2].match(new RegExp(`${REPO_ROOT.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}/[^\\s&]+\\.(mjs|js|sh)`));
    return m ? m[0] : null;
  }
  for (const a of args) {
    if (a && a.startsWith('__ROBOTDOJO_HOME__/') && /\.(mjs|js|sh)$/.test(a)) {
      return join(REPO_ROOT, a.slice('__ROBOTDOJO_HOME__/'.length));
    }
    if (a && a.startsWith(REPO_ROOT) && /\.(mjs|js|sh)$/.test(a)) return a;
  }
  if (args.some(a => a && a.endsWith('/index.js'))) return args.find(a => a.endsWith('/index.js'));
  return null;
}

function hasIdleGatedDeclaration(scriptPath) {
  if (!existsSync(scriptPath)) return false;
  const content = readFileSync(scriptPath, 'utf8');
  // Walk lines so a JSDoc / `//` comment mentioning the literal text
  // never satisfies the gate (this file itself documents the constant).
  for (const line of content.split('\n')) {
    const trimmed = line.replace(/^\s+/, '');
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    if (/^export\s+const\s+IDLE_GATED\s*=\s*(true|false)\s*;?/.test(trimmed)) return true;
  }
  for (const line of content.split('\n').slice(0, 20)) {
    if (/^#\s*IDLE_GATED\s*=\s*(true|false)\b/.test(line)) return true;
  }
  return false;
}

const targets = stagedPlists();
if (targets.length === 0) {
  // No staged plists → nothing to enforce. Most commits hit this fast path.
  process.exit(0);
}

const failures = [];
for (const plist of targets) {
  const absPlist = plist.startsWith('/') ? plist : join(REPO_ROOT, plist);
  const entrypoint = resolveEntrypoint(absPlist);
  if (!entrypoint) {
    failures.push(`${plist}: could not resolve entrypoint script from ProgramArguments`);
    continue;
  }
  if (!hasIdleGatedDeclaration(entrypoint)) {
    failures.push(`${plist}\n    entrypoint: ${entrypoint}\n    add IDLE_GATED-missing declaration to the entrypoint`);
  }
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`[check-idle-gated] ${f}`);
  }
  fail(`${failures.length} plist(s) missing IDLE_GATED-missing entrypoint declaration`);
}

process.exit(0);
