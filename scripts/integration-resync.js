#!/usr/bin/env node
/**
 * scripts/integration-resync.js — st_1cfe9061
 *
 * Periodic full resync for every connected Google account.
 * Runs every 4 hours via LaunchAgent. Forces a full history drain
 * (FORCE_GOOGLE_FULL=1) for each active account, yielding to chat
 * between accounts via withChatYieldingWrite.
 *
 * Does NOT run if the MS history drain is incomplete (checks sync_state).
 */

export const INTELLIGENCE_TIER = 'orchestration';

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { withLaunchDbWriterGuard } from '../lib/db-writer-policy.js';
import { waitWhileChatAppActive } from '../lib/request-observer.js';

const HOME = process.env.HOME || homedir();
const ROOT = process.env.ROBOTDOJO_HOME || resolve(HOME, 'robotdojo');
const WORKER_NAME = 'integration-resync';

function log(msg) {
  console.log(`[${WORKER_NAME}] ${msg}`);
}

async function main() {
  log('start');

  await withLaunchDbWriterGuard(WORKER_NAME, async () => {
    // DB opened inside the guard — consistent with the pre-guard import contract.
    const { default: db } = await import(resolve(ROOT, 'lib/db.js'));
    const yieldToChat = () => waitWhileChatAppActive(db, {
      onPause: () => log('chat app open — pausing resync'),
      onResume: () => log('chat app closed — resuming resync'),
    });

    // Check MS history drain completeness: if unembedded MS email chunks remain,
    // skip this cycle to avoid double-write contention with the embed daemon.
    let drainComplete = true;
    try {
      const row = db.prepare(
        `SELECT COUNT(*) as n FROM email_chunks WHERE embedded=0 AND source_type='microsoft'`
      ).get();
      drainComplete = (row?.n ?? 0) === 0;
    } catch { /* table absent → new install, no drain needed */ }

    if (!drainComplete) {
      log('MS history drain not yet complete — skipping resync this cycle');
      return;
    }

    let accounts = [];
    try {
      accounts = db.prepare(
        `SELECT account_id, email FROM accounts WHERE provider='google' AND active=1`
      ).all();
    } catch { /* no accounts table yet */ }

    if (!accounts.length) {
      log('no active Google accounts — nothing to resync');
      return;
    }

    log(`resyncing ${accounts.length} account(s)`);

    for (const account of accounts) {
      const proceed = await yieldToChat();
      if (!proceed) {
        log(`aborted before account ${account.email} — chat active`);
        break;
      }
      log(`resyncing ${account.email}`);
      const result = spawnSync(process.execPath, [resolve(ROOT, 'scripts/sync.js')], {
        env: { ...process.env, FORCE_GOOGLE_FULL: '1', ROBOTDOJO_ACCOUNT_ID: String(account.account_id) },
        stdio: 'inherit',
        timeout: 60 * 60 * 1000, // 1 hour max per account
      });
      if (result.status !== 0) {
        log(`sync exited ${result.status} for ${account.email}`);
      } else {
        log(`done: ${account.email}`);
      }
    }
  });

  log('done');
  process.exit(0);
}

await main();
