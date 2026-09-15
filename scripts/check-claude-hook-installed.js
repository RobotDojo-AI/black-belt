#!/usr/bin/env node
// scripts/check-claude-hook-installed.js — df_974525f2: drift check for the
// Claude Code hooks that scripts/install-claude-hook.js manages. Catches the
// "shipped but never installed" class: a hook committed to the repo (and
// registered in the installer) that never reached this machine's ~/.claude —
// the exact gap that left work-record-gate.mjs uninstalled while the /work
// skill assumed it was live.
//
// Deterministic, no LLM, no db.js. The managed-hook list is DERIVED from the
// installer source, not duplicated here: install-claude-hook.js declares each
// hook it deploys as `resolve(HOOKS_DIR, '<file>.mjs')` (and registers it in
// settings.json by that same filename), so parsing those declarations keeps
// this check in lockstep when the installer gains or drops a hook. The
// installer offers no importable manifest (importing it runs main()), so
// parsing its declarations is the closest programmatic mirror.
//
// Exit codes:
//   0 — every managed hook is present in ~/.claude/hooks/ AND registered in
//       ~/.claude/settings.json; or ~/.claude does not exist (fresh machine /
//       CI — nothing to enforce, warn only).
//   1 — one or more managed hooks missing or unregistered (each named), or the
//       installer source could not be parsed (manifest drift is itself a fail).
//
// HOME resolves via os.homedir() so a HOME override (e.g. in a test fixture)
// redirects the check to the fake home.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALLER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'install-claude-hook.js');

function managedHooks() {
  const src = readFileSync(INSTALLER_PATH, 'utf8');
  // Matches the installer's deploy-target declarations:
  //   const HOOK_TARGET = resolve(HOOKS_DIR, 'robotdojo-session-log.mjs');
  //   const WORK_GATE_TARGET = resolve(HOOKS_DIR, 'work-record-gate.mjs');
  const names = new Set();
  for (const m of src.matchAll(/resolve\(HOOKS_DIR,\s*'([^']+)'\)/g)) names.add(m[1]);
  return [...names];
}

const hooks = managedHooks();
if (hooks.length === 0) {
  console.error(`[check-claude-hook-installed] FAIL — could not derive any managed hooks from ${INSTALLER_PATH}; the installer's declaration pattern changed and this check needs updating.`);
  process.exit(1);
}

const claudeDir = resolve(homedir(), '.claude');
if (!existsSync(claudeDir)) {
  console.warn(`[check-claude-hook-installed] warning: ${claudeDir} does not exist (fresh machine/CI) — nothing to enforce.`);
  process.exit(0);
}

const hooksDir = resolve(claudeDir, 'hooks');
const settingsPath = resolve(claudeDir, 'settings.json');

let registeredCommands = [];
if (existsSync(settingsPath)) {
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const entries of Object.values(settings.hooks || {})) {
      for (const entry of entries || []) {
        for (const h of entry.hooks || []) {
          if (typeof h.command === 'string') registeredCommands.push(h.command);
        }
      }
    }
  } catch (err) {
    console.error(`[check-claude-hook-installed] ${settingsPath} is not valid JSON (${err.message}) — treating all hooks as unregistered.`);
  }
}

const missing = [];
for (const hook of hooks) {
  const filePresent = existsSync(resolve(hooksDir, hook));
  const registered = registeredCommands.some((c) => c.includes(hook));
  if (!filePresent || !registered) {
    missing.push(`${hook} (${filePresent ? 'file ok' : 'file missing from ' + hooksDir}; ${registered ? 'registered' : 'not registered in settings.json'})`);
  }
}

if (missing.length) {
  console.error('[check-claude-hook-installed] FAIL — managed Claude hooks not fully installed:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('Fix: node scripts/install-claude-hook.js');
  process.exit(1);
}

console.log(`[check-claude-hook-installed] ok — ${hooks.length} managed hook(s) installed and registered: ${hooks.join(', ')}`);
