/**
 * First-party Monarch read client.
 *
 * Host, login path, GraphQL path, and allowlisted operation names live here.
 * No writes besides login. No monarchmoney package.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MONARCH_API_BASE = 'https://api.monarch.com';
export const MONARCH_LOGIN_PATH = '/auth/login/';
export const MONARCH_GRAPHQL_PATH = '/graphql';
export const MONARCH_GRAPHQL_OPERATIONS = Object.freeze([
  'GetAccounts',
  'GetTransactionsList',
  'Web_GetHoldings',
  'GetAggregateSnapshots',
  'GetSnapshotsByAccountType',
  'GetAccountSnapshots',
]);

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
    txnPageLimit: envInt('MONARCH_TXN_PAGE_LIMIT', raw.txnPageLimit ?? 1000),
    timeoutMs: envInt('MONARCH_TIMEOUT_MS', raw.timeoutMs ?? 600_000),
    userAgent: process.env.MONARCH_USER_AGENT || raw.userAgent
      || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    monarchClient: process.env.MONARCH_CLIENT || raw.monarchClient || 'monarch-core-web-app-rest',
    monarchClientVersion: process.env.MONARCH_CLIENT_VERSION || raw.monarchClientVersion || 'v1.0.3968',
  };
}

export function monarchClientConfig() {
  return loadTunables();
}

const GET_ACCOUNTS_QUERY = `
query GetAccounts {
  accounts {
    id
    displayName
    currentBalance
    displayBalance
    holdingsCount
    transactionsCount
    type { name display }
    subtype { name display }
    isHidden
    includeInNetWorth
  }
}
`.trim();

const GET_TRANSACTIONS_QUERY = `
query GetTransactionsList($filters: TransactionFilterInput, $offset: Int, $limit: Int) {
  allTransactions(filters: $filters) {
    totalCount
    results(offset: $offset, limit: $limit) {
      id
      amount
      pending
      date
      hideFromReports
      plaidName
      notes
      category { id name }
      merchant { id name }
      account { id displayName }
      updatedAt
    }
  }
}
`.trim();

const GET_HOLDINGS_QUERY = `
query Web_GetHoldings($input: PortfolioInput) {
  portfolio(input: $input) {
    aggregateHoldings {
      edges {
        node {
          id
          quantity
          basis
          totalValue
          holdings { id name ticker type typeDisplay account { id displayName } }
          security { id name ticker type currentPrice closingPrice }
        }
      }
    }
  }
}
`.trim();

const GET_AGGREGATE_SNAPSHOTS_QUERY = `
query GetAggregateSnapshots($filters: AggregateSnapshotFilters) {
  aggregateSnapshots(filters: $filters) {
    date
    balance
  }
}
`.trim();

const GET_SNAPSHOTS_BY_ACCOUNT_TYPE_QUERY = `
query GetSnapshotsByAccountType($startDate: Date!, $timeframe: Timeframe!) {
  snapshotsByAccountType(startDate: $startDate, timeframe: $timeframe) {
    accountType
    month
    balance
  }
}
`.trim();

const GET_ACCOUNT_SNAPSHOTS_QUERY = `
query GetAccountSnapshots($accountId: UUID!) {
  snapshotsForAccount(accountId: $accountId) {
    date
    signedBalance
  }
}
`.trim();

function todayUtcDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function sessionHeaders(session, cfg) {
  const headers = monarchRequestHeaders({
    extra: { 'Monarch-Client': 'monarch-core-web-app-graphql' },
  });
  if (session?.kind === 'cookies') {
    const parts = [];
    if (session.session_id) parts.push(`sessionid=${session.session_id}`);
    if (session.csrftoken) parts.push(`csrftoken=${session.csrftoken}`);
    if (parts.length) headers.Cookie = parts.join('; ');
    if (session.csrftoken) headers['X-CSRFToken'] = session.csrftoken;
  } else if (session?.token) {
    headers.Authorization = `Token ${session.token}`;
  }
  return headers;
}

export function isJwtShapedToken(token) {
  const value = String(token || '');
  if (!value) return false;
  const parts = value.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export function assertAllowlistedOperation(operationName) {
  if (!MONARCH_GRAPHQL_OPERATIONS.includes(operationName)) {
    throw new Error(`monarch graphql: operation '${operationName}' is not allowlisted`);
  }
}

/**
 * GraphQL helper. Refuses any operation name outside the allowlist.
 */
