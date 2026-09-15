/**
 * Reconstruct share quantity from Robinhood activity CSVs + Coinbase fills.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeTicker } from './portfolio-view.js';

const QTY_CODES_ADD = new Set(['Buy', 'ACATI', 'SOFF', 'MTCH', 'DRFRO']);
const QTY_CODES_SUB = new Set(['Sell', 'ACATO']);

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => String(c).trim()))
    .map((r) => {
      const obj = {};
      header.forEach((h, i) => { obj[h] = r[i] ?? ''; });
      return obj;
    });
}

function parseNumber(raw) {
  const s = String(raw || '').replace(/[$,]/g, '').replace(/[()]/g, '').trim();
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseDate(raw) {
  const s = String(raw || '').trim();
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const mm = mdy[1].padStart(2, '0');
    const dd = mdy[2].padStart(2, '0');
    return `${mdy[3]}-${mm}-${dd}`;
  }
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : null;
}

export function parseRobinhoodActivity(text, column) {
  const events = [];
  for (const row of parseCsv(text)) {
    if (/informational purposes/i.test(row['Activity Date'] || '')) continue;
    const date = parseDate(row['Activity Date']);
    const code = String(row['Trans Code'] || '').trim();
    const instrument = normalizeTicker(row.Instrument);
    const qty = parseNumber(row.Quantity);
    if (!date) continue;
    let delta = 0;
    if (instrument && qty) {
      if (QTY_CODES_ADD.has(code)) delta = qty;
      else if (QTY_CODES_SUB.has(code)) delta = -Math.abs(qty);
    }
    events.push({
      date,
      column,
      ticker: instrument || null,
      code,
      delta,
      source: 'robinhood',
      amount: parseNumber(row.Amount) * ((row.Amount || '').includes('(') ? -1 : 1),
    });
  }
  return events;
}

export function parseCoinbaseFills(text) {
  const raw = String(text || '');
  const idx = raw.indexOf('ID,Timestamp');
  const slice = idx >= 0 ? raw.slice(idx) : raw;
  const events = [];
  for (const row of parseCsv(slice)) {
    const ts = String(row.Timestamp || '');
    const date = ts.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const ticker = normalizeTicker(row.Asset);
    const qty = Number(row['Quantity Transacted'] || 0);
    if (!ticker || !Number.isFinite(qty) || qty === 0) continue;
    const type = String(row['Transaction Type'] || '');
    if (/Retail Staking Transfer/i.test(type)) continue;
    events.push({
      date,
      column: 'personal',
      ticker,
      code: type,
      delta: qty,
      source: 'coinbase',
    });
  }
  return events;
}

export function loadBrokerExportEvents(exportsDir) {
  if (!exportsDir || !existsSync(exportsDir)) return [];
  const events = [];
  const personal = join(exportsDir, 'robinhood-personal.csv');
  const roth = join(exportsDir, 'robinhood-roth.csv');
  const trad = join(exportsDir, 'robinhood-traditional.csv');
  if (existsSync(personal)) events.push(...parseRobinhoodActivity(readFileSync(personal, 'utf8'), 'personal'));
  if (existsSync(roth)) events.push(...parseRobinhoodActivity(readFileSync(roth, 'utf8'), 'roth'));
  if (existsSync(trad)) events.push(...parseRobinhoodActivity(readFileSync(trad, 'utf8'), 'trad'));
  for (const name of readdirSync(exportsDir)) {
    if (!name.includes('584d4c45')) continue;
    events.push(...parseCoinbaseFills(readFileSync(join(exportsDir, name), 'utf8')));
  }
  return events;
}

export function quantityByMonth(events, monthEnds) {
  const sorted = [...events].filter((e) => e.ticker && e.delta).sort((a, b) => a.date.localeCompare(b.date));
  const qty = new Map();
  const key = (column, ticker, source) => `${column}|${ticker}|${source || ''}`;
  let i = 0;
  const out = [];
  for (const asOf of monthEnds) {
    while (i < sorted.length && sorted[i].date <= asOf) {
      const e = sorted[i];
      const k = key(e.column, e.ticker, e.source || '');
      qty.set(k, (qty.get(k) || 0) + e.delta);
      i++;
    }
    const lots = [];
    for (const [k, q] of qty.entries()) {
      if (Math.abs(q) < 1e-8) continue;
      const [column, ticker, source] = k.split('|');
      lots.push({ column, ticker, source, quantity: q, asOf });
    }
    out.push({ asOf, lots });
  }
  return out;
}
