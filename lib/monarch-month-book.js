/**
 * Month-end book: Monarch account totals as SoT, fill lots only where we have them.
 * Remainder of an overlay account is cash. Other accounts stay one row.
 */
import { yahooSymbol } from './monarch-prices.js';
import { closeForTicker } from './monarch-prices.js';

const BOOK_TYPES = new Set(['brokerage', 'depository', 'other_asset']);

export function bookAccounts(accounts = []) {
  return accounts.filter((a) => BOOK_TYPES.has(a.type) && a.includeInNetWorth !== false);
}

export function accountRole(acct = {}) {
  const n = String(acct.displayName || '').trim();
  const hidden = !!acct.isHidden;
  const type = acct.type;
  const subtype = String(acct.subtype || '');
  if (!n) return null;
  if (type === 'other_asset' && /prepaid/i.test(n)) return null;
  if (n === 'Robinhood') return { overlay: 'personal', source: 'robinhood', cash: 'USD' };
  if (n === 'Roth IRA' && !hidden) return { overlay: 'roth', source: 'robinhood', cash: 'USD' };
  if (n === 'Traditional IRA' && !hidden) return { overlay: 'trad', source: 'robinhood', cash: 'USD' };
  if (n === 'Coinbase') return { overlay: 'personal', source: 'coinbase', cash: 'USDC' };
  if (n === 'Ledger Nano X') return { whole: 'BTC' };
  if (subtype === 'cryptocurrency' && /crypto/i.test(n) && n !== 'Coinbase' && n !== 'primary') {
    return { whole: 'BTC' };
  }
  if (type === 'depository') return { whole: 'USD' };
  if (n === '401(k)') return { whole: '401K' };
  if (/^jpm/i.test(n)) return { whole: 'JPM' };
  if (
    n === 'Investment'
    || n === 'Short Term Investments'
    || n === 'Crypto ETF'
    || (hidden && (n === 'Roth IRA' || n === 'Traditional IRA'))
  ) {
    return { whole: 'BETTERMENT' };
  }
  if (type === 'brokerage') return { whole: n };
  return null;
}

export function markLots(lots = [], { asOf, priceBook, accountName } = {}) {
  const rows = [];
  for (const lot of lots) {
    const qty = Number(lot.quantity);
    if (!(qty > 0)) continue;
    const mapped = yahooSymbol(lot.ticker);
    if (!mapped || mapped.kind === 'cash') continue;
    const price = closeForTicker(priceBook, lot.ticker, asOf);
    if (price == null || !Number.isFinite(price)) continue;
    const markedValue = qty * price;
    if (!(Math.abs(markedValue) >= 1)) continue;
    rows.push({
      ticker: lot.ticker,
      quantity: qty,
      closingPrice: price,
      markedValue,
      accountName,
      account: accountName,
      quantitySource: 'fills',
    });
  }
  return rows;
}

export function buildMonthPositions({
  accounts = [],
  lots = [],
  asOf,
  priceBook,
} = {}) {
  const positions = [];
  for (const acct of accounts) {
    const role = accountRole(acct);
    if (!role) continue;
    const bal = Number(acct.balance || 0);
    const name = acct.displayName;
    if (role.overlay) {
      const slice = lots.filter((lot) => (
        lot.column === role.overlay && (lot.source || '') === role.source
      ));
      const marked = markLots(slice, { asOf, priceBook, accountName: name });
      const sum = marked.reduce((s, p) => s + Number(p.markedValue || 0), 0);
      if (bal <= 0) continue;
      if (sum > bal && sum > 0) {
        const scale = bal / sum;
        for (const pos of marked) pos.markedValue *= scale;
        positions.push(...marked);
        continue;
      }
      positions.push(...marked);
      const rem = bal - sum;
      if (rem >= 1) {
        positions.push({
          ticker: role.cash,
          quantity: rem,
          closingPrice: 1,
          markedValue: rem,
          accountName: name,
          account: name,
          quantitySource: 'account_remainder',
        });
      }
      continue;
    }
    if (Math.abs(bal) < 1) continue;
    positions.push({
      ticker: role.whole,
      quantity: 0,
      closingPrice: null,
      markedValue: bal,
      accountName: name,
      account: name,
      quantitySource: 'monarch_account',
    });
  }
  return positions;
}

export function accountsForMonth(series = [], month) {
  const rows = Array.isArray(series?.accounts) ? series.accounts : series;
  return rows
    .map((acct) => {
      const point = acct.months?.[month];
      if (!point) return null;
      return {
        id: acct.id,
        displayName: acct.displayName,
        type: acct.type,
        subtype: acct.subtype,
        isHidden: !!acct.isHidden,
        includeInNetWorth: acct.includeInNetWorth !== false,
        balance: Number(point.balance),
        asOf: point.asOf,
      };
    })
    .filter(Boolean);
}

export function bookTotal(accounts = []) {
  return accounts.reduce((s, a) => {
    if (!accountRole(a)) return s;
    const bal = Number(a.balance || 0);
    return s + (Number.isFinite(bal) ? bal : 0);
  }, 0);
}