export async function monarchGraphql({
  operationName,
  query,
  variables = {},
  session,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  assertAllowlistedOperation(operationName);
  const cfg = loadTunables();
  const res = await fetchImpl(`${MONARCH_API_BASE}${MONARCH_GRAPHQL_PATH}`, {
    method: 'POST',
    headers: sessionHeaders(session, cfg),
    body: JSON.stringify({ operationName, query, variables }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (res.status === 401) {
    const err = new Error('Monarch session rejected');
    err.status = 401;
    err.body = body;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Monarch GraphQL HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (Array.isArray(body.errors) && body.errors.length) {
    const err = new Error(body.errors.map((e) => e.message || 'graphql error').join('; '));
    err.graphqlErrors = body.errors;
    throw err;
  }
  return body.data || {};
}

export function monarchRequestHeaders({ deviceUuid, extra } = {}) {
  const cfg = loadTunables();
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Client-Platform': 'web',
    Origin: 'https://app.monarch.com',
    Referer: 'https://app.monarch.com/login',
    'Monarch-Client': cfg.monarchClient,
    'Monarch-Client-Version': cfg.monarchClientVersion,
    'User-Agent': cfg.userAgent,
    ...(deviceUuid ? { 'Device-UUID': deviceUuid } : {}),
    ...extra,
  };
}

export async function loginMonarch({
  username,
  password,
  totp,
  emailOtp,
  deviceUuid,
  fetchImpl = fetch,
} = {}) {
  const cfg = loadTunables();
  const body = {
    username,
    password,
    supports_mfa: true,
    supports_email_otp: true,
    supports_recaptcha: true,
    trusted_device: true,
  };
  if (totp) body.totp = totp;
  if (emailOtp) body.email_otp = emailOtp;

  const res = await fetchImpl(`${MONARCH_API_BASE}${MONARCH_LOGIN_PATH}`, {
    method: 'POST',
    headers: monarchRequestHeaders({ deviceUuid }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }

  const errorCode = payload.error_code || payload.errorCode || null;
  if (errorCode === 'CAPTCHA_REQUIRED') {
    const err = new Error('Monarch login blocked by captcha');
    err.code = 'CAPTCHA_REQUIRED';
    err.retryable = false;
    throw err;
  }
  if (errorCode === 'EMAIL_OTP_REQUIRED') {
    const err = new Error('Monarch emailed a one-time login code');
    err.code = 'EMAIL_OTP_REQUIRED';
    err.retryable = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(typeof payload.detail === 'string' ? payload.detail : 'Monarch login failed');
    err.status = res.status;
    err.code = errorCode || 'LOGIN_FAILED';
    throw err;
  }

  const token = payload.token || payload.accessToken || null;
  const tokenExpiration = payload.tokenExpiration ?? payload.token_expiration ?? null;
  if (tokenExpiration != null) {
    throw new Error('Monarch returned a short-lived token');
  }
  if (token && isJwtShapedToken(token)) {
    throw new Error('Monarch returned a JWT-shaped token');
  }

  if (payload.session_id && payload.csrftoken) {
    return {
      kind: 'cookies',
      session_id: payload.session_id,
      csrftoken: payload.csrftoken,
      tokenExpiration: null,
      obtainedAt: new Date().toISOString(),
    };
  }
  if (!token) throw new Error('Monarch login returned no session');
  return {
    kind: 'token',
    token,
    tokenExpiration: null,
    obtainedAt: new Date().toISOString(),
  };
}

function normalizeAccount(row) {
  const type = row?.type && typeof row.type === 'object' ? (row.type.name || row.type.display || row.type) : row?.type;
  const subtype = row?.subtype && typeof row.subtype === 'object' ? (row.subtype.name || row.subtype.display || row.subtype) : row?.subtype;
  return {
    id: row.id,
    displayName: row.displayName ?? row.name ?? null,
    currentBalance: row.currentBalance ?? null,
    displayBalance: row.displayBalance ?? row.currentBalance ?? null,
    holdingsCount: Number(row.holdingsCount || 0),
    transactionsCount: Number(row.transactionsCount || 0),
    type: type ?? null,
    subtype: subtype ?? null,
    isHidden: !!row.isHidden,
    includeInNetWorth: row.includeInNetWorth !== false,
  };
}

export async function fetchAccounts({ session, fetchImpl = fetch } = {}) {
  const data = await monarchGraphql({
    operationName: 'GetAccounts',
    query: GET_ACCOUNTS_QUERY,
    session,
    fetchImpl,
  });
  const rows = data.accounts || data.allAccounts || [];
  return rows.map(normalizeAccount);
}

export async function fetchTransactions({ session, fetchImpl = fetch, pageLimit } = {}) {
  const cfg = loadTunables();
  const limit = Number(pageLimit) > 0 ? Number(pageLimit) : cfg.txnPageLimit;
  const filters = { transactionVisibility: 'all_transactions' };
  const collected = [];
  let totalCount = null;
  let offset = 0;

  while (totalCount == null || collected.length < totalCount) {
    const data = await monarchGraphql({
      operationName: 'GetTransactionsList',
      query: GET_TRANSACTIONS_QUERY,
      variables: { filters, offset, limit },
      session,
      fetchImpl,
    });
    const page = data.allTransactions || {};
    if (totalCount == null) totalCount = Number(page.totalCount || 0);
    const rows = Array.isArray(page.results) ? page.results : [];
    if (rows.length === 0 && collected.length < totalCount) {
      const err = new Error('Monarch transaction page was empty before totalCount');
      err.code = 'incomplete_page';
      err.collected = collected.length;
      err.totalCount = totalCount;
      throw err;
    }
    collected.push(...rows);
    if (rows.length === 0) break;
    offset += rows.length;
    if (rows.length < limit) break;
  }

  return {
    transactions: collected.map((row) => ({
      id: row.id,
      amount: row.amount,
      pending: !!row.pending,
      date: row.date,
      hideFromReports: !!row.hideFromReports,
      plaidName: row.plaidName ?? null,
      notes: row.notes ?? null,
      category: row.category ?? null,
      merchant: row.merchant ?? null,
      account: row.account ?? null,
      updatedAt: row.updatedAt ?? null,
    })),
    totalCount: totalCount ?? collected.length,
  };
}

function holdingAccount(node) {
  if (!Array.isArray(node.holdings)) return null;
  return node.holdings.find((h) => h?.account)?.account || null;
}

function normalizePosition(node) {
  const hidden = node.hidden === true || node.isHidden === true;
  const nestedAccount = holdingAccount(node);
  const accountId = node.accountId || node.account?.id || nestedAccount?.id || null;
  const accountName = node.accountName || node.account?.displayName || node.account?.name || nestedAccount?.displayName || nestedAccount?.name || null;
  return {
    id: node.id,
    accountId,
    accountName,
    quantity: node.quantity ?? null,
    basis: node.basis ?? null,
    totalValue: node.totalValue ?? null,
    hidden,
    holdings: Array.isArray(node.holdings)
      ? node.holdings.map((h) => ({
        id: h.id,
        name: h.name ?? null,
        ticker: h.ticker ?? null,
        type: h.type ?? null,
        typeDisplay: h.typeDisplay ?? null,
      }))
      : [],
    security: node.security
      ? {
        id: node.security.id,
        name: node.security.name ?? null,
        ticker: node.security.ticker ?? null,
        type: node.security.type ?? null,
        currentPrice: node.security.currentPrice ?? null,
        closingPrice: node.security.closingPrice ?? null,
      }
      : null,
  };
}

async function pullHoldings({ session, accountIds, today, includeHiddenHoldings, fetchImpl }) {
  return monarchGraphql({
    operationName: 'Web_GetHoldings',
    query: GET_HOLDINGS_QUERY,
    variables: {
      input: {
        accountIds,
        startDate: today,
        endDate: today,
        includeHiddenHoldings,
      },
    },
    session,
    fetchImpl,
  });
}

export async function fetchHoldings({
  session,
  accountIds = [],
  accountNames = {},
  fetchImpl = fetch,
  now = new Date(),
  asOf = null,
  dualHidden = true,
} = {}) {
  if (!accountIds.length) return [];
  const today = asOf || todayUtcDate(now);
  const collected = [];
  for (const accountId of accountIds) {
    const allData = await pullHoldings({
      session,
      accountIds: [accountId],
      today,
      includeHiddenHoldings: true,
      fetchImpl,
    });
    let visibleIds = null;
    if (dualHidden) {
      const visibleData = await pullHoldings({
        session,
        accountIds: [accountId],
        today,
        includeHiddenHoldings: false,
        fetchImpl,
      });
      visibleIds = new Set(
        (visibleData.portfolio?.aggregateHoldings?.edges || [])
          .map((edge) => edge?.node?.id)
          .filter(Boolean),
      );
    }
    const edges = allData.portfolio?.aggregateHoldings?.edges || [];
    for (const edge of edges) {
      const row = normalizePosition(edge?.node || {});
      if (!row.id) continue;
      row.accountId = accountId;
      row.accountName = accountNames[accountId] || row.accountName;
      if (visibleIds && !visibleIds.has(row.id)) row.hidden = true;
      collected.push(row);
    }
  }
  return collected;
}

export async function fetchAggregateSnapshots({
  session,
  startDate = '2024-01-01',
  endDate,
  accountType = null,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const data = await monarchGraphql({
    operationName: 'GetAggregateSnapshots',
    query: GET_AGGREGATE_SNAPSHOTS_QUERY,
    variables: {
      filters: {
        startDate,
        endDate: endDate || todayUtcDate(now),
        ...(accountType ? { accountType } : {}),
      },
    },
    session,
    fetchImpl,
  });
  return (data.aggregateSnapshots || [])
    .map((row) => ({ date: row.date, balance: Number(row.balance) }))
    .filter((row) => row.date && Number.isFinite(row.balance))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchSnapshotsByAccountType({
  session,
  startDate = '2024-01-01',
  timeframe = 'month',
  fetchImpl = fetch,
} = {}) {
  const data = await monarchGraphql({
    operationName: 'GetSnapshotsByAccountType',
    query: GET_SNAPSHOTS_BY_ACCOUNT_TYPE_QUERY,
    variables: { startDate, timeframe },
    session,
    fetchImpl,
  });
  return (data.snapshotsByAccountType || [])
    .map((row) => ({
      month: row.month,
      accountType: row.accountType,
      balance: Number(row.balance),
    }))
    .filter((row) => row.month && row.accountType && Number.isFinite(row.balance));
}

export async function fetchAccountSnapshots({ session, accountId, fetchImpl = fetch } = {}) {
  const data = await monarchGraphql({
    operationName: 'GetAccountSnapshots',
    query: GET_ACCOUNT_SNAPSHOTS_QUERY,
    variables: { accountId: String(accountId) },
    session,
    fetchImpl,
  });
  return (data.snapshotsForAccount || [])
    .map((row) => ({ date: row.date, signedBalance: Number(row.signedBalance) }))
    .filter((row) => row.date && Number.isFinite(row.signedBalance))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function pullMonarchBook({ session, fetchImpl = fetch, now = new Date() } = {}) {
  const accounts = await fetchAccounts({ session, fetchImpl });
  const invested = accounts.filter((a) => Number(a.holdingsCount) > 0);
  const investedIds = invested.map((a) => a.id);
  const accountNames = Object.fromEntries(invested.map((a) => [a.id, a.displayName]));
  const [{ transactions, totalCount }, positions] = await Promise.all([
    fetchTransactions({ session, fetchImpl }),
    fetchHoldings({ session, accountIds: investedIds, accountNames, fetchImpl, now }),
  ]);
  return { accounts, transactions, totalCount, positions };
}

export const MONARCH_WRITE_EXPORTS = Object.freeze([]);
