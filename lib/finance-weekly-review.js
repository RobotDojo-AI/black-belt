/**
 * Saturday finance review: score the book against written rules.
 * Notes never contain "buy". Gold/cash out of the 60/40. Drawdowns are
 * owned treasures only. VIX names a feeling, not a trade.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOwnerView, classify, columnFromAccount, normalizeTicker } from './portfolio-view.js';
import { fetchYahooDailyCloses, yahooSymbol } from './monarch-prices.js';
import { monarchStoreRoot } from './monarch-store.js';
import { createPersonalDueTask, nyDate } from './asana-my-tasks.js';

export const TREASURE_TICKERS = Object.freeze([
  'AAPL', 'MSFT', 'AMZN', 'GOOG', 'META', 'NVDA', 'TSLA',
  'TSM', 'ASML', 'SPCX', 'POWR', 'FILL', 'SETM', 'BTC',
]);

const TREASURE_SET = new Set(TREASURE_TICKERS);
const CASH_TICKERS = new Set(['USD', 'USDC']);
const BUY_RE = /buy/i;
const DRAWDOWN_LINE = 0.20;
const MONTH_MOVE = 0.25;
const MONTH_SESSIONS = 21;
/** DE consulting breakeven take-home: $35,295/month (canonical 2026-08-20). */
export const MONTHLY_SPEND = 35295;

const VIX_RULES = Object.freeze({
  complacency: 'Recognize comfort. Do not add because it feels fine.',
  ordinary: 'No unusual signal. Stay with the written rules.',
  elevated: 'Notice dips. Run the treasure filter and the cash gate.',
  fear: 'Recognize scared. Look at the drawdown flags with the filter. Do not freeze.',
});

export function vixFeeling(close) {
  const n = Number(close);
  if (!Number.isFinite(n)) return null;
  if (n < 12) return 'complacency';
  if (n <= 20) return 'ordinary';
  if (n <= 30) return 'elevated';
  return 'fear';
}

export function positionTicker(pos = {}) {
  return normalizeTicker(pos.ticker || pos.security?.ticker || pos.holdings?.[0]?.ticker);
}

export function positionValue(pos = {}) {
  const v = Number(pos.markedValue ?? pos.totalValue ?? pos.value ?? 0);
  return Number.isFinite(v) ? v : 0;
}

export function scoreRiskBook(positions = [], { column } = {}) {
  const filtered = column
    ? positions.filter((p) => columnFromAccount(p.accountName || p.account) === column)
    : positions;
  const view = buildOwnerView({ positions: filtered });
  const equities = Number(view.mix?.dollars?.Equities?.total || 0);
  const btcCoins = Number(view.btc?.coinValue || 0);
  const mstr = Number(view.btc?.mstrValue || 0);
  const btcSide = btcCoins + mstr;
  const risk = equities + btcSide;
  const equityPct = risk > 0 ? (equities / risk) * 100 : 0;
  const btcPct = risk > 0 ? (btcSide / risk) * 100 : 0;
  const gold = Number(view.mix?.dollars?.Gold?.total || 0);
  const cash = Number(view.mix?.dollars?.Cash?.total || 0)
    + Number(view.reserve?.dollars?.USDC?.total || 0)
    + Number(view.reserve?.dollars?.Checking?.total || 0);
  let vs = 'on target';
  if (btcPct < 35) vs = 'Light BTC';
  else if (btcPct > 45) vs = 'Heavy BTC';
  else if (equityPct < 55) vs = 'Light equities';
  else if (equityPct > 65) vs = 'Heavy equities';
  return {
    equities,
    btcSide,
    risk,
    equityPct: Math.round(equityPct * 10) / 10,
    btcPct: Math.round(btcPct * 10) / 10,
    gold,
    cash,
    vs,
  };
}

export function incomeTaxOwedFromAccounts(accounts = []) {
  let owed = 0;
  for (const acct of accounts) {
    if (acct.isHidden) continue;
    const n = String(acct.displayName || '');
    if (!/income taxes owed/i.test(n)) continue;
    owed += Math.abs(Number(acct.displayBalance ?? acct.currentBalance ?? 0)) || 0;
  }
  return owed;
}

