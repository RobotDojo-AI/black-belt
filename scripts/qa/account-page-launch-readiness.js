#!/usr/bin/env node
/**
 * Account-page launch readiness.
 *
 * Source of truth: the same `/api/accounts/integration-cards` payload rendered
 * by the Account page. Do not use static card contracts to decide which live
 * accounts are in scope for this QA check.
 */
import { Agent, fetch as undiciFetch } from 'undici';
import { fileURLToPath } from 'node:url';
import { readKeychainSecret } from '../../lib/keychain.js';
import config from '../../lib/config.js';

const DEFAULT_BASE_URL = `https://localhost:${config.ports.app}`;
const DEFAULT_TIMEOUT_MS = 30000;
const BLOCK_STATES = new Set(['failed', 'needs_key', 'needs_oauth', 'needs_permission', 'error_recoverable']);
const PROGRESS_STATES = new Set(['partial', 'queued', 'running', 'paused', 'importing']);
const OK_STATES = new Set(['connected', 'done', 'ready']);
const ZERO_DATA_WARNING_PROVIDERS = new Set(['imports', 'notion', 'granola', 'apple-health']);
const DATA_COUNT_KEYS = new Set([
  'chat', 'email', 'gmail', 'calendar', 'contacts', 'drive', 'docs', 'documents',
  'sheets', 'slides', 'photos', 'search_console', 'messages', 'sms', 'tasks',
  'health', 'transcripts', 'pages', 'files',
]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeState(value) {
  return String(value || '').trim().toLowerCase() || 'unknown';
}

export function maskAccount(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.includes('@')) {
    const [left, domain] = s.split('@');
    return `${left.slice(0, 2)}…@${domain}`;
  }
  return s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function sumDataCounts(value) {
  if (!value || typeof value !== 'object') return 0;
  let total = 0;
  for (const [key, child] of Object.entries(value)) {
    if (DATA_COUNT_KEYS.has(key)) total += Number(child) || 0;
  }
  return total;
}

function cardStatus(card) {
  return normalizeState(card.connection_status || card.launch_state || card.status || (card.connected ? 'connected' : 'ready'));
}

function accountStatus(account, card) {
  return normalizeState(
    account.sync_state
      || account.account_status
      || account.health_state
      || cardStatus(card)
      || (account.connected ? 'connected' : 'ready'),
  );
}

function cardDataTotal(card) {
  return Number(card.artifact_total) || sumDataCounts(card.artifact_counts_by_type) || Number(card.doc_count) || 0;
}

function accountDataTotal(account) {
  return sumDataCounts(account.products) || Number(account.doc_count) || 0;
}

function sectionCards(payload) {
  const out = [];
  for (const section of payload?.sections || []) {
    for (const card of section.cards || []) out.push({ section, card });
  }
  return out;
}

export function flattenAccountPageLaunchRows(payload) {
  const rows = [];
  for (const { section, card } of sectionCards(payload)) {
    const provider = String(card.provider || '').trim();
    const status = cardStatus(card);
    const artifactTotal = cardDataTotal(card);
    const accounts = Array.isArray(card.accounts) ? card.accounts : [];
    const launchRequired = card.launch_required === true;
    rows.push({
      kind: 'card',
      row_id: `${section.id}:${provider}`,
      section: section.id,
      provider,
      name: card.name || provider,
      account: '',
      launch_required: launchRequired,
      status,
      connected: Boolean(card.connected),
      credential_state: card.credential_state || null,
      artifact_total: artifactTotal,
      account_count: accounts.length,
      in_scope: launchRequired || Boolean(card.connected) || artifactTotal > 0 || accounts.length > 0,
    });

    for (const account of accounts) {
      const accountProvider = String(account.provider || provider || '').trim();
      const accountLabel = account.email || account.account || account.name || account.label || '';
      const accountArtifacts = accountDataTotal(account);
      const accountState = accountStatus(account, card);
      rows.push({
        kind: 'account',
        row_id: `${section.id}:${provider}:${maskAccount(accountLabel) || accountProvider}`,
        section: section.id,
        provider: accountProvider,
        parent_provider: provider,
        name: account.label || accountProvider,
        account: maskAccount(accountLabel),
        launch_required: launchRequired,
        status: accountState,
        connected: account.connected !== false && (Boolean(card.connected) || OK_STATES.has(accountState)),
        credential_state: account.credential ? 'stored' : null,
        artifact_total: accountArtifacts,
        account_count: 0,
        in_scope: true,
      });
    }
  }
  return rows;
}

function classifyRow(row) {
  const status = normalizeState(row.status);
  const label = row.account ? `${row.provider}:${row.account}` : row.provider;
  const base = {
    row_id: row.row_id,
    section: row.section,
    provider: row.provider,
    account: row.account || null,
    status,
    artifact_total: row.artifact_total,
  };

  if (BLOCK_STATES.has(status)) {
    const severity = row.in_scope ? 'blocker' : 'warning';
    return {
      severity,
      code: status,
      message: `${label} is ${status.replace(/_/g, ' ')}`,
      ...base,
    };
  }

  if (PROGRESS_STATES.has(status)) {
    return {
      severity: 'warning',
      code: status,
      message: `${label} is still ${status.replace(/_/g, ' ')}`,
      ...base,
    };
  }

  if (row.kind === 'card' && row.launch_required && status === 'ready' && !row.connected && row.artifact_total === 0 && row.account_count === 0) {
    return {
      severity: 'warning',
      code: 'required_ready_without_data',
      message: `${label} is launch-required but has no connected account or local records yet`,
      ...base,
    };
  }

  if (row.kind === 'card' && ZERO_DATA_WARNING_PROVIDERS.has(row.provider) && row.connected && row.artifact_total === 0 && row.account_count === 0) {
    return {
      severity: 'warning',
      code: 'connected_zero_records',
      message: `${label} is connected but has no local records in the Account page payload`,
      ...base,
    };
  }

  if (row.kind === 'account' && OK_STATES.has(status) && row.artifact_total === 0) {
    return {
      severity: 'warning',
      code: 'account_zero_records',
      message: `${label} is listed but has zero local records in the Account page payload`,
      ...base,
    };
  }

  return null;
}

export function assessAccountPageLaunchReadiness(payload) {
  const rows = flattenAccountPageLaunchRows(payload);
  const findings = rows.map(classifyRow).filter(Boolean);
  const blockers = findings.filter((finding) => finding.severity === 'blocker');
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  const cards = rows.filter((row) => row.kind === 'card');
  const accounts = rows.filter((row) => row.kind === 'account');
  const artifactTotal = rows
    .filter((row) => row.kind === 'card')
    .reduce((sum, row) => sum + row.artifact_total, 0);
  const quality = Math.max(0, 10 - blockers.length * 2 - warnings.length * 0.5);
  return {
    ok: blockers.length === 0,
    strict_ok: blockers.length === 0 && warnings.length === 0,
    quality_score_10: Number(quality.toFixed(1)),
    source: '/api/accounts/integration-cards',
    generated_at: new Date().toISOString(),
    redacted: true,
    summary: {
      cards: cards.length,
      accounts: accounts.length,
      launch_required_cards: cards.filter((row) => row.launch_required).length,
      connected_cards: cards.filter((row) => row.connected).length,
      artifact_total: artifactTotal,
      blockers: blockers.length,
      warnings: warnings.length,
    },
    blockers,
    warnings,
    rows,
  };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    baseUrl: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    strictWarnings: false,
    warmupDelayMs: 1500,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base-url') opts.baseUrl = argv[++i] || opts.baseUrl;
    else if (arg.startsWith('--base-url=')) opts.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--timeout-ms') opts.timeoutMs = Number.parseInt(argv[++i] || '', 10) || opts.timeoutMs;
    else if (arg.startsWith('--timeout-ms=')) opts.timeoutMs = Number.parseInt(arg.slice('--timeout-ms='.length), 10) || opts.timeoutMs;
    else if (arg === '--strict-warnings') opts.strictWarnings = true;
    else if (arg === '--warmup-delay-ms') opts.warmupDelayMs = Number.parseInt(argv[++i] || '', 10) || opts.warmupDelayMs;
    else if (arg.startsWith('--warmup-delay-ms=')) opts.warmupDelayMs = Number.parseInt(arg.slice('--warmup-delay-ms='.length), 10) || opts.warmupDelayMs;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

export function usage() {
  return [
      `Usage: node scripts/qa/account-page-launch-readiness.js [--base-url ${DEFAULT_BASE_URL}] [--strict-warnings]`,
    '',
    'Reads the same Account page integration sheet rendered by /account/integrations.',
  ].join('\n');
}

export function readAuthToken() {
  return process.env.QA_AUTH_TOKEN
    || process.env.ROBOTDOJO_AUTH_TOKEN
    || readKeychainSecret('ROBOTDOJO_AUTH_TOKEN')
    || readKeychainSecret('robotdojo-ROBOTDOJO_AUTH_TOKEN')
    || '';
}

function localHttpsDispatcher(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') return undefined;
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return undefined;
  return new Agent({ connect: { rejectUnauthorized: false } });
}

async function fetchIntegrationCards({ baseUrl, timeoutMs, token, fetchImpl, dispatcher }) {
  const url = new URL('/api/accounts/integration-cards?refresh=1', baseUrl);
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher,
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Account page returned invalid JSON (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`Account page returned HTTP ${res.status}: ${String(body.error || body.message || '').slice(0, 120)}`);
  return body;
}

export async function runAccountPageLaunchReadiness({
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  warmupDelayMs = 1500,
  token = readAuthToken(),
  fetchImpl = undiciFetch,
} = {}) {
  if (!token) {
    throw new Error('missing ROBOTDOJO_AUTH_TOKEN; set QA_AUTH_TOKEN or store robotdojo-ROBOTDOJO_AUTH_TOKEN in Keychain');
  }
  const dispatcher = localHttpsDispatcher(baseUrl);
  try {
    await fetchIntegrationCards({ baseUrl, timeoutMs, token, fetchImpl, dispatcher });
    if (warmupDelayMs > 0) await wait(warmupDelayMs);
    const payload = await fetchIntegrationCards({ baseUrl, timeoutMs, token, fetchImpl, dispatcher });
    return assessAccountPageLaunchReadiness(payload);
  } finally {
    if (dispatcher) await dispatcher.close().catch(() => {});
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs();
  } catch (err) {
    console.error(`[account-page-launch-readiness] ${err.message}`);
    console.error(usage());
    process.exit(2);
  }
  if (opts.help) {
    console.log(usage());
    return;
  }

  try {
    const result = await runAccountPageLaunchReadiness(opts);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok || (opts.strictWarnings && !result.strict_ok)) process.exit(1);
  } catch (err) {
    console.error(`[account-page-launch-readiness] ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
