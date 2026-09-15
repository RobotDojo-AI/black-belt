/**
 * Dated Monarch week files. Replace-by-id. current is a JSON pointer, not a symlink.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_FILES_DIR } from './robotdojo-paths.js';

const _REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadTunables() {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(join(_REPO_ROOT, 'config', 'defaults.json'), 'utf8')).monarch || {};
  } catch { /* fall through */ }
  const envNum = (name, fallback) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    txnCountDropRatio: envNum('MONARCH_TXN_COUNT_DROP_RATIO', raw.txnCountDropRatio ?? 0.8),
    totalsJumpRatio: envNum('MONARCH_TOTALS_JUMP_RATIO', raw.totalsJumpRatio ?? 0.2),
  };
}

export function monarchStoreRoot(root) {
  return root || join(USER_FILES_DIR, 'family', 'finances', 'monarch');
}

export function weekDir(root, week) {
  return join(monarchStoreRoot(root), 'weeks', week);
}

export function currentPointerPath(root) {
  return join(monarchStoreRoot(root), 'current');
}

export function snapshotIndexPath(root) {
  return join(monarchStoreRoot(root), 'snapshots.json');
}

export function monthClosesPath(root) {
  return join(monarchStoreRoot(root), 'month-closes.json');
}

export function monthViewsDir(root) {
  return join(monarchStoreRoot(root), 'views');
}

export function accountSeriesPath(root) {
  return join(monarchStoreRoot(root), 'account-series.json');
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readCurrentPointer(root) {
  const raw = readJson(currentPointerPath(root));
  if (!raw?.week) return null;
  return raw;
}

export function writeCurrentPointer(root, week) {
  writeJson(currentPointerPath(root), { week });
  return { week };
}

export function readWeek(root, week) {
  const dir = weekDir(root, week);
  if (!existsSync(dir)) return null;
  return {
    week,
    accounts: readJson(join(dir, 'accounts.json')) || [],
    transactions: readJson(join(dir, 'transactions.json')) || [],
    positions: readJson(join(dir, 'positions.json')) || [],
    manifest: readJson(join(dir, 'manifest.json')) || null,
  };
}

export function readLastGood(root) {
  const pointer = readCurrentPointer(root);
  if (!pointer?.week) return null;
  return readWeek(root, pointer.week);
}

export function listWeekIds(root) {
  const dir = join(monarchStoreRoot(root), 'weeks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function positionTicker(pos) {
  return pos.security?.ticker || pos.holdings?.[0]?.ticker || null;
}

function positionName(pos) {
  return pos.security?.name || pos.holdings?.[0]?.name || pos.id;
}

export function buildPortfolioSnapshot({
  week,
  pulledAt,
  accounts = [],
  positions = [],
  manifest = null,
} = {}) {
  const reportablePos = positions.filter((p) => !p.hidden);
  return {
    week,
    pulledAt: pulledAt || manifest?.pulledAt || null,
    status: manifest?.status || 'good',
    reportableNetWorth: manifest?.reportableNetWorth ?? reportableNetWorth(accounts),
    positionCount: reportablePos.length,
    txnCount: manifest?.txnCount ?? null,
    positions: reportablePos.map((p) => ({
      ticker: positionTicker(p),
      name: positionName(p),
      quantity: p.quantity,
      totalValue: p.totalValue,
      basis: p.basis,
      accountId: p.accountId || null,
      accountName: p.accountName || null,
    })),
    accounts: (accounts || [])
      .filter((a) => a.includeInNetWorth !== false && !a.isHidden)
      .map((a) => ({
        id: a.id,
        displayName: a.displayName,
        type: a.type,
        balance: signedAccountBalance(a),
      })),
  };
}

function snapshotIndexRow(snapshot) {
  return {
    week: snapshot.week,
    pulledAt: snapshot.pulledAt,
    status: snapshot.status,
    reportableNetWorth: snapshot.reportableNetWorth,
    positionCount: snapshot.positionCount,
    txnCount: snapshot.txnCount,
  };
}

export function writePortfolioSnapshot(root, snapshot) {
  const dir = weekDir(root, snapshot.week);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'snapshot.json'), snapshot);
  return join(dir, 'snapshot.json');
}

export function rebuildSnapshotIndex(root) {
  const weeks = listWeekIds(root);
  const rows = [];
  for (const week of weeks) {
    const snapPath = join(weekDir(root, week), 'snapshot.json');
    let snapshot = readJson(snapPath);
    if (!snapshot) {
      const full = readWeek(root, week);
      if (!full) continue;
      snapshot = buildPortfolioSnapshot({
        week,
        pulledAt: full.manifest?.pulledAt,
        accounts: full.accounts,
        positions: full.positions,
        manifest: full.manifest,
      });
      writePortfolioSnapshot(root, snapshot);
    }
    rows.push(snapshotIndexRow(snapshot));
  }
  writeJson(snapshotIndexPath(root), rows);
  return rows;
}

export function listSnapshotIndex(root) {
  const existing = readJson(snapshotIndexPath(root));
  if (Array.isArray(existing) && existing.length) return existing;
  return rebuildSnapshotIndex(root);
}

export function writeMonthCloses(root, monthCloses = []) {
  writeJson(monthClosesPath(root), monthCloses);
  return monthCloses;
}

export function readMonthCloses(root) {
  const rows = readJson(monthClosesPath(root));
  return Array.isArray(rows) ? rows : [];
}

export function writeAccountSeries(root, series) {
  writeJson(accountSeriesPath(root), series);
  return series;
}

export function readAccountSeries(root) {
  const raw = readJson(accountSeriesPath(root));
  if (Array.isArray(raw?.accounts)) return raw;
  if (Array.isArray(raw)) return { accounts: raw };
  return { accounts: [] };
}

