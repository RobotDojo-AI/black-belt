#!/usr/bin/env node
/**
 * scripts/spend-watchdog.js — tells the owner before the invoice does.
 *
 * st_4312c9c0. The guard refuses calls at the ceiling and the report attributes
 * spend after the fact, but both are passive: one is silent until it fires, the
 * other has to be remembered. A control the owner has to remember to check is
 * not a control. This closes the loop — it notices a burn rate and says so while
 * there is still a day left to act.
 *
 * Fires a macOS notification (the same best-effort osascript pattern
 * login-probe.js and relay-watchdog.js use) when:
 *   - any ceiling crosses warn_at_pct, or
 *   - a ceiling has actually been hit and calls are being refused, or
 *   - the ledger was unreadable and calls ran uncapped.
 *
 * DEDUPED by state, not by time: the same condition alerts once, and only
 * re-alerts if it worsens a band or clears and returns. An alert that repeats
 * every 15 minutes gets muted, and a muted alarm is the same as no alarm.
 *
 * Exit 0 always — this observes, it never gates. Its own failure must not become
 * a second problem on top of the one it is watching for.
 */

// INTELLIGENCE_TIER: extraction — reads the spend ledgers and notifies.
// Makes no model call.
export const INTELLIGENCE_TIER = 'extraction';

export const IDLE_GATED = false;

process.env.ROBOTDOJO_SUPPRESS_DB_BOOT_NOTICES = '1';

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const STATE_PATH = process.env.ROBOTDOJO_SPEND_WATCHDOG_STATE
  || join(homedir(), '.robotdojo', 'state', 'spend-watchdog.json');

const DRY_RUN = process.argv.includes('--dry-run');

function readState() {
  try {
    return existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  } catch { /* best-effort: losing state means one duplicate alert, not a failure */ }
}

function notify(title, msg) {
  if (DRY_RUN) {
    process.stdout.write(`[dry-run] would notify: ${title} — ${msg}\n`);
    return;
  }
  try {
    const t = String(title).replace(/"/g, '\\"');
    const m = String(msg).replace(/"/g, '\\"');
    execSync(`osascript -e 'display notification "${m}" with title "${t}"'`, { timeout: 5000, stdio: 'ignore' });
  } catch {
    // Screen locked or Focus mode. Still print, so a terminal or log catches it.
    process.stdout.write(`[spend-watchdog] ${title}: ${msg}\n`);
  }
}

/** Coarse bands, so an alert fires on a real change rather than on every percent. */
export function band(pct) {
  if (pct == null) return 'none';
  if (pct >= 100) return 'over';
  if (pct >= 90) return 'critical';
  if (pct >= 75) return 'warn';
  return 'ok';
}

const SEVERITY = { none: 0, ok: 0, warn: 1, critical: 2, over: 3 };

async function main() {
  const { status } = await import('../lib/spend-guard.js');
  const s = status();
  const prev = readState();
  const next = { checked_at: new Date().toISOString() };
  let alerted = false;

  if (!s.readable) {
    next.ledger = 'unreadable';
    if (prev.ledger !== 'unreadable') {
      notify('Robot Dojo spend', `Ledger unreadable (${s.error}) — calls are running UNCAPPED.`);
      alerted = true;
    }
    writeState(next);
    return;
  }
  next.ledger = 'ok';

  if (s.bypasses > (prev.bypasses || 0)) {
    notify('Robot Dojo spend', `${s.bypasses} call(s) ran uncapped while the ledger was unreadable.`);
    alerted = true;
  }
  next.bypasses = s.bypasses;

  const checks = [
    ['today pipeline', s.today.pipeline],
    ['today total', s.today.total],
    ['month total', s.month.total],
  ];

  next.bands = {};
  for (const [name, o] of checks) {
    const b = band(o.pct);
    next.bands[name] = b;
    const was = prev.bands?.[name] || 'ok';
    // Only alert when the band WORSENS. Recovering, or holding steady inside a
    // band, is not news — and an alarm that repeats is an alarm that gets muted.
    if (SEVERITY[b] > SEVERITY[was]) {
      const msg = b === 'over'
        ? `${name} spend $${o.spent.toFixed(2)} has HIT the $${o.limit.toFixed(2)} ceiling — calls are being refused.`
        : `${name} spend $${o.spent.toFixed(2)} is ${o.pct.toFixed(0)}% of the $${o.limit.toFixed(2)} ceiling.`;
      notify('Robot Dojo spend', msg);
      alerted = true;
    }
  }

  writeState(next);
  if (!alerted) {
    process.stdout.write(`spend-watchdog: ok — today $${s.today.total.spent.toFixed(4)} / $${s.today.total.limit.toFixed(2)}\n`);
  }
}

main().catch((err) => {
  process.stdout.write(`spend-watchdog: ${err.message}\n`);
  process.exit(0); // never gate on the watchdog's own failure
});
