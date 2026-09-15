#!/usr/bin/env node
/**
 * scripts/qa/idle-gate-registry-check.js — st_f6315f0b AC 2 / VC 2
 *
 * Asserts: every launchd entrypoint script registered in a com.robotdojo.*
 * plist declares IDLE_GATED as a boolean. The class is predicate-defined —
 * every plist's ProgramArguments resolves to a script, every script must
 * declare. A new launchd job added tomorrow without the declaration fails
 * this AC immediately.
 *
 * Strategy:
 *   1. List all com.robotdojo.*.plist files in ~/Library/LaunchAgents.
 *   2. For each plist, extract the entrypoint script path from
 *      ProgramArguments (handle /bin/sh -c bash-style args).
 *   3. Resolve the script to its absolute repo path. Skip plists whose
 *      entrypoint is outside the repo (litestream binary, etc.).
 *   4. Grep the script for the declaration:
 *        - JS: `export const IDLE_GATED = (true|false)`
 *        - Bash: `# IDLE_GATED=(true|false)` near the top
 *   5. Single OK line with the enumerated count.
 *
 * Exit 0 OK / 1 FAIL.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const LAUNCH_AGENTS = join(homedir(), 'Library', 'LaunchAgents');
const REPO_ROOT = join(homedir(), 'robotdojo');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

/**
 * Read the entrypoint script path from a plist's ProgramArguments.
 * Returns null when the entrypoint is not resolvable to a repo script
 * (e.g. /opt/homebrew/bin/litestream is an external binary).
 */
function resolveEntrypoint(plistPath) {
  // Use PlistBuddy to enumerate ProgramArguments.
  let args = [];
  for (let i = 0; i < 10; i++) {
    try {
      const out = execFileSync('/usr/libexec/PlistBuddy', [
        '-c', `Print :ProgramArguments:${i}`, plistPath,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      args.push(out);
    } catch {
      break;
    }
  }
  if (args.length === 0) return null;

  // Cases:
  // 1. ['node', '/path/to/foo.js']                 → /path/to/foo.js
  // 2. ['/bin/sh', '-c', 'node /path/foo.js && …'] → /path/foo.js
  // 3. ['/path/to/foo.js']                         → /path/to/foo.js (shebang)
  // 4. ['/path/to/foo.sh']                         → /path/to/foo.sh
  if (args[0] === '/bin/sh' && args[1] === '-c' && args[2]) {
    // Extract the first .js or .sh under the repo root.
    const m = args[2].match(new RegExp(`${REPO_ROOT.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}/[^\\s&]+\\.(js|sh)`));
    return m ? m[0] : null;
  }
  // Skip the interpreter — the script is usually arg[0] or arg[1].
  for (const a of args) {
    if (a && a.startsWith(REPO_ROOT) && /\.(js|sh)$/.test(a)) return a;
  }
  // Server: index.js is reachable via REPO_ROOT/index.js
  if (args.some(a => a && a.endsWith('/index.js'))) {
    return args.find(a => a.endsWith('/index.js'));
  }
  return null;
}

function hasIdleGatedDeclaration(scriptPath) {
  if (!existsSync(scriptPath)) return false;
  const content = readFileSync(scriptPath, 'utf8');
  // JS export form OR bash comment form. Walk lines so we never match a
  // JSDoc / `//` comment that mentions the literal text. Bash form is
  // similarly restricted to the first 20 lines.
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

const plists = readdirSync(LAUNCH_AGENTS)
  .filter(f => /^com\.robotdojo\..*\.plist$/.test(f))
  .map(f => join(LAUNCH_AGENTS, f));

if (plists.length === 0) {
  fail(`no com.robotdojo.*.plist files found in ${LAUNCH_AGENTS}`);
}

let checked = 0;
const missing = [];
for (const plist of plists) {
  const entrypoint = resolveEntrypoint(plist);
  if (!entrypoint) {
    // External binary (litestream) — count as in-scope only if a repo
    // script resolves. Otherwise skip with a note.
    continue;
  }
  checked++;
  if (!hasIdleGatedDeclaration(entrypoint)) {
    missing.push(`${plist}\n    entrypoint: ${entrypoint}`);
  }
}

if (missing.length > 0) {
  fail(`${missing.length} plist(s) missing IDLE_GATED declaration:\n  ${missing.join('\n  ')}`);
}

console.log(`OK: every launchd entrypoint (${checked} enumerated) declares IDLE_GATED`);
process.exit(0);