export function writeMonthView(root, view) {
  const month = view?.month || (view?.asOf || '').slice(0, 7);
  if (!month) throw new Error('writeMonthView: month or asOf required');
  const dir = monthViewsDir(root);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, `${month}.json`), view);
  writeJson(join(dir, 'current.json'), view);
  return join(dir, `${month}.json`);
}

export function reportableTxnSum(transactions = []) {
  return transactions
    .filter((t) => !t.hideFromReports)
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);
}

const LIABILITY_ACCOUNT_TYPES = new Set(['loan', 'credit', 'other_liability']);

export function signedAccountBalance(account) {
  const raw = Number(account?.displayBalance ?? account?.currentBalance ?? 0);
  if (!Number.isFinite(raw)) return 0;
  if (LIABILITY_ACCOUNT_TYPES.has(String(account?.type || ''))) return -Math.abs(raw);
  return raw;
}

export function reportableNetWorth(accounts = []) {
  return accounts
    .filter((a) => a.includeInNetWorth !== false && !a.isHidden)
    .reduce((sum, a) => sum + signedAccountBalance(a), 0);
}

export function buildManifest({
  week,
  pulledAt,
  accounts = [],
  transactions = [],
  positions = [],
  totalCount = null,
  status = 'good',
  reason = null,
} = {}) {
  const accountIds = [...new Set(accounts.map((a) => a.id).filter(Boolean))].sort();
  return {
    week,
    pulledAt: pulledAt || new Date().toISOString(),
    status,
    reason,
    txnCount: transactions.length,
    hiddenTxnCount: transactions.filter((t) => t.hideFromReports).length,
    pendingTxnCount: transactions.filter((t) => t.pending).length,
    positionCount: positions.length,
    hiddenPositionCount: positions.filter((p) => p.hidden).length,
    accountIds,
    reportableTxnSum: reportableTxnSum(transactions),
    reportableNetWorth: reportableNetWorth(accounts),
    totalCount: totalCount == null ? transactions.length : totalCount,
  };
}

export function evaluateSanity(next, lastGood, { tunables } = {}) {
  const cfg = tunables || loadTunables();
  const txnCount = Number(next.txnCount || 0);
  const totalCount = next.totalCount;
  if (totalCount != null && Number(totalCount) !== txnCount) {
    return { promote: false, reason: 'incomplete_page' };
  }
  if (txnCount === 0) return { promote: false, reason: 'empty' };
  if (!lastGood) return { promote: true, reason: null };

  const lastCount = Number(lastGood.txnCount || 0);
  if (lastCount > 0 && txnCount <= cfg.txnCountDropRatio * lastCount) {
    return { promote: false, reason: 'txn_count_drop' };
  }

  const prevIds = [...(lastGood.accountIds || [])].sort();
  const nextIds = [...(next.accountIds || [])].sort();
  const sameAccounts = prevIds.length === nextIds.length && prevIds.every((id, i) => id === nextIds[i]);
  if (sameAccounts) {
    const lastNw = Number(lastGood.reportableNetWorth || 0);
    const nextNw = Number(next.reportableNetWorth || 0);
    const lastSum = Number(lastGood.reportableTxnSum || 0);
    const nextSum = Number(next.reportableTxnSum || 0);
    const nwJump = Math.abs(lastNw) > 0 && Math.abs(nextNw - lastNw) >= cfg.totalsJumpRatio * Math.abs(lastNw);
    const sumJump = Math.abs(lastSum) > 0 && Math.abs(nextSum - lastSum) >= cfg.totalsJumpRatio * Math.abs(lastSum);
    if (nwJump || sumJump) return { promote: false, reason: 'totals_jump' };
  }
  return { promote: true, reason: null };
}

function writeSnapshot(dir, { accounts, transactions, positions, manifest }) {
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'accounts.json'), accounts);
  writeJson(join(dir, 'transactions.json'), transactions);
  writeJson(join(dir, 'positions.json'), positions);
  writeJson(join(dir, 'manifest.json'), manifest);
}

export function writeWeek(root, snapshot) {
  const dir = weekDir(root, snapshot.week);
  writeSnapshot(dir, snapshot);
  return dir;
}

export function writeSuspect(root, snapshot, { now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = join(monarchStoreRoot(root), 'suspect', stamp);
  writeSnapshot(dir, snapshot);
  return dir;
}

/**
 * Persist a pulled book. Promote replaces the week's files and moves `current`.
 * Suspect writes a stamped folder and leaves `current` alone.
 */
export function persistMonarchPull({
  root,
  week,
  accounts,
  transactions,
  positions,
  totalCount,
  pulledAt,
  now = new Date(),
} = {}) {
  const lastGood = readLastGood(root);
  const draft = buildManifest({
    week,
    pulledAt,
    accounts,
    transactions,
    positions,
    totalCount,
  });
  const gate = evaluateSanity(draft, lastGood?.manifest, {});
  const manifest = { ...draft, status: gate.promote ? 'good' : 'suspect', reason: gate.reason };
  const snapshot = { week, accounts, transactions, positions, manifest };

  if (!gate.promote) {
    const dir = writeSuspect(root, snapshot, { now });
    return { promoted: false, reason: gate.reason, dir, current: lastGood?.week || null, manifest };
  }

  writeWeek(root, snapshot);
  writePortfolioSnapshot(root, buildPortfolioSnapshot({
    week,
    pulledAt: manifest.pulledAt,
    accounts,
    positions,
    manifest,
  }));
  const history = rebuildSnapshotIndex(root);
  writeCurrentPointer(root, week);
  return { promoted: true, reason: null, dir: weekDir(root, week), current: week, manifest, history };
}
