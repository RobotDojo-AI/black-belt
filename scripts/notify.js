#!/usr/bin/env node
// notify.js — fire-and-forget Telegram ping for pipeline events that need the operator's attention.
//
// WHY this exists: the pipeline pauses at every seal+countersign gate waiting for "yes".
// Without push, the operator has to poll the terminal. With this, he gets a Telegram message
// the moment a story is parked at a gate, can read the context from his phone, and
// either come back to the desk or send "yes" via the conversation.
//
// WHY opt-in: pings while the operator is at the computer are noise. The pipeline pings
// only when the operator has explicitly enabled ping mode by stepping away. State lives
// in ~/.robotdojo-notify-enabled — presence = on, absence = silent. Default OFF.
//
// WHY fire-and-forget: a notification failure must NEVER block a pipeline gate.
// If Telegram is down, keychain is locked, or the network is out, the gate still
// proceeds — the local "Say yes to approve" prompt is always authoritative.
//
// Usage (send):   node scripts/notify.js "Story st_X is parked at scope. Run: yes"
// Usage (toggle): node scripts/notify.js on       — enable pings (operator stepping away)
//                 node scripts/notify.js off      — silence pings (operator at the computer)
//                 node scripts/notify.js status   — print current state
// Usage (import): import { notify } from './notify.js'; await notify('text');
//
// Keychain entries required:
//   robotdojo-TELEGRAM_BOT_TOKEN  — bot auth
//   robotdojo-TELEGRAM_CHAT_ID    — destination chat
//
// Returns: Promise<{ok:boolean, reason?:string}>. Caller should ignore the return value.

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TELEGRAM_API = 'https://api.telegram.org';
const TIMEOUT_MS = 3000; // a Telegram outage must not stall the gate
const FLAG_FILE = join(homedir(), '.robotdojo-notify-enabled');

function tryKeychain(service) {
  try {
    const r = spawnSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
    });
    if (r.status !== 0) return null;
    return (r.stdout || '').trim() || null;
  } catch {
    return null;
  }
}

// Public: is ping mode currently enabled?
// Operator toggles via `notify.js on|off`. Default is off (silent).
export function isEnabled() {
  return existsSync(FLAG_FILE);
}

export async function notify(text) {
  if (!text || typeof text !== 'string') {
    return { ok: false, reason: 'no text' };
  }

  // Opt-in gate: silent no-op if the operator hasn't enabled ping mode.
  if (!isEnabled()) {
    return { ok: false, reason: 'ping mode disabled' };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN || tryKeychain('robotdojo-TELEGRAM_BOT_TOKEN');
  const chatId = process.env.TELEGRAM_CHAT_ID || tryKeychain('robotdojo-TELEGRAM_CHAT_ID');

  if (!token || !chatId) {
    // No telegram credentials → silent no-op. This is by design — see comment block above.
    return { ok: false, reason: 'no telegram credentials' };
  }

  // Cap message length — Telegram limits sendMessage to ~4096 chars.
  const body = text.length > 3900 ? text.slice(0, 3897) + '...' : text;

  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: chatId, text: body }).toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    return { ok: true };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

// CLI subcommands for toggling ping mode + sending messages.
// Always exits 0 so callers using `&& notify.js` never break the pipeline.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = process.argv[2] || '';
  if (arg === 'on') {
    writeFileSync(FLAG_FILE, new Date().toISOString() + '\n');
    process.stdout.write(`notify: ENABLED (flag at ${FLAG_FILE})\n`);
    process.exit(0);
  }
  if (arg === 'off') {
    try {
      unlinkSync(FLAG_FILE);
      process.stdout.write('notify: DISABLED\n');
    } catch {
      process.stdout.write('notify: already disabled\n');
    }
    process.exit(0);
  }
  if (arg === 'status') {
    if (isEnabled()) {
      const mtime = statSync(FLAG_FILE).mtime.toISOString();
      process.stdout.write(`notify: ENABLED since ${mtime}\n`);
    } else {
      process.stdout.write('notify: DISABLED (default)\n');
    }
    process.exit(0);
  }
  // Otherwise treat all CLI args as a message and try to send.
  const text = process.argv.slice(2).join(' ');
  notify(text).then((r) => {
    if (!r.ok) process.stderr.write(`notify: ${r.reason}\n`);
    process.exit(0);
  });
}
