#!/usr/bin/env node
/**
 * backfill-email-history.js — resumable FULL-history email backfill (st_f1a40461).
 *
 * THE BUG THIS FIXES: gmail-sync.js fetches only the newest `maxFetchMessages`
 * bodies on first sync (orchestrator passes 1000), and incremental syncs only
 * pull `after:` a recent date. So the sync only ever moves FORWARD — pre-onboarding
 * history is never reached, even when the mailbox spans many more years.
 *
 * THE FIX: walk BACKWARD. Each pass syncs `before:<current oldest synced email>`
 * with a chunk cap, which advances the floor older every pass, until a pass adds
 * nothing new (mailbox floor reached). Idempotent (INSERT OR IGNORE) and resumable
 * — a killed run just continues from the current oldest next time.
 *
 * Usage:
 *   node scripts/backfill-email-history.js                 # all google email accounts
 *   node scripts/backfill-email-history.js <email>         # one account
 *   CHUNK=5000 node scripts/backfill-email-history.js ...  # tune pass size
 *
 * st_27561b77 P7 — programmatic single-pass entry point:
 *   import { runBackfillPass } from 'scripts/backfill-email-history.js';
 *   await runBackfillPass({ email, chunk });
 *
 * That entry point is the passive-job handler shape — one chunk pass per
 * job invocation, cursor is the existing oldest-email-in-DB watermark, so
 * a killed run resumes naturally without explicit cursor persistence.
 *
 * Module-scope `import db` is intentionally absent: the previous module
 * opened the DB at import time, before any idle / writer-guard check
 * could pause execution. AC7 requires lazy DB open inside the handler so
 * the supervisor's idle gate can no-op a tick without paying the open cost.
 */

// st_27561b77 P7 — direct-db-writers.json classifies this as
// guarded-launch-agent / passive. The supervisor invokes runBackfillPass
// through the passive-job handler (it holds its own external-db-writer
// lock); the CLI path below still works for manual debugging and is
// wrapped in withLaunchDbWriterGuard so manual launches respect the same
// external-db-writer lock + idle gate the supervisor enforces.
//
// WHY guard only the CLI path: importing this module from the supervisor
// must NOT acquire the lock (the supervisor already owns it). The named
// `runBackfillPass` export stays lock-free; only the `_isMain` CLI branch
// at the bottom enters the guard. Lazy db imports inside runBackfillPass
// (and main) keep this module guard-safe at import time per the
// check-launch-state-ownership pre-guard import rule.
import { withLaunchDbWriterGuard } from '../lib/db-writer-policy.js';

export const IDLE_GATED = true;

const CHUNK_DEFAULT = Number(process.env.CHUNK) || 3000;
const MAX_RETRIES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * st_27561b77 P7 — single-pass backfill for one account.
 *
 * Lazy-imports db.js and gmail-sync.js so importing this module from the
 * supervisor does NOT open the encrypted DB at import time.
 *
 * Returns { ok, email, before, synced, skipped, errors, oldestBefore,
 *           oldestAfter, floorReached } so the supervisor handler can
 * record progress and the next supervisor tick re-enqueues until
 * floorReached is true.
 *
 * Idempotent: if a previous pass partially completed (server killed
 * mid-syncGmailAccount), the same window re-runs — INSERT OR IGNORE in
 * gmail-sync.js dedupes by content hash.
 */
export async function runBackfillPass({ email, chunk = CHUNK_DEFAULT } = {}) {
  if (!email) throw new Error('runBackfillPass: email required');
  const { default: db } = await import('../lib/db.js');
  const { syncGmailAccount } = await import('../lib/gmail-sync.js');

  const oldestStmt = db.prepare(
    `SELECT MIN(e.received_at) m FROM emails e JOIN accounts a ON a.id = e.account_id
     WHERE a.email = ? AND e.received_at > '1990'`,
  );
  const oldestBefore = oldestStmt.get(email)?.m || '';
  const before = oldestBefore ? new Date(oldestBefore) : new Date();
  let result;
  try {
    result = await syncGmailAccount(email, { before, maxMessages: chunk });
  } catch (err) {
    return {
      ok: false,
      email,
      before: before.toISOString(),
      synced: 0,
      skipped: 0,
      errors: 1,
      error: err.message,
      oldestBefore,
      oldestAfter: oldestBefore,
      floorReached: false,
    };
  }
  const synced = result?.synced || 0;
  const oldestAfter = oldestStmt.get(email)?.m || '';
  const floorReached = synced === 0 && oldestAfter === oldestBefore && !result?.error;
  return {
    ok: !result?.error,
    email,
    before: before.toISOString(),
    synced,
    skipped: result?.skipped || 0,
    errors: result?.errors || 0,
    error: result?.error || null,
    oldestBefore,
    oldestAfter,
    floorReached,
  };
}

