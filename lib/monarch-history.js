/**
 * Month-close portfolio values from Monarch daily snapshots.
 * Account totals are SoT. Fill lots overlay RH/Coinbase in rebuild-month-views.
 */
import {
  fetchAccountSnapshots,
  fetchAggregateSnapshots,
  fetchSnapshotsByAccountType,
} from './monarch-client.js';
import { closeForTicker } from './monarch-prices.js';
import { writeAccountSeries, writeMonthCloses } from './monarch-store.js';
import { bookAccounts } from './monarch-month-book.js';

export const MONTH_CLOSE_START = '2024-01-01';

export function monthKey(date) {
  return String(date || '').slice(0, 7);
}

export function lastDayOfMonth(month) {
  const [year, mon] = String(month).split('-').map(Number);
  if (!year || !mon) return null;
  return new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
}

export function collapseDailyToMonthEnds(rows = []) {
  const byMonth = new Map();
  const sorted = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const row of sorted) {
    const month = monthKey(row.date);
    if (!month) continue;
    byMonth.set(month, {
      month,
      asOf: row.date,
      balance: Number(row.balance ?? row.signedBalance),
    });
  }
  return [...byMonth.values()];
}

export function groupTypeSnapshotsByMonth(rows = []) {
  const byMonth = new Map();
  for (const row of rows) {
    const month = monthKey(row.month) || String(row.month || '');
    if (!month) continue;
    if (!byMonth.has(month)) byMonth.set(month, {});
    byMonth.get(month)[row.accountType] = Number(row.balance);
  }
  return byMonth;
}

export function markPositionsAtClose(positions = [], { asOf, priceBook } = {}) {
  const rows = [];
  for (const pos of positions) {
    if (pos.hidden) continue;
    const ticker = pos.security?.ticker || pos.holdings?.[0]?.ticker || pos.ticker || null;
    const name = pos.security?.name || pos.holdings?.[0]?.name || pos.name || pos.id;
    const quantity = Number(pos.quantity);
    let price = null;
    if (priceBook && ticker && asOf) price = closeForTicker(priceBook, ticker, asOf);
    if (price == null) {
      const closingPrice = Number(pos.security?.closingPrice ?? pos.closingPrice);
      const currentPrice = Number(pos.security?.currentPrice);
      price = Number.isFinite(closingPrice) && closingPrice > 0
        ? closingPrice
        : (Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : null);
    }
    if (!Number.isFinite(quantity) || price == null) continue;
    rows.push({
      ticker,
      name,
      quantity,
      closingPrice: price,
      markedValue: quantity * price,
      accountId: pos.accountId || null,
      accountName: pos.accountName || null,
      quantitySource: 'current_lots',
    });
  }
  return rows;
}

export function positionsFitAccount(positions = [], accountBalance) {
  const sum = positions.reduce((s, p) => s + Number(p.markedValue || 0), 0);
  const bal = Number(accountBalance);
  if (!Number.isFinite(bal) || Math.abs(bal) < 1) return null;
  return Math.abs(sum - bal) / Math.abs(bal) <= 0.2;
}

export function buildMonthCloses({
  dailyNetWorth = [],
  byTypeRows = [],
  accountSeries = [],
  positionsByMonth = {},
  pulledAt,
} = {}) {
  const nwMonths = collapseDailyToMonthEnds(dailyNetWorth);
  const typeByMonth = groupTypeSnapshotsByMonth(byTypeRows);
  const months = new Set([
    ...nwMonths.map((r) => r.month),
    ...typeByMonth.keys(),
    ...accountSeries.flatMap((s) => collapseDailyToMonthEnds(s.rows).map((r) => r.month)),
  ]);
  const nwByMonth = new Map(nwMonths.map((r) => [r.month, r]));
  const accountMonth = accountSeries.map((s) => ({
    id: s.id,
    displayName: s.displayName,
    type: s.type,
    byMonth: new Map(collapseDailyToMonthEnds(s.rows).map((r) => [r.month, r])),
  }));

  return [...months].sort().map((month) => {
    const nw = nwByMonth.get(month);
    const accounts = [];
    for (const series of accountMonth) {
      const point = series.byMonth.get(month);
      if (!point) continue;
      accounts.push({
        id: series.id,
        displayName: series.displayName,
        type: series.type,
        subtype: series.subtype || null,
        isHidden: !!series.isHidden,
        balance: point.balance,
      });
    }
    const positions = Array.isArray(positionsByMonth[month]) ? positionsByMonth[month] : [];
    const accountIds = new Set(accounts.map((a) => a.id));
    let fit = null;
    if (positions.length) {
      fit = positions.every((p) => !p.accountId || accountIds.has(p.accountId));
      if (fit) {
        fit = accounts.every((acct) => {
          const slice = positions.filter((p) => p.accountId === acct.id || p.accountName === acct.displayName);
          return positionsFitAccount(slice, acct.balance) !== false;
        });
      }
    }
    return {
      month,
      asOf: nw?.asOf || lastDayOfMonth(month),
      reportableNetWorth: nw?.balance ?? null,
      byType: typeByMonth.get(month) || {},
      accounts,
      positions,
      positionsFitAccount: fit,
      pulledAt: pulledAt || null,
    };
  });
}

export async function refreshMonarchMonthCloses({
  session,
  root,
  accounts = [],
  fetchImpl = fetch,
  now = new Date(),
  startDate = MONTH_CLOSE_START,
} = {}) {
  const endDate = now.toISOString().slice(0, 10);
  const book = bookAccounts(accounts);
  const [dailyNetWorth, byTypeRows, accountSeries] = await Promise.all([
    fetchAggregateSnapshots({ session, startDate, endDate, fetchImpl, now }),
    fetchSnapshotsByAccountType({ session, startDate, timeframe: 'month', fetchImpl }),
    Promise.all(
      book.map(async (acct) => ({
        id: acct.id,
        displayName: acct.displayName,
        type: acct.type,
        subtype: acct.subtype,
        isHidden: !!acct.isHidden,
        rows: (await fetchAccountSnapshots({ session, accountId: acct.id, fetchImpl }))
          .map((row) => ({ date: row.date, signedBalance: row.signedBalance })),
      })),
    ),
  ]);
  const pulledAt = now.toISOString();
  writeAccountSeries(root, {
    pulledAt,
    accounts: accountSeries.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      type: s.type,
      subtype: s.subtype,
      isHidden: !!s.isHidden,
      months: Object.fromEntries(
        collapseDailyToMonthEnds(s.rows).map((r) => [r.month, { asOf: r.asOf, balance: r.balance }]),
      ),
    })),
  });
  const monthCloses = buildMonthCloses({
    dailyNetWorth,
    byTypeRows,
    accountSeries,
    pulledAt,
  });
  writeMonthCloses(root, monthCloses);
  return monthCloses;
}