export function netCashFromAccounts({ accounts = [], positions = [] } = {}) {
  let deposits = 0;
  let cards = 0;
  for (const acct of accounts) {
    if (acct.isHidden || acct.includeInNetWorth === false) continue;
    const bal = Number(acct.displayBalance ?? acct.currentBalance ?? 0);
    if (!Number.isFinite(bal)) continue;
    if (acct.type === 'depository') deposits += bal;
    if (acct.type === 'credit') cards += Math.abs(bal);
  }
  let usdc = 0;
  for (const pos of positions) {
    if (pos.hidden) continue;
    if (positionTicker(pos) !== 'USDC') continue;
    usdc += positionValue(pos);
  }
  const taxOwed = incomeTaxOwedFromAccounts(accounts);
  const netBeforeTax = deposits + usdc - cards;
  return {
    deposits,
    usdc,
    cards,
    taxOwed,
    netBeforeTax,
    net: netBeforeTax,
  };
}

export function bookMix(positions = [], { accounts = [] } = {}) {
  const view = buildOwnerView({ positions });
  const mix = view.mix?.dollars || {};
  const cashNet = netCashFromAccounts({ accounts, positions });
  function slice(col) {
    const equities = Number(mix.Equities?.[col] || 0);
    const crypto = Number(mix.Crypto?.[col] || 0);
    const gold = Number(mix.Gold?.[col] || 0);
    const silver = Number(mix.Silver?.[col] || 0);
    const cashGross = Number(mix.Cash?.[col] || 0);
    const cash = col === 'personal' && accounts.length ? cashNet.net : cashGross;
    const goldSilver = gold + silver;
    const total = equities + crypto + goldSilver + cash;
    const pctBase = cash >= 0 ? total : (equities + crypto + goldSilver);
    const pct = (n) => (pctBase > 0 ? Math.round((n / pctBase) * 100) : 0);
    return {
      equities,
      crypto,
      gold,
      silver,
      goldSilver,
      cash,
      cashGross,
      cards: col === 'personal' ? cashNet.cards : 0,
      total,
      equitiesPct: pct(equities),
      cryptoPct: pct(crypto),
      goldSilverPct: pct(goldSilver),
      cashPct: cash >= 0 ? pct(cash) : null,
    };
  }
  const personal = slice('personal');
  const roth = slice('roth');
  const trad = slice('trad');
  return {
    personal,
    roth,
    trad,
    retirement: combineBooks(roth, trad),
    cashNet,
  };
}

/** IRA + Roth are one book. Slight tax difference does not split the mix. */
export function combineBooks(a = {}, b = {}) {
  const equities = Number(a.equities || 0) + Number(b.equities || 0);
  const crypto = Number(a.crypto || 0) + Number(b.crypto || 0);
  const gold = Number(a.gold || 0) + Number(b.gold || 0);
  const silver = Number(a.silver || 0) + Number(b.silver || 0);
  const goldSilver = gold + silver;
  const cash = Number(a.cash || 0) + Number(b.cash || 0);
  const total = equities + crypto + goldSilver + cash;
  const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);
  return {
    equities,
    crypto,
    gold,
    silver,
    goldSilver,
    cash,
    total,
    equitiesPct: pct(equities),
    cryptoPct: pct(crypto),
    goldSilverPct: pct(goldSilver),
    cashPct: pct(cash),
  };
}

export function runwayMonths(amount, monthly = MONTHLY_SPEND) {
  if (!(monthly > 0)) return 0;
  return Math.round((Number(amount) / monthly) * 10) / 10;
}

function money(n) {
  const v = Math.round(Number(n) || 0);
  return `$${v.toLocaleString('en-US')}`;
}

