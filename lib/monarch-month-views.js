/**
 * Compose owner month-end views: Monarch account book + fill lots.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBrokerExportEvents, quantityByMonth } from './broker-lots.js';
import { lastDayOfMonth, monthKey } from './monarch-history.js';
import { accountsForMonth, bookTotal, buildMonthPositions } from './monarch-month-book.js';
import { loadPriceBook } from './monarch-prices.js';
import { buildOwnerView } from './portfolio-view.js';
import {
  monarchStoreRoot,
  readAccountSeries,
  readMonthCloses,
  writeMonthView,
} from './monarch-store.js';
import { USER_FILES_DIR } from './robotdojo-paths.js';

const EXPORTS = join(USER_FILES_DIR, 'family', 'finances', 'broker-exports');

function monthEnds(start, end) {
  const out = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    out.push(lastDayOfMonth(month));
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function mixTotal(view) {
  return Object.values(view?.mix?.dollars || {}).reduce((s, cols) => s + Number(cols.total || 0), 0);
}

export async function rebuildOwnerMonthViews({
  root,
  exportsDir = EXPORTS,
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  const events = loadBrokerExportEvents(exportsDir);
  const today = now.toISOString().slice(0, 10);
  const ends = monthEnds('2024-01', today.slice(0, 7)).map((d) => (d > today ? today : d));
  const snapshots = quantityByMonth(events, ends);
  const lotsByAsOf = new Map(snapshots.map((s) => [s.asOf, s.lots]));
  const tickers = [...new Set(events.map((e) => e.ticker).filter(Boolean))];
  const priceBook = await loadPriceBook(tickers, { startDate: '2024-01-01', endDate: today, fetchImpl });
  const existing = readMonthCloses(root);
  const byMonth = new Map(existing.map((r) => [r.month, r]));
  const series = readAccountSeries(root);
  const outSeries = [];

  for (const asOf of ends) {
    const month = monthKey(asOf);
    const prior = byMonth.get(month);
    const accounts = accountsForMonth(series, month);
    const lots = lotsByAsOf.get(asOf) || [];
    const positions = buildMonthPositions({ accounts, lots, asOf, priceBook });
    const view = buildOwnerView({ asOf, positions, checking: 0 });
    view.month = month;
    view.source = 'monarch_accounts+fills';
    writeMonthView(root, view);
    const book = bookTotal(accounts);
    const mix = mixTotal(view);
    outSeries.push({
      month,
      asOf,
      nLots: lots.length,
      mix: view.mix.dollars,
      mixPct: view.mix.pct,
      crypto: view.crypto.dollars,
      reserve: view.reserve.dollars,
      mixTotal: mix,
      monarchBook: book,
      gap: mix - book,
      monarchNw: prior?.reportableNetWorth ?? null,
      monarchBrokerage: prior?.byType?.brokerage ?? null,
    });
  }

  const outDir = join(monarchStoreRoot(root), 'views');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'series.json'), `${JSON.stringify(outSeries, null, 2)}\n`);
  return outSeries;
}
