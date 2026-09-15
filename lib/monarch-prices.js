/**
 * Public month-end closes for current lots. Not a lot ledger.
 */
const CRYPTO_USD = new Set(['BTC', 'ETH', 'SOL', 'PAXG', 'ZEC', 'TAO', 'DOGE', 'WLD']);
const SKIP = new Set(['JELLY', 'BALAJIS', 'BASED', 'USI', 'STEP', 'ROBLOX', 'DRINK', 'BEAR', 'PUMP', 'USD']);

export function yahooSymbol(ticker) {
  const raw = String(ticker || '').trim().toUpperCase().replace(/-USD$/, '');
  if (!raw || SKIP.has(raw)) return null;
  if (raw === 'CUR:USD' || raw === 'USD-USD') return { kind: 'cash', symbol: 'USD' };
  if (raw === 'USDC') return { kind: 'cash', symbol: 'USDC' };
  if (raw === 'FILL') return { kind: 'yahoo', symbol: 'POWR' };
  if (CRYPTO_USD.has(raw)) return { kind: 'yahoo', symbol: `${raw}-USD` };
  return { kind: 'yahoo', symbol: raw };
}

export function lastCloseOnOrBefore(rows = [], asOf) {
  const target = String(asOf || '');
  let hit = null;
  for (const row of rows) {
    if (!row?.date || row.date > target) continue;
    if (!Number.isFinite(Number(row.close)) || Number(row.close) <= 0) continue;
    hit = Number(row.close);
  }
  return hit;
}

export async function fetchYahooDailyCloses(symbol, { startDate, endDate, fetchImpl = fetch } = {}) {
  const p1 = Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse(`${endDate}T23:59:59Z`) / 1000);
  if (!Number.isFinite(p1) || !Number.isFinite(p2) || p2 < p1) return [];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return [];
  const body = await res.json();
  const result = body?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const rows = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = Number(closes[i]);
    if (!Number.isFinite(close) || close <= 0) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    rows.push({ date, close });
  }
  return rows;
}

export async function loadPriceBook(tickers, { startDate, endDate, fetchImpl = fetch } = {}) {
  const book = new Map();
  const unique = [...new Set(tickers.filter(Boolean))];
  await Promise.all(unique.map(async (ticker) => {
    const mapped = yahooSymbol(ticker);
    if (!mapped) return;
    if (mapped.kind === 'cash') {
      book.set(ticker, [{ date: startDate, close: 1 }]);
      return;
    }
    const rows = await fetchYahooDailyCloses(mapped.symbol, { startDate, endDate, fetchImpl });
    if (rows.length) book.set(ticker, rows);
  }));
  return book;
}

export function closeForTicker(priceBook, ticker, asOf) {
  const rows = priceBook.get(ticker);
  if (!rows?.length) return null;
  return lastCloseOnOrBefore(rows, asOf);
}