export function ownedHoldings(positions = []) {
  const byTicker = new Map();
  for (const pos of positions) {
    if (pos.hidden) continue;
    const ticker = positionTicker(pos);
    if (!ticker || CASH_TICKERS.has(ticker)) continue;
    if (!yahooSymbol(ticker) && ticker !== 'SPCX') continue;
    const value = positionValue(pos);
    const qty = Number(pos.quantity || 0);
    if (!(value > 0 || qty > 0)) continue;
    const key = ticker === 'FILL' ? 'POWR' : ticker;
    const prev = byTicker.get(key) || { ticker: key, value: 0, qty: 0 };
    prev.value += value;
    if (Number.isFinite(qty)) prev.qty += qty;
    byTicker.set(key, prev);
  }
  return [...byTicker.values()];
}

export function ownedTreasures(positions = []) {
  const byTicker = new Map();
  for (const pos of positions) {
    if (pos.hidden) continue;
    const ticker = positionTicker(pos);
    if (!TREASURE_SET.has(ticker)) continue;
    const value = positionValue(pos);
    const qty = Number(pos.quantity || 0);
    if (!(value > 0 || qty > 0)) continue;
    const key = ticker === 'FILL' ? 'POWR' : ticker;
    const prev = byTicker.get(key) || { ticker: key, value: 0, qty: 0 };
    prev.value += value;
    if (Number.isFinite(qty)) prev.qty += qty;
    byTicker.set(key, prev);
  }
  return [...byTicker.values()];
}

function rowsFor(priceBook, ticker) {
  return priceBook?.get(ticker) || priceBook?.get(ticker === 'POWR' ? 'FILL' : ticker) || [];
}

function lastCloseOn(rows, asOf) {
  let hit = null;
  for (const row of rows || []) {
    if (!row?.date || row.date > asOf) continue;
    const n = Number(row.close);
    if (Number.isFinite(n) && n > 0) hit = n;
  }
  return hit;
}

function closeSessionsAgo(rows, asOf, sessions) {
  const upTo = (rows || []).filter((r) => r.date <= asOf && Number(r.close) > 0);
  if (upTo.length < sessions + 1) return null;
  return Number(upTo[upTo.length - 1 - sessions].close);
}

export function treasureDrawdowns(owned = [], priceBook, asOf) {
  return owned.map((row) => {
    const rows = rowsFor(priceBook, row.ticker);
    const last = lastCloseOn(rows, asOf);
    const high = rows.length
      ? Math.max(...rows.map((r) => Number(r.close)).filter((n) => Number.isFinite(n) && n > 0))
      : null;
    if (last == null || high == null || !(high > 0)) {
      return { ticker: row.ticker, status: 'unpriced', drawdown: null };
    }
    const drawdown = (high - last) / high;
    return {
      ticker: row.ticker,
      status: drawdown >= DRAWDOWN_LINE ? 'drawdown' : 'ok',
      drawdown,
      last,
      high,
    };
  }).filter((row) => row.status === 'drawdown' || row.status === 'unpriced');
}

export function holdingMoves(owned = [], priceBook, asOf) {
  const month = [];
  for (const row of owned) {
    const rows = rowsFor(priceBook, row.ticker);
    const last = lastCloseOn(rows, asOf);
    const prior = closeSessionsAgo(rows, asOf, MONTH_SESSIONS);
    if (last == null || prior == null || !(prior > 0)) continue;
    const change = (last - prior) / prior;
    if (Math.abs(change) >= MONTH_MOVE) {
      month.push({ ticker: row.ticker, change, group: moveGroup(row.ticker) });
    }
  }
  month.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return { month };
}

function assertNoBuy(notes) {
  if (BUY_RE.test(notes)) throw new Error('finance weekly review notes must not contain buy');
  return notes;
}

function moveGroup(ticker) {
  const { bucket, row } = classify(ticker);
  if (bucket === 'equities') return 'Equities';
  if (bucket === 'crypto') return 'BTC / Crypto';
  if (row === 'Gold' || row === 'PSLV') return 'Gold, Silver';
  return 'Cash';
}

const MOVE_GROUPS = ['Equities', 'BTC / Crypto', 'Gold, Silver', 'Cash'];

