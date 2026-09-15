/**
 * lib/xai-keys.js — X (Twitter) Grok key first, then the Gmail/Google team key.
 *
 * The owner has two xAI credentials:
 *   robotdojo-XAI_API_KEY  — X/Twitter handle team. Spend this to $0 first.
 *   xai-google-hold        — Gmail/Google "Robot Dojo" team key.
 *                            Canonical after the X key is drained.
 *
 * A 402 / credit-exhausted response on the X key flips a local state file so
 * every later call (chat, pipeline, warmup) bills the Gmail key. The hold
 * key is never written into the shared XAI_API_KEY slot automatically — that
 * swap is an owner decision once they certify the drain. Until then, runtime
 * just reads the hold service.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { secret } from './config.js';
import { readKeychainSecret } from './keychain.js';

export const XAI_SPENDDOWN_SERVICE = 'XAI_API_KEY';
export const XAI_CANONICAL_HOLD_SERVICE = 'xai-google-hold';

const STATE_PATH = process.env.ROBOTDOJO_XAI_KEY_STATE
  || join(homedir(), '.robotdojo', 'state', 'xai-key.json');

function emptyState() {
  return {
    active: 'spenddown',
    spenddown_depleted_at: null,
    spenddown_source: 'robotdojo-XAI_API_KEY',
    canonical_source: XAI_CANONICAL_HOLD_SERVICE,
  };
}

export function xaiKeyStatePath() {
  return STATE_PATH;
}

export function readXaiKeyState() {
  try {
    if (!existsSync(STATE_PATH)) return emptyState();
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

function writeState(next) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function markXaiSpenddownDepleted(reason = 'credit_exhausted') {
  const prev = readXaiKeyState();
  if (prev.active === 'canonical' && prev.spenddown_depleted_at) return prev;
  return writeState({
    ...prev,
    active: 'canonical',
    spenddown_depleted_at: new Date().toISOString(),
    deplete_reason: reason,
  });
}

function spenddownKey() {
  return secret(XAI_SPENDDOWN_SERVICE) || secret('GROK_API_KEY') || process.env.XAI_API_KEY || process.env.GROK_API_KEY || null;
}

function canonicalHoldKey() {
  if (process.env.ROBOTDOJO_XAI_CANONICAL_KEY) return process.env.ROBOTDOJO_XAI_CANONICAL_KEY;
  // Test prefix means we must not touch the owner's real hold key.
  if (process.env.ROBOTDOJO_KEYCHAIN_PREFIX) return null;
  try {
    return readKeychainSecret(XAI_CANONICAL_HOLD_SERVICE, { rawService: true }) || null;
  } catch {
    return null;
  }
}

/**
 * Credential for the current xAI call. Never logs the value.
 * @returns {{key: string|null, source: string, slot: 'spenddown'|'canonical'}}
 */
export function resolveXaiApiKey() {
  const state = readXaiKeyState();
  if (state.active !== 'canonical') {
    const key = spenddownKey();
    if (key) return { key, source: 'robotdojo-XAI_API_KEY', slot: 'spenddown' };
  }
  const hold = canonicalHoldKey();
  if (hold) return { key: hold, source: XAI_CANONICAL_HOLD_SERVICE, slot: 'canonical' };
  const fallback = spenddownKey();
  return { key: fallback, source: fallback ? 'robotdojo-XAI_API_KEY' : 'none', slot: fallback ? 'spenddown' : 'canonical' };
}

export function isXaiCreditError(err) {
  const status = Number(err?.status || 0);
  const msg = String(err?.message || err?.detail?.message || '').toLowerCase();
  if (status === 402) return true;
  if (/insufficient[_\s-]?quota|credit[s]?\s+(exhausted|depleted)|out of credits|billing|payment required|spend limit|no remaining/.test(msg)) {
    return true;
  }
  if (status === 429 && /quota|credit|billing|balance/.test(msg)) return true;
  return false;
}

async function probeOneKey(key) {
  if (!key) return { configured: false };
  const res = await fetch('https://api.x.ai/v1/api-key', {
    headers: { Authorization: `Bearer ${key}` },
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return {
    configured: true,
    http: res.status,
    name: data?.name || data?.api_key?.name || null,
    team_id: data?.team_id || data?.api_key?.team_id || null,
    blocked: Boolean(data?.api_key_blocked || data?.team_blocked || data?.api_key_disabled),
    redacted: data?.redacted_api_key || null,
  };
}

/** Status for both xAI slots. Never returns raw secrets. */
export async function probeXaiKeySlots() {
  const state = readXaiKeyState();
  const spenddown = await probeOneKey(spenddownKey());
  const canonical = await probeOneKey(canonicalHoldKey());
  return {
    active: state.active,
    spenddown_depleted_at: state.spenddown_depleted_at,
    spenddown: { ...spenddown, source: 'robotdojo-XAI_API_KEY' },
    canonical: { ...canonical, source: XAI_CANONICAL_HOLD_SERVICE },
  };
}

export async function withXaiKey(run) {
  const first = resolveXaiApiKey();
  if (!first.key) throw new Error('provider_not_configured: XAI_API_KEY missing');
  try {
    return await run(first.key, first);
  } catch (err) {
    if (first.slot !== 'spenddown' || !isXaiCreditError(err)) throw err;
    markXaiSpenddownDepleted(err.message || 'credit_exhausted');
    const next = resolveXaiApiKey();
    if (!next.key || next.key === first.key) throw err;
    return run(next.key, next);
  }
}