/**
 * Loop-pass backfill: runs runBackfillPass repeatedly until the floor is
 * reached or MAX_RETRIES consecutive failures. Used by the CLI for
 * manual invocations; the supervisor uses runBackfillPass directly,
 * one pass per drain tick.
 */
async function backfillAccount(email, chunk = CHUNK_DEFAULT) {
  let pass = 0;
  let retries = 0;
  let prevOldest = null;
  for (;;) {
    pass++;
    const r = await runBackfillPass({ email, chunk });
    // eslint-disable-next-line no-console
    console.log(`[backfill] ${email} pass ${pass}: before=${r.before.slice(0, 10)} synced=${r.synced} skipped=${r.skipped} errors=${r.errors} now-oldest=${r.oldestAfter.slice(0, 10)}${r.error ? ' err=' + r.error.slice(0, 60) : ''}`);
    const failed = !r.ok || (r.errors > 0 && r.synced === 0);
    if (failed) {
      retries++;
      if (retries > MAX_RETRIES) {
        // eslint-disable-next-line no-console
        console.log(`[backfill] ${email}: giving up after ${MAX_RETRIES} retries at ${r.before.slice(0, 10)} (NOT a floor — resume later).`);
        break;
      }
      const backoff = 5000 * retries;
      // eslint-disable-next-line no-console
      console.log(`[backfill] ${email}: pass failed — retry ${retries}/${MAX_RETRIES} after ${backoff / 1000}s`);
      await sleep(backoff);
      continue;
    }
    retries = 0;
    if (r.synced === 0 && r.oldestAfter === prevOldest) {
      // eslint-disable-next-line no-console
      console.log(`[backfill] ${email}: mailbox floor reached at ${r.oldestAfter.slice(0, 10)} — full history backfilled.`);
      break;
    }
    prevOldest = r.oldestAfter;
  }
}

/**
 * CLI entry point. Lazy-imports db.js so importing this module as ESM
 * does not eagerly open the encrypted DB.
 */
async function main(argvEmail) {
  const { default: db } = await import('../lib/db.js');
  const accounts = db
    .prepare(`SELECT email FROM accounts WHERE vendor = 'google' AND type = 'email'`)
    .all()
    .map((r) => r.email);
  const targets = argvEmail ? [argvEmail] : accounts;
  // eslint-disable-next-line no-console
  console.log(`[backfill] accounts: ${targets.join(', ')} | CHUNK=${CHUNK_DEFAULT}`);
  for (const email of targets) {
    // eslint-disable-next-line no-console
    console.log(`\n[backfill] === ${email} ===`);
    await backfillAccount(email, CHUNK_DEFAULT);
  }
  // eslint-disable-next-line no-console
  console.log('\n[backfill] all done.');
}

// Only run main() when invoked directly via `node scripts/backfill-email-history.js`.
// Importing the module from the supervisor must NOT trigger the loop pass.
const _isMain = (() => {
  try {
    const url = new URL(import.meta.url);
    const argv1 = process.argv[1] || '';
    return url.pathname === argv1 || url.pathname.endsWith(argv1);
  } catch { return false; }
})();
if (_isMain) {
  withLaunchDbWriterGuard('backfill-email-history', () => main(process.argv[2]))
    .then((result) => {
      if (result?.skipped) process.exit(0);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[backfill] fatal:', err.message);
      process.exit(1);
    });
}
