/**
 * Owner month-end asset view.
 * Columns: personal / roth / trad / total.
 * Buckets: mix, equities, crypto, reserve.
 * Each bucket has dollars then % of that column.
 */
export const COLUMNS = Object.freeze(['personal', 'roth', 'trad', 'total']);

const GOLD = new Set(['PAXG', 'PHYS', 'IAU', 'GLD', 'GOLD']);
const SILVER = new Set(['PSLV', 'SIVR', 'SLV']);
const BTC_PROXY = new Set(['BTC', 'MSTR', 'BTC-USD']);
const CRYPTO_OTHER = new Set([
  'ETH', 'SOL', 'PUMP', 'WLD', 'DOGE', 'DRINK', 'JELLY', 'BEAR', 'BALAJIS',
  'ETH-USD', 'SOL-USD', 'PUMP-USD', 'WLD-USD', 'DOGE-USD',
]);

export function normalizeTicker(raw) {
  let t = String(raw || '').trim().toUpperCase();
  if (t === 'FILL') return 'POWR';
  t = t.replace(/-USD$/, '');
  if (t === 'CUR:USD') return 'USD';
  return t;
}

export function columnFromAccount(accountName) {
  const n = String(accountName || '').toLowerCase();
  if (n.includes('roth')) return 'roth';
  if (n.includes('traditional') || n.includes('401')) return 'trad';
  return 'personal';
}

export function classify(ticker) {
  const t = normalizeTicker(ticker);
  if (GOLD.has(t)) return { bucket: 'reserve', row: 'Gold' };
  if (SILVER.has(t)) return { bucket: 'reserve', row: 'PSLV' };
  if (t === 'USDC' || t === 'USD') return { bucket: 'reserve', row: 'USDC' };
  if (BTC_PROXY.has(t)) return { bucket: 'crypto', row: 'BTC + MSTR' };
  if (t === 'ZEC') return { bucket: 'crypto', row: 'ZEC' };
  if (t === 'TAO') return { bucket: 'crypto', row: 'TAO' };
  if (CRYPTO_OTHER.has(t)) return { bucket: 'crypto', row: 'Other' };
  if (t === 'BETTERMENT') return { bucket: 'equities', row: 'Betterment' };
  if (t === '401K') return { bucket: 'equities', row: '401(k)' };
  if (t === 'JPM') return { bucket: 'equities', row: 'JPM' };
  return { bucket: 'equities', row: t || 'Other' };
}

function emptyCols() {
  return { personal: 0, roth: 0, trad: 0, total: 0 };
}

function addCell(map, row, column, value) {
  if (!map.has(row)) map.set(row, emptyCols());
  const cell = map.get(row);
  const col = column === 'roth' || column === 'trad' ? column : 'personal';
  const amt = Number(value) || 0;
  cell[col] += amt;
  cell.total += amt;
}

function toPct(dollars) {
  const pct = {};
  for (const [row, cols] of Object.entries(dollars)) {
    pct[row] = emptyCols();
    for (const col of COLUMNS) {
      const denom = columnTotal(dollars, col);
      pct[row][col] = denom > 0 ? round1((cols[col] / denom) * 100) : 0;
    }
  }
  return pct;
}

function columnTotal(dollars, col) {
  return Object.values(dollars).reduce((s, cols) => s + Number(cols[col] || 0), 0);
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

function freezeMap(map, order) {
  const dollars = {};
  const keys = order || [...map.keys()].sort((a, b) => map.get(b).total - map.get(a).total);
  for (const key of keys) {
    if (!map.has(key)) continue;
    const cols = map.get(key);
    dollars[key] = {
      personal: roundMoney(cols.personal),
      roth: roundMoney(cols.roth),
      trad: roundMoney(cols.trad),
      total: roundMoney(cols.total),
    };
  }
  return { dollars, pct: toPct(dollars) };
}

export function buildOwnerView({ positions = [], checking = 0, asOf = null } = {}) {
  const mix = new Map();
  const equities = new Map();
  const crypto = new Map();
  const reserve = new Map();

  for (const pos of positions) {
    if (pos.hidden) continue;
    const ticker = normalizeTicker(pos.ticker || pos.security?.ticker || pos.holdings?.[0]?.ticker);
    if (!ticker) continue;
    const value = Number(pos.markedValue ?? pos.totalValue ?? pos.value ?? 0);
    if (!Number.isFinite(value)) continue;
    const column = columnFromAccount(pos.accountName || pos.account);
    const { bucket, row } = classify(pos.ticker || ticker);
    if (bucket === 'equities') {
      addCell(equities, row, column, value);
      addCell(mix, 'Equities', column, value);
    } else if (bucket === 'crypto') {
      addCell(crypto, row, column, value);
      addCell(mix, 'Crypto', column, value);
    } else {
      addCell(reserve, row, column, value);
      if (row === 'Gold') addCell(mix, 'Gold', column, value);
      else if (row === 'PSLV') addCell(mix, 'Silver', column, value);
      else addCell(mix, 'Cash', column, value);
    }
  }

  const cash = Number(checking) || 0;
  if (cash) {
    addCell(reserve, 'Checking', 'personal', cash);
    addCell(mix, 'Cash', 'personal', cash);
  }

  const cryptoOrder = ['BTC + MSTR', 'ZEC', 'TAO', 'Other'].filter((k) => crypto.has(k));
  const reserveOrder = ['Gold', 'PSLV', 'USDC', 'Checking'].filter((k) => reserve.has(k));
  const mixOrder = ['Equities', 'Crypto', 'Gold', 'Silver', 'Cash'].filter((k) => mix.has(k));

  return {
    asOf,
    month: (asOf || '').slice(0, 7) || null,
    columns: [...COLUMNS],
    mix: freezeMap(mix, mixOrder),
    equities: freezeMap(equities),
    crypto: freezeMap(crypto, cryptoOrder),
    reserve: freezeMap(reserve, reserveOrder),
  };
}

export function attachOwnerViews(monthCloses = [], { checking = 0, currentMonth = null } = {}) {
  return monthCloses.map((row) => {
    const view = buildOwnerView({
      asOf: row.asOf,
      positions: row.positions || [],
      checking: currentMonth && row.month === currentMonth ? checking : 0,
    });
    return { ...row, view };
  });
}
