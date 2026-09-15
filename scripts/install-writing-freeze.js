#!/usr/bin/env node
/**
 * Install writing-freeze hooks for Claude, Grok, Cursor, Codex.
 *
 * Frozen writing is the web/mobile product path. Coding-agent hosts already
 * inline voice at session open. Registering a UserPromptSubmit + Stop freeze
 * on those hosts invented FROZEN bodies and blocked the live reply.
 * This installer removes those entries. A host with no config dir still
 * fails closed (does not claim a force path).
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SRC = join(HERE, 'writing-freeze-hook.mjs');

export function installWritingFreeze({ home = homedir() } = {}) {
  const report = {};

  const claudeDir = join(home, '.claude');
  if (existsSync(claudeDir)) {
    const hooksDir = join(claudeDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const dest = join(hooksDir, 'writing-freeze-hook.mjs');
    copyFileSync(HOOK_SRC, dest);
    chmodSync(dest, 0o755);
    const settingsPath = join(claudeDir, 'settings.json');
    let settings = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { settings = {}; }
    }
    settings.hooks = settings.hooks || {};
    const filter = (arr) => (arr || []).filter((e) => !JSON.stringify(e).includes('writing-freeze-hook'));
    settings.hooks.UserPromptSubmit = filter(settings.hooks.UserPromptSubmit);
    settings.hooks.Stop = filter(settings.hooks.Stop);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    report.claude = { ok: true, path: 'coding_agent_noop' };
  } else {
    report.claude = { ok: false, reason: 'no_force_path' };
  }

  const grokDir = join(home, '.grok');
  if (existsSync(grokDir)) {
    const hooksDir = join(grokDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'writing-freeze.json'), JSON.stringify({
      hooks: {},
    }, null, 2) + '\n');
    report.grok = { ok: true, path: 'coding_agent_noop' };
  } else {
    report.grok = { ok: false, reason: 'no_force_path' };
  }

  const cursorDir = join(home, '.cursor');
  if (existsSync(cursorDir)) {
    const hooksPath = join(cursorDir, 'hooks.json');
    let hooks = { hooks: {} };
    if (existsSync(hooksPath)) {
      try { hooks = JSON.parse(readFileSync(hooksPath, 'utf8')); } catch { hooks = { hooks: {} }; }
    }
    hooks.hooks = hooks.hooks || {};
    const drop = (arr) => (arr || []).filter((e) => !JSON.stringify(e).includes('writing-freeze-hook'));
    hooks.hooks.UserPromptSubmit = drop(hooks.hooks.UserPromptSubmit);
    hooks.hooks.stop = drop(hooks.hooks.stop);
    writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + '\n');
    report.cursor = { ok: true, path: 'coding_agent_noop' };
  } else {
    report.cursor = { ok: false, reason: 'no_force_path' };
  }

  const codexDir = join(home, '.codex');
  if (existsSync(codexDir)) {
    mkdirSync(join(codexDir, 'hooks'), { recursive: true });
    writeFileSync(join(codexDir, 'hooks', 'writing-freeze.json'), JSON.stringify({
      hooks: {},
    }, null, 2) + '\n');
    report.codex = { ok: true, path: 'coding_agent_noop' };
  } else {
    report.codex = { ok: false, reason: 'no_force_path' };
  }

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = installWritingFreeze();
  for (const [host, r] of Object.entries(report)) {
    if (!r.ok) process.stderr.write(`[install-writing-freeze] ${host}: FAIL no force path\n`);
    else process.stdout.write(`[install-writing-freeze] ${host}: ${r.path}\n`);
  }
}