function groupedMoves(monthMoves = []) {
  const by = new Map(MOVE_GROUPS.map((g) => [g, []]));
  for (const f of monthMoves) {
    const g = f.group || moveGroup(f.ticker);
    if (!by.has(g)) by.set(g, []);
    by.get(g).push(f);
  }
  return MOVE_GROUPS.map((g) => ({ group: g, items: by.get(g) || [] })).filter((row) => row.items.length);
}

function signedPct(n) {
  const pct = Math.round(Number(n) * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

function bookLines(slice) {
  return [
    `Equities: ${money(slice?.equities)} (${slice?.equitiesPct ?? 0}%)`,
    `BTC / Crypto: ${money(slice?.crypto)} (${slice?.cryptoPct ?? 0}%)`,
    `Gold, Silver: ${money(slice?.goldSilver)} (${slice?.goldSilverPct ?? 0}%)`,
    slice?.cashPct == null
      ? `Cash: ${money(slice?.cash)}`
      : `Cash: ${money(slice?.cash)} (${slice?.cashPct}%)`,
  ];
}

function personalExtras(mix) {
  const p = mix?.personal || {};
  const cashForRunway = Math.max(0, Number(p.cash || 0));
  const metals = Number(p.gold || 0) + Number(p.silver || 0);
  const months = runwayMonths(metals + cashForRunway);
  const tax = Number(mix?.cashNet?.taxOwed || 0);
  const netMonths = runwayMonths(metals + cashForRunway - tax);
  return [
    `Runway ${months} months.`,
    `Net of taxes ${netMonths} months.`,
  ];
}

export function formatReviewNotes({
  mix,
  vixClose,
  feeling,
  monthMoves = [],
} = {}) {
  const vixLine = vixClose == null || !Number.isFinite(Number(vixClose))
    ? 'VIX unavailable this week.'
    : `VIX ${Number(vixClose).toFixed(1)} — ${feeling}`;
  const rules = feeling && VIX_RULES[feeling]
    ? VIX_RULES[feeling]
    : 'Stay with the written rules.';
  const retirement = mix?.retirement || combineBooks(mix?.roth, mix?.trad);
  const groups = groupedMoves(monthMoves);
  const moveLines = groups.length
    ? groups.flatMap((g) => [
      g.group,
      ...g.items.map((f) => `${f.ticker} ${signedPct(f.change)}`),
    ])
    : ['None.'];
  const notes = [
    'Market',
    vixLine,
    rules,
    '',
    'Personal',
    ...bookLines(mix?.personal),
    ...personalExtras(mix),
    '',
    'IRA + Roth',
    ...bookLines(retirement),
    '',
    'Big Moves',
    ...moveLines,
    '',
  ].join('\n');
  return assertNoBuy(notes);
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatReviewHtml(args = {}) {
  const vixLine = args.vixClose == null || !Number.isFinite(Number(args.vixClose))
    ? 'VIX unavailable this week.'
    : `VIX ${Number(args.vixClose).toFixed(1)} — ${esc(args.feeling)}`;
  const rules = args.feeling && VIX_RULES[args.feeling]
    ? VIX_RULES[args.feeling]
    : 'Stay with the written rules.';
  const mix = args.mix || {};
  const retirement = mix.retirement || combineBooks(mix.roth, mix.trad);
  const bookLis = (slice) => bookLines(slice).map((l) => {
    const [label, rest] = l.split(': ');
    return `<li><strong>${esc(label)}:</strong> ${esc(rest)}</li>`;
  });
  const personalBook = bookLis(mix.personal);
  const cashLi = personalBook[personalBook.length - 1] || '<li><strong>Cash:</strong> $0</li>';
  const extraInner = personalExtras(mix).map((l) => `<li>${esc(l)}</li>`).join('');
  const personalInner = [
    ...personalBook.slice(0, -1),
    cashLi,
    extraInner ? `<ul>${extraInner}</ul>` : '',
  ].join('');
  const groups = groupedMoves(args.monthMoves || []);
  const moveInner = groups.length
    ? groups.map((g) => (
      `<li><strong>${esc(g.group)}</strong></li><ul>`
      + g.items.map((f) => `<li>${esc(f.ticker)} ${esc(signedPct(f.change))}</li>`).join('')
      + '</ul>'
    )).join('')
    : '<li>None.</li>';
  const html = [
    '<body><strong>Market</strong>',
    `<ul><li>${esc(vixLine)}</li><li>${esc(rules)}</li></ul>`,
    '<strong>Personal</strong>',
    `<ul>${personalInner}</ul>`,
    '<strong>IRA + Roth</strong>',
    `<ul>${bookLis(retirement).join('')}</ul>`,
    '<strong>Big Moves</strong>',
    `<ul>${moveInner}</ul></body>`,
  ].join('\n');
  return assertNoBuy(html);
}

export function nyCalendarDate(now = new Date()) {
  return nyDate(now);
}

async function loadReviewPrices(tickers, { asOf, fetchImpl }) {
  const start = new Date(`${asOf}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 370);
  const startDate = start.toISOString().slice(0, 10);
  const book = new Map();
  const unique = [...new Set(tickers.filter(Boolean))];
  await Promise.all(unique.map(async (ticker) => {
    const mapped = yahooSymbol(ticker) || (ticker === '^VIX' ? { kind: 'yahoo', symbol: '^VIX' } : null);
    if (!mapped || mapped.kind === 'cash') return;
    const rows = await fetchYahooDailyCloses(mapped.symbol, { startDate, endDate: asOf, fetchImpl });
    if (rows.length) book.set(ticker, rows);
  }));
  return book;
}

export async function buildFinanceWeeklyReview({
  week,
  positions = [],
  accounts = [],
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  const asOf = nyDate(now);
  const personalRisk = scoreRiskBook(positions, { column: 'personal' });
  const mix = bookMix(positions, { accounts });
  const owned = ownedHoldings(positions);
  const priceTickers = [...owned.map((r) => r.ticker), '^VIX', 'FILL', 'BTC-USD'];
  const priceBook = await loadReviewPrices(priceTickers, { asOf, fetchImpl });
  const vixRows = priceBook.get('^VIX') || [];
  const vixClose = lastCloseOn(vixRows, asOf);
  const feeling = vixFeeling(vixClose);
  const monthMoves = holdingMoves(owned, priceBook, asOf).month;
  const payload = {
    week: week || asOf,
    mix,
    personalRisk,
    vixClose,
    feeling,
    monthMoves,
  };
  const notes = formatReviewNotes(payload);
  const html = formatReviewHtml(payload);
  return {
    week: week || asOf,
    asOf,
    mix,
    personalRisk,
    vixClose,
    feeling,
    monthMoves,
    notes,
    html,
  };
}

export function writeWeekReviewFile({ root, week, notes }) {
  const dir = join(monarchStoreRoot(root), 'weeks', week);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'review.md');
  writeFileSync(path, `${notes.trimEnd()}\n`, 'utf8');
  return path;
}

export async function finishPromotedWeek({
  compact,
  review = runFinanceWeeklyReview,
  compactArgs,
  reviewArgs,
} = {}) {
  await compact(compactArgs);
  return review(reviewArgs);
}

export async function runFinanceWeeklyReview({
  week,
  positions = [],
  accounts = [],
  now = new Date(),
  fetchImpl = fetch,
  root,
  createTask = createPersonalDueTask,
} = {}) {
  const review = await buildFinanceWeeklyReview({ week, positions, accounts, now, fetchImpl });
  if (root && review.week) {
    try { writeWeekReviewFile({ root, week: review.week, notes: review.notes }); } catch { /* keep going */ }
  }
  const gid = await createTask({
    name: 'Weekly Portfolio Review',
    notes: review.notes,
    htmlNotes: review.html,
    dueOn: review.asOf,
    fetchImpl,
    now,
  });
  return { ...review, asanaGid: gid || null };
}
