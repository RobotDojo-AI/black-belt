#!/usr/bin/env node
// scripts/install-claude-hook.js — wire robotdojo session-log hook into the
// user's Claude Code settings.
//
// Idempotent. Safe to re-run. Preserves existing hook entries — only
// adds/updates the robotdojo-session-log entries.
//
// Usage:
//   node scripts/install-claude-hook.js              # install
//   node scripts/install-claude-hook.js --uninstall  # remove

import { readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';

const CLAUDE_DIR = resolve(homedir(), '.claude');
const SETTINGS_PATH = resolve(CLAUDE_DIR, 'settings.json');
const HOOKS_DIR = resolve(CLAUDE_DIR, 'hooks');
const HOOK_TARGET = resolve(HOOKS_DIR, 'robotdojo-session-log.mjs');
const HOOK_SOURCE = resolve(dirname(new URL(import.meta.url).pathname), 'claude-code-hook.mjs');

// st_862d73d1 AC1 — the work-record-gate UserPromptSubmit hook. Detects
// `/work {workbench}` (and covers /story, /defect for symmetry) and
// auto-creates-or-blocks the intake record before the prompt reaches the model.
const WORK_GATE_TARGET = resolve(HOOKS_DIR, 'work-record-gate.mjs');
const WORK_GATE_SOURCE = resolve(dirname(new URL(import.meta.url).pathname), 'work-record-gate.mjs');
const RAW_LLM_TARGET = resolve(HOOKS_DIR, 'raw-llm-guard.mjs');
const RAW_LLM_SOURCE = resolve(dirname(new URL(import.meta.url).pathname), 'raw-llm-guard.mjs');

const ID_MARKER = '# robotdojo-session-log';

const UNINSTALL = process.argv.includes('--uninstall');

function makeCommand(eventType) {
  return `node ${HOOK_TARGET} ${eventType}`;
}

function isRobotdojoEntry(entry) {
  if (!entry || !entry.hooks) return false;
  return entry.hooks.some((h) =>
    h.type === 'command' &&
    typeof h.command === 'string' &&
    h.command.includes('robotdojo-session-log.mjs'),
  );
}

// st_862d73d1 AC1 — identify the work-record-gate UserPromptSubmit entry so
// re-running the installer replaces (not duplicates) it.
function isWorkGateEntry(entry) {
  if (!entry || !entry.hooks) return false;
  return entry.hooks.some((h) =>
    h.type === 'command' &&
    typeof h.command === 'string' &&
    h.command.includes('work-record-gate.mjs'),
  );
}

function isRawLlmEntry(entry) {
  if (!entry || !entry.hooks) return false;
  return entry.hooks.some((h) =>
    h.type === 'command' &&
    typeof h.command === 'string' &&
    h.command.includes('raw-llm-guard.mjs'),
  );
}

function addRawLlmHook(settings) {
  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((e) => !isRawLlmEntry(e));
  settings.hooks.PreToolUse.push({
    matcher: 'Write|Edit|MultiEdit|Bash',
    hooks: [{ type: 'command', command: `node ${RAW_LLM_TARGET}` }],
  });
}

function addWorkGateHook(settings) {
  settings.hooks = settings.hooks || {};
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];
  // Remove any existing work-gate entries first so re-run is idempotent.
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter((e) => !isWorkGateEntry(e));
  settings.hooks.UserPromptSubmit.push({
    matcher: '',
    hooks: [{ type: 'command', command: `node ${WORK_GATE_TARGET}` }],
  });
}

function addHook(settings, eventName, eventType, matcher = '') {
  settings.hooks = settings.hooks || {};
  settings.hooks[eventName] = settings.hooks[eventName] || [];
  // Remove any existing robotdojo entries for this event to avoid duplicates.
  settings.hooks[eventName] = settings.hooks[eventName].filter((e) => !isRobotdojoEntry(e));
  settings.hooks[eventName].push({
    matcher,
    hooks: [{ type: 'command', command: makeCommand(eventType) }],
  });
}

function removeRobotdojoEntries(settings) {
  if (!settings.hooks) return;
  for (const eventName of Object.keys(settings.hooks)) {
    settings.hooks[eventName] = (settings.hooks[eventName] || [])
      .filter((e) => !isRobotdojoEntry(e) && !isWorkGateEntry(e) && !isRawLlmEntry(e));
    if (settings.hooks[eventName].length === 0) delete settings.hooks[eventName];
  }
}

async function main() {
  if (!existsSync(CLAUDE_DIR)) {
    throw new Error(`Claude Code config directory not found at ${CLAUDE_DIR}. Install Claude Code first.`);
  }

  let settings = {};
  if (existsSync(SETTINGS_PATH)) {
    const raw = await readFile(SETTINGS_PATH, 'utf8');
    try { settings = JSON.parse(raw); }
    catch (err) { throw new Error(`settings.json is not valid JSON: ${err.message}`); }
  }

  if (UNINSTALL) {
    removeRobotdojoEntries(settings);
    await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
    console.log('[install-claude-hook] removed robotdojo session-log entries from settings.json');
    console.log(`[install-claude-hook] hook script at ${HOOK_TARGET} left in place — delete manually if desired.`);
    return;
  }

  // 1. Install the hook scripts into ~/.claude/hooks/
  await mkdir(HOOKS_DIR, { recursive: true });
  await copyFile(HOOK_SOURCE, HOOK_TARGET);
  await chmod(HOOK_TARGET, 0o755);
  console.log(`[install-claude-hook] hook script → ${HOOK_TARGET}`);
  await copyFile(WORK_GATE_SOURCE, WORK_GATE_TARGET);
  await chmod(WORK_GATE_TARGET, 0o755);
  console.log(`[install-claude-hook] hook script → ${WORK_GATE_TARGET}`);
  await copyFile(RAW_LLM_SOURCE, RAW_LLM_TARGET);
  await chmod(RAW_LLM_TARGET, 0o755);
  console.log(`[install-claude-hook] hook script → ${RAW_LLM_TARGET}`);

  // 2. Add entries to settings.json
  addHook(settings, 'UserPromptSubmit', 'prompt');
  addHook(settings, 'PostToolUse', 'tool');
  addHook(settings, 'Stop', 'stop');
  // st_abf246e4 — SubagentStop fires on sidechain completion (not Stop), so a
  // spawned sub-agent session captures live instead of waiting for the reconcile
  // sweep. Same hook script, event arg 'subagentstop'.
  addHook(settings, 'SubagentStop', 'subagentstop');
  // st_862d73d1 AC1 — register the work-record-gate as a second, separate
  // UserPromptSubmit entry (idempotent: re-run replaces it, never duplicates).
  addWorkGateHook(settings);
  addRawLlmHook(settings);

  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  console.log(`[install-claude-hook] updated ${SETTINGS_PATH}`);
  console.log(`[install-claude-hook] hooks registered: UserPromptSubmit (session-log + work-record-gate) · PreToolUse (raw-llm-guard) · PostToolUse · Stop · SubagentStop`);
  console.log(`[install-claude-hook] auth token expected at Keychain service \`robotdojo-ROBOTDOJO_AUTH_TOKEN\``);
  console.log(`[install-claude-hook] hook posts to http://127.0.0.1:${process.env.PORT_APP || '4338'}/api/session-log/turn`); // check-literals:ignore-line
  console.log(`[install-claude-hook] done. Open a new Claude Code session to start logging.`);
}

main().catch((err) => {
  console.error('[install-claude-hook] error:', err.message);
  process.exit(1);
});
