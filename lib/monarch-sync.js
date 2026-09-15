/**
 * Weekly Monarch pull: session → book → sanity → promote or suspect → compact.
 * Cadence is Saturday 08:00 America/New_York (lib/monarch-schedule.js).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { pullMonarchBook } from './monarch-client.js';
import { resolveMonarchSession } from './monarch-auth.js';
import { persistMonarchPull, monarchStoreRoot, listSnapshotIndex, readMonthCloses } from './monarch-store.js';
import { compactMonarchWeek } from './monarch-compact.js';
import { refreshMonarchMonthCloses } from './monarch-history.js';
import { rebuildOwnerMonthViews } from './monarch-month-views.js';
import { monarchSyncConfig as scheduleConfig, monarchSyncRunAfter as scheduleRunAfter } from './monarch-schedule.js';

const _REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadTunables() {
  let raw = {};
  try {
    if (existsSync(join(_REPO_ROOT, 'config', 'defaults.json'))) {
      raw = JSON.parse(readFileSync(join(_REPO_ROOT, 'config', 'defaults.json'), 'utf8')).monarch || {};
    }
  } catch { /* fall through */ }
  const envInt = (name, fallback) => {
    const n = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    timeoutMs: envInt('MONARCH_TIMEOUT_MS', raw.timeoutMs ?? 600_000),
    failureBackoffMs: envInt('MONARCH_FAILURE_BACKOFF_MS', raw.failureBackoffMs ?? 24 * 60 * 60 * 1000),
    watchdogPadMs: envInt('MONARCH_WATCHDOG_PAD_MS', raw.watchdogPadMs ?? 15_000),
    ...scheduleConfig(),
  };
}

export function monarchSyncConfig() {
  return loadTunables();
}

export function monarchSyncRunAfter(args) {
  return scheduleRunAfter(args);
}

function promoteWeek(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function upsertMonarchAccount(database, syncedAt) {
  if (!database) return;
  try {
    database.prepare(`
      INSERT INTO accounts (id, provider, vendor, type, display_name, status, synced_at, updated_at)
      VALUES ('monarch:finances', 'monarch', 'monarch', 'finances', 'Monarch', 'active', ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        status = 'active',
        vendor = 'monarch',
        type = 'finances',
        synced_at = excluded.synced_at,
        updated_at = datetime('now')
    `).run(syncedAt);
  } catch {
    // Minimal test DBs may omit accounts; the week files still land.
  }
}

async function pullOnce({ session, fetchImpl, now }) {
  try {
    const book = await pullMonarchBook({ session, fetchImpl, now });
    return { ok: true, book };
  } catch (err) {
    return { ok: false, err };
  }
}

export async function afterPromoteFinanceReview(args = {}) {
  try {
    const { runFinanceWeeklyReview } = await import('./finance-weekly-review.js');
    return await runFinanceWeeklyReview(args);
  } catch (err) {
    console.error(`[finance-weekly-review] ${err.message}`);
    return { asanaGid: null, error: err.message };
  }
}

export async function syncMonarch({
  database = db,
  root,
  fetchImpl = fetch,
  keychain,
  op,
  now = new Date(),
  applyContext,
  diskPath,
} = {}) {
  const storeRoot = monarchStoreRoot(root);
  let resolved;
  try {
    resolved = await resolveMonarchSession({ keychain, op, fetchImpl });
  } catch (err) {
    return {
      ok: false,
      promoted: false,
      reason: err.code || err.message,
      error: err.message,
    };
  }

  let pull = await pullOnce({ session: resolved.session, fetchImpl, now });
  if (!pull.ok && pull.err?.status === 401) {
    try {
      resolved = await resolveMonarchSession({ keychain, op, fetchImpl, forceLogin: true });
      pull = await pullOnce({ session: resolved.session, fetchImpl, now });
    } catch (err) {
      return { ok: false, promoted: false, reason: err.code || err.message, error: err.message };
    }
  }

  if (!pull.ok) {
    const reason = pull.err?.code === 'incomplete_page' ? 'incomplete_page' : (pull.err?.code || 'pull_failed');
    if (reason === 'incomplete_page') {
      const persisted = persistMonarchPull({
        root: storeRoot,
        week: promoteWeek(now),
        accounts: [],
        transactions: pull.err.collected ? [] : [],
        positions: [],
        totalCount: pull.err.totalCount ?? 1,
        pulledAt: now.toISOString(),
        now,
      });
      return { ok: true, promoted: false, reason: persisted.reason || reason, current: persisted.current };
    }
    return { ok: false, promoted: false, reason, error: pull.err?.message };
  }

  let monthCloses = [];
  try {
    monthCloses = await refreshMonarchMonthCloses({
      session: resolved.session,
      root: storeRoot,
      accounts: pull.book.accounts,
      fetchImpl,
      now,
    });
    try {
      await rebuildOwnerMonthViews({ root: storeRoot, now, fetchImpl });
    } catch { /* keep last views */ }
  } catch {
    monthCloses = readMonthCloses(storeRoot);
  }

  const week = promoteWeek(now);
  const persisted = persistMonarchPull({
    root: storeRoot,
    week,
    accounts: pull.book.accounts,
    transactions: pull.book.transactions,
    positions: pull.book.positions,
    totalCount: pull.book.totalCount,
    pulledAt: now.toISOString(),
    now,
  });

  if (!persisted.promoted) {
    return {
      ok: true,
      promoted: false,
      reason: persisted.reason,
      current: persisted.current,
      manifest: persisted.manifest,
    };
  }

  const { finishPromotedWeek } = await import('./finance-weekly-review.js');
  await finishPromotedWeek({
    compact: compactMonarchWeek,
    review: afterPromoteFinanceReview,
    compactArgs: {
      snapshot: {
        week,
        accounts: pull.book.accounts,
        transactions: pull.book.transactions,
        positions: pull.book.positions,
        manifest: persisted.manifest,
        history: listSnapshotIndex(storeRoot),
        monthCloses,
      },
      database,
      applyContext,
      diskPath,
    },
    reviewArgs: {
      week,
      positions: pull.book.positions,
      accounts: pull.book.accounts,
      now,
      fetchImpl,
      root: storeRoot,
    },
  });
  upsertMonarchAccount(database, persisted.manifest.pulledAt);
  return {
    ok: true,
    promoted: true,
    reason: null,
    current: week,
    manifest: persisted.manifest,
  };
}
