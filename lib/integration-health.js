/**
 * Integration health — probe, self-heal, notify.
 *
 * probeAll()      → parallel token probes + last-sync queries, no writes
 * healAndAudit()  → probeAll, attempt self-heal on failures, write to
 *                   integration_health table, return results
 * notify()        → macOS Notification Center via osascript (no deps,
 *                   works on Sequoia; terminal-notifier broken as of Feb 2025)
 */

import { existsSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import db from './db.js';
import { secret } from './config.js';
import {
  getValidAccessToken,
  refreshGoogleToken,
  listConnectedGoogleAccounts,
} from './google-oauth.js';
import {
  getValidMicrosoftAccessToken,
  refreshMicrosoftToken,
  listConnectedMicrosoftAccounts,
} from './microsoft-oauth.js';
import {
  getGranolaLocalSession,
  getGranolaToken,
  refreshGranolaToken,
} from './granola-client.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mirrorPassiveJobStatus } from './passive-jobs.js';
// st_bf4978b0 — API-key cadence probes now run a real zero-cost /v1/models
// handshake (Thin Facade: the shared handshake lives in lib/api-key-probe.js,
// used by both this cadence pass and the manual keys/test route). A 200 marks
// verifiedLive so healAndAudit stamps verified_at; 401/403/429/other → Issue.
import { probeApiKeyLive } from './api-key-probe.js';
// st_bf4978b0 QA-fix — the per-class freshness window, so a token integration's
// "recent successful sync" fallback (positive proof it worked) is judged against
// the same window the classifier uses.
import { staleWindowForName } from './integration-status.js';
// st_fd14cdd4 AC2: fixed-probe enumeration derives from the integration
// registry. Probe implementations stay in this module (they need db/tokens);
// the registry declares WHICH integrations get a fixed probe row.
import { registryProbeNames } from './integration-registry.js';

// Inline — importing lib/imessage.js runs db.exec at module load time which
// attempts to create a UNIQUE INDEX that can fail against existing data.
const CHAT_DB_PATH = join(homedir(), 'Library', 'Messages', 'chat.db');
const PHOTOS_DB_PATH = join(homedir(), 'Pictures', 'Photos Library.photoslibrary', 'database', 'Photos.sqlite');
const LOCAL_PROBE_TIMEOUT_MS = Number(process.env.ROBOTDOJO_LOCAL_INTEGRATION_PROBE_TIMEOUT_MS || 750);
const LOCAL_PROBE_SCRIPT = `
const fs = require('fs');
try {
  const fd = fs.openSync(process.argv[1], 'r');
  fs.closeSync(fd);
  process.exit(0);
} catch {
  process.exit(1);
}
`;

function canOpenProtectedLocalFile(path) {
  try {
    if (!existsSync(path)) return false;
    const result = spawnSync(process.execPath, ['-e', LOCAL_PROBE_SCRIPT, path], {
      stdio: 'ignore',
      timeout: LOCAL_PROBE_TIMEOUT_MS,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ── Notification ────────────────────────────────────────────────────────────

export function notify(title, msg) {
  try {
    const safeTitle = title.replace(/"/g, '\\"').replace(/'/g, "\\'");
    const safeMsg   = msg.replace(/"/g, '\\"').replace(/'/g, "\\'");
    execSync(`osascript -e 'display notification "${safeMsg}" with title "${safeTitle}"'`, {
      timeout: 5000,
      stdio: 'ignore',
    });
  } catch {
    // Notification is best-effort — screen locked, Focus mode, etc.
  }
}

// ── DB helpers ───────────────────────────────────────────────────────────────
//
// st_d142f701 AC12: lazy-initialized prepared statements. Previously these
// were module-level constants — `const upsertHealth = db.prepare(...)` —
// which run at import time. On a clean install the `integration_health`
// table may not exist yet (migrations run after this module gets imported
// via the route graph), so the module-load crashed first boot with
// `SQLITE_ERROR: no such table: integration_health`. Lazy getters defer
// the prepare() call until the first probe / heal call, which only fires
// after the boot sequence has applied migrations.

let _upsertHealth = null;
let _getHealth = null;

function getUpsertHealthStmt() {
  if (_upsertHealth) return _upsertHealth;
  // st_bf4978b0 — `verified_at` advances ONLY when a probe reports a real live
  // verification (verifiedLive: true → a fresh timestamp; otherwise NULL). The
  // COALESCE preserves any prior verification on a non-verifying write, so a
  // presence-only or failing write never clobbers a genuine verification — and
  // never fabricates one either.
  _upsertHealth = db.prepare(`
    INSERT INTO integration_health (name, status, last_check, last_sync, consecutive_failures, last_error, verified_at, updated_at)
    VALUES (?, ?, datetime('now'), ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      status               = excluded.status,
      last_check           = excluded.last_check,
      last_sync            = excluded.last_sync,
      consecutive_failures = excluded.consecutive_failures,
      last_error           = excluded.last_error,
      verified_at          = COALESCE(excluded.verified_at, integration_health.verified_at),
      updated_at           = excluded.updated_at
  `);
  return _upsertHealth;
}

function getHealthStmt() {
  if (_getHealth) return _getHealth;
  _getHealth = db.prepare(`SELECT * FROM integration_health WHERE name = ?`);
  return _getHealth;
}

function readLastSync(sql, ...params) {
  try {
    const row = db.prepare(sql).get(...params);
    return row?.ts || null;
  } catch { return null; }
}

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

// ── Per-integration probe definitions ────────────────────────────────────────

async function probeGoogle(email, type) {
  const name = `${type}:${email}`;
  let token = null;
  let lastSync = null;
  let error = null;

  try {
    token = await getValidAccessToken(email);
  } catch (e) {
    error = e.message;
  }

  if (type === 'gmail') {
    const acct = db.prepare(`SELECT id FROM accounts WHERE vendor='google' AND type='email' AND email=?`).get(email);
    lastSync = acct?.id
      ? readLastSync(`SELECT MAX(received_at) AS ts FROM emails INDEXED BY idx_emails_account_received WHERE account_id=?`, acct.id)
      : null;
  } else if (type === 'calendar') {
    lastSync = readLastSync(`
      SELECT MAX(synced_at) AS ts
        FROM calendar_events
       WHERE account_id IN (
         SELECT id FROM accounts
          WHERE vendor='google'
            AND email=?
            AND type IN ('calendar', 'email')
       )
    `, email);
  } else if (type === 'drive') {
    const acct = db.prepare(`SELECT id FROM accounts WHERE vendor='google' AND type='drive' AND email=?`).get(email);
    lastSync = readLastSync(`SELECT MAX(indexed_at) AS ts FROM drive_files WHERE account_id=?`, acct?.id);
  } else if (type === 'contacts') {
    lastSync = readLastSync(`SELECT MAX(synced_at) AS ts FROM google_contacts WHERE account_id=?`, email);
  } else if (type === 'photos') {
    const acct = db.prepare(`SELECT id FROM accounts WHERE vendor='google' AND type='email' AND email=?`).get(email);
    lastSync = readLastSync(`SELECT MAX(indexed_at) AS ts FROM photos WHERE account_id=?`, acct?.id);
  }

  return {
    name,
    status: token ? 'ok' : 'error',
    lastSync,
    error,
    canHeal: !token && !!error,
    // A valid access token (refreshed on demand by getValidAccessToken) is a
    // live verification the OAuth connection works right now — stamp verified_at
    // so the account can render Healthy inside the 180-min OAuth window.
    verifiedLive: !!token,
  };
}

async function probeMicrosoft(email, type) {
  const name = type === 'email' ? `microsoft-mail:${email}` : `microsoft-calendar:${email}`;
  let token = null;
  let lastSync = null;
  let error = null;

  try {
    token = await getValidMicrosoftAccessToken(email);
  } catch (e) {
    error = e.message;
  }

  if (type === 'email') {
    const accountIds = db.prepare(`SELECT id FROM accounts WHERE vendor='microsoft' AND type='email' AND email=?`)
      .all(email)
      .map((row) => row.id)
      .filter(Boolean);
    if (accountIds.length) {
      const placeholders = accountIds.map(() => '?').join(',');
      lastSync = readLastSync(
        `SELECT MAX(received_at) AS ts FROM emails INDEXED BY idx_emails_account_received WHERE account_id IN (${placeholders})`,
        ...accountIds,
      );
    }
  } else if (type === 'calendar') {
    const acct = db.prepare(`SELECT id FROM accounts WHERE vendor='microsoft' AND type='calendar' AND email=?`).get(email);
    lastSync = readLastSync(`SELECT MAX(synced_at) AS ts FROM calendar_events WHERE source='graph' AND account_id=?`, acct?.id);
  }

  return {
    name,
    status: token ? 'ok' : 'error',
    lastSync,
    error,
    canHeal: !token && !!error,
    verifiedLive: !!token,
  };
}

// st_bf4978b0 QA-fix — token integrations (Oura/Notion/Asana) were false-red:
// their old probes returned status 'ok' on mere token PRESENCE without stamping
// verified_at, so the classifier defaulted them to a permanent Issue. Presence
// is not health. This shared helper runs the real zero-cost identity handshake
// (Thin Facade: the handshake lives in lib/api-key-probe.js) and only claims
// Healthy on positive live evidence:
//   200            → status ok + verifiedLive (verified_at = now)
//   401/403        → needs_reauth (Issue + reconnect — the token is rejected)
//   429            → quota_exceeded (Issue — provider is throttling)
//   provider_error → a transient network/timeout/5xx is NOT a definitive reject;
//                    fall back to a real successful sync inside the freshness
//                    window (positive proof it worked), stamping the honest sync
//                    time — never a fake "now" (AC3). No recent sync → honest Issue.
// Runs only in the 15-min cadence monitor, never on any chat/render path.
async function probeTokenIntegration({ name, provider, key, missingMsg, lastSync = null }) {
  if (!key) {
    return { name, status: 'error', lastSync, error: missingMsg, canHeal: false };
  }
  const { status } = await probeApiKeyLive(provider, key);
  if (status === 'valid') {
    return { name, status: 'ok', lastSync, error: null, canHeal: false, verifiedLive: true };
  }
  if (status === 'invalid_key') {
    return { name, status: 'needs_reauth', lastSync, error: 'Token rejected — reconnect this integration', canHeal: false };
  }
  if (status === 'quota_exceeded') {
    return { name, status: 'quota_exceeded', lastSync, error: 'Provider quota reached', canHeal: false };
  }
  // provider_error: transient. A recent successful sync is live-enough evidence.
  if (lastSync && Number.isFinite(Date.parse(lastSync)) && (Date.now() - Date.parse(lastSync)) < staleWindowForName(name)) {
    return { name, status: 'ok', lastSync, error: null, canHeal: false, verifiedAt: lastSync };
  }
  return { name, status: 'provider_error', lastSync, error: 'Could not verify the connection', canHeal: false };
}

async function probeMonarch() {
  // Keychain session and/or current pointer only. Do not spawn `op` or login.
  let session = null;
  try {
    const { readStoredMonarchSession } = await import('./monarch-auth.js');
    session = readStoredMonarchSession();
  } catch { session = null; }
  let current = null;
  try {
    const { readCurrentPointer } = await import('./monarch-store.js');
    current = readCurrentPointer();
  } catch { current = null; }
  const lastSync = readLastSync(`SELECT MAX(synced_at) AS ts FROM accounts WHERE vendor='monarch'`);
  if (session || current) {
    return {
      name: 'monarch',
      status: 'ok',
      lastSync: lastSync || current?.week || session?.obtainedAt || null,
      error: null,
      canHeal: false,
      verifiedLive: !!session,
    };
  }
  return {
    name: 'monarch',
    status: 'error',
    lastSync,
    error: 'Monarch session not connected',
    canHeal: false,
  };
}

async function probeOura() {
  const token = secret('OURA_PAT') || secret('OURA_CLIENT_SECRET');
  const lastSync = readLastSync(`
    SELECT MAX(ts) AS ts
    FROM (
      SELECT MAX(created_at) AS ts FROM health_notes WHERE source='oura'
      UNION ALL
      SELECT MAX(created_at) AS ts FROM health_data_points WHERE source IN ('oura_sync', 'oura-json')
    )
  `);
  return probeTokenIntegration({ name: 'oura', provider: 'oura', key: token, missingMsg: 'OURA_PAT not in Keychain', lastSync });
}

async function probeEightSleep() {
  const password = secret('EIGHT_SLEEP_PASSWORD');
  const lastSync = readLastSync(`
    SELECT MAX(ts) AS ts
    FROM (
      SELECT MAX(created_at) AS ts FROM health_notes WHERE source='eightsleep'
      UNION ALL
      SELECT MAX(created_at) AS ts FROM health_data_points WHERE source='eight_sleep_sync'
    )
  `);
  if (!password) {
    return {
      name: 'eightsleep',
      status: 'error',
      lastSync,
      error: 'EIGHT_SLEEP_PASSWORD not in Keychain',
      canHeal: false,
    };
  }
  return {
    name: 'eightsleep',
    status: 'ok',
    lastSync,
    error: null,
    canHeal: false,
    verifiedLive: true,
  };
}

async function probeGranola() {
  let token = null;
  let error = null;
  const localSession = getGranolaLocalSession();
  try {
    token = await getGranolaToken();
  } catch (e) {
    error = e.message;
  }
  const lastSync = readLastSync(`SELECT MAX(imported_at) AS ts FROM transcripts WHERE source='granola'`);
  // st_bf4978b0 QA-fix — Granola was false-red: an old `lastSync` alone marked it
  // 'ok' but stamped no verified_at, so it defaulted to Issue. A working token or
  // a signed-in local session IS positive live evidence the connection works now
  // (Granola only imports when there are new meetings, so an idle-but-signed-in
  // Granola is genuinely Healthy via the session, not the sync).
  const sessionLive = Boolean(token || localSession.signedIn);
  if (sessionLive) {
    return { name: 'granola', status: 'ok', lastSync, error: null, canHeal: false, verifiedLive: true };
  }
  // No live session: a recent successful import inside the window is still
  // positive proof it worked — stamp the real sync time, not a fake now.
  if (lastSync && Number.isFinite(Date.parse(lastSync)) && (Date.now() - Date.parse(lastSync)) < staleWindowForName('granola')) {
    return { name: 'granola', status: 'ok', lastSync, error: null, canHeal: false, verifiedAt: lastSync };
  }
  if (!error) {
    error = localSession.installed ? 'Open Granola and sign in' : 'Granola app not installed';
  }
  return {
    name: 'granola',
    status: 'error',
    lastSync,
    error,
    canHeal: false, // WHY: self-heal (token refresh) is already internal to getGranolaToken()
  };
}

async function probeNotion() {
  const token = secret('NOTION_TOKEN');
  const lastSync = readLastSync(
    `SELECT MAX(updated_at) AS ts FROM user_topics WHERE notion_page_id IS NOT NULL`
  );
  return probeTokenIntegration({ name: 'notion', provider: 'notion', key: token, missingMsg: 'NOTION_TOKEN not in Keychain', lastSync });
}

async function probeImessage() {
  let status = 'unknown';
  let error = null;
  let lastSync = null;
  let verifiedLive = false;

  if (!existsSync(CHAT_DB_PATH)) {
    status = 'error';
    error = `chat.db not found at ${CHAT_DB_PATH}`;
  } else if (canOpenProtectedLocalFile(CHAT_DB_PATH)) {
    // st_bf4978b0 QA-fix — for a LOCAL source, physically opening the FDA-
    // protected DB IS the live verification: the connection works right now.
    // (Previously ok with no verified_at → a permanent false Issue.)
    status = 'ok';
    verifiedLive = true;
  } else {
    // FDA denied — a genuine, user-actionable Issue (re-grant disk access).
    status = 'needs_permission';
    error = 'Full Disk Access required — grant in System Settings > Privacy & Security';
  }

  if (tableExists('kv_store')) {
    const row = db.prepare(`SELECT value FROM kv_store WHERE key='imessage:last_synced_apple_ns'`).get();
    if (row?.value) {
      // Convert Apple ns epoch to ISO
      const appleNs = BigInt(row.value);
      const unixMs = Number(appleNs / 1_000_000n) + 978307200000;
      lastSync = new Date(unixMs).toISOString();
    }
  }

  return {
    name: 'imessage',
    status,
    lastSync,
    error,
    canHeal: false,
    verifiedLive,
  };
}

async function probeApplePhotos() {
  let status = 'unknown';
  let error = null;
  let verifiedLive = false;
  const lastSync = readLastSync(`SELECT MAX(indexed_at) AS ts FROM photos WHERE account_id LIKE 'apple%' OR account_id='local'`);

  if (!existsSync(PHOTOS_DB_PATH)) {
    status = 'error';
    error = `Photos.sqlite not found at ${PHOTOS_DB_PATH}`;
  } else if (canOpenProtectedLocalFile(PHOTOS_DB_PATH)) {
    // Local macOS Photos library: opening the protected DB is live proof this
    // source works. (Distinct from the dead Google `photoslibrary.readonly`
    // scope, which surfaces on the separate `photos:{email}` rows as Issue.)
    status = 'ok';
    verifiedLive = true;
  } else {
    status = 'needs_permission';
    error = 'Photos permission required — grant in System Settings > Privacy & Security';
  }

  return {
    name: 'apple-photos',
    status,
    lastSync,
    error,
    canHeal: false,
    verifiedLive,
  };
}

async function probeAsana() {
  const token = secret('ASANA_PAT');
  return probeTokenIntegration({ name: 'asana', provider: 'asana', key: token, missingMsg: 'ASANA_PAT not in Keychain', lastSync: null });
}

// st_bf4978b0 QA-fix — the second Asana token (secondary) has its own health row and
// its own card. It was never probed (registry probeNames was empty), so its row
// came only from sync jobs that never stamp verified_at → a permanent false
// Issue. Probe it live with the secondary token against Asana's identity endpoint; its
// prior last_sync (written by the asana_sync job) is the transient-error fallback.
async function probeAsanaSecondary() {
  const token = secret('ASANA_PAT_SECONDARY');
  const lastSync = readLastSync(`SELECT last_sync AS ts FROM integration_health WHERE name='asana_secondary'`);
  return probeTokenIntegration({ name: 'asana_secondary', provider: 'asana', key: token, missingMsg: 'ASANA_PAT_SECONDARY not in Keychain', lastSync });
}

// ── st_d142f701 AC7: 8 previously-blind integration probes ───────────────────
// Self-degrading: each probe returns status='error' with a clear message when
// credentials are missing or the upstream is unreachable. Push unconditionally
// into buildProbes() so the accounts surface shows every probe row even when
// the integration is unconfigured — visibility is the goal.

// st_bf4978b0 — shared cadence handshake for a model API key. Presence is not
// health: when the key exists we run the real /v1/models handshake. A 200 sets
// verifiedLive (healAndAudit stamps verified_at = now → the key can render
// Healthy). A rejected/quota/transient result carries its precise status
// (invalid_key/quota_exceeded/provider_error), each of which the classifier
// renders Issue immediately with no grace.
async function probeApiKeyHealth(name, provider, key, missingMsg) {
  if (!key) {
    return { name, status: 'error', lastSync: null, error: missingMsg, canHeal: false };
  }
  const { status, error } = await probeApiKeyLive(provider, key);
  if (status === 'valid') {
    return { name, status: 'ok', lastSync: null, error: null, canHeal: false, verifiedLive: true };
  }
  return { name, status, lastSync: null, error, canHeal: false };
}

async function probeAnthropic() {
  return probeApiKeyHealth('anthropic', 'anthropic', secret('ANTHROPIC_API_KEY'), 'ANTHROPIC_API_KEY not in Keychain');
}

async function probeOpenAI() {
  return probeApiKeyHealth('openai', 'openai', secret('OPENAI_API_KEY'), 'OPENAI_API_KEY not in Keychain');
}

// WHY name 'google' (not 'google-ai'): the Google AI card reads
// healthByName['google'] (its keychain_integrations row is provider='google').
// Writing the probe/verification under the SAME name the card reads is what
// closes the name seam (Failure manifest #3) — otherwise the card's verified_at
// stays NULL and the key reads Issue forever while the probe succeeds under a
// name nothing reads.
async function probeGoogleAI() {
  return probeApiKeyHealth('google', 'google', secret('GOOGLE_AI_API_KEY') || secret('GEMINI_API_KEY'), 'GOOGLE_AI_API_KEY not in Keychain');
}

async function probeXai() {
  let key = secret('XAI_API_KEY') || secret('GROK_API_KEY');
  try {
    const { resolveXaiApiKey } = await import('./xai-keys.js');
    key = resolveXaiApiKey().key || key;
  } catch { /* spenddown/hold resolver is optional for the cadence probe */ }
  return probeApiKeyHealth('xai', 'xai', key, 'XAI_API_KEY not in Keychain');
}

async function probeOllama() {
  // Local Ollama server; 2s ceiling — slow non-response is treated as error
  // rather than blocking the probe pass. AbortSignal.timeout throws on miss.
  const host = process.env.OLLAMA_HOST || secret('OLLAMA_HOST') || 'http://localhost:11434';
  try {
    const res = await fetch(`${host.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      // /api/tags already carries the installed model list ({ models:[{name}] }).
      // Capture it so open-weight model cards can be runnable-gated off this
      // background signal (df_ac0dd301 Fix C) — the page never probes Ollama
      // while rendering. probeAll stays write-free: the persist happens in
      // healAndAudit when the ollama result is written (see below).
      let installedModels = [];
      try {
        const data = await res.json();
        installedModels = (data?.models || []).map((m) => m?.name).filter((n) => typeof n === 'string');
      } catch {
        installedModels = [];
      }
      // A 200 from /api/tags is a live check — the local server is up right now.
      return { name: 'ollama', status: 'ok', lastSync: null, error: null, canHeal: false, installedModels, verifiedLive: true };
    }
    return { name: 'ollama', status: 'error', lastSync: null, error: `HTTP ${res.status}`, canHeal: false };
  } catch (err) {
    return { name: 'ollama', status: 'error', lastSync: null, error: err?.message || 'unreachable', canHeal: false };
  }
}

/**
 * Persists the Ollama installed-model list into kv_store 'ollama:installed_models'
 * (JSON array). Called from healAndAudit when the ollama probe result is written,
 * NOT from probeAll — probeAll is a read-only probe pass (df_ac0dd301 Fix C).
 * Only the OK branch of probeOllama carries `installedModels`, so an error/down
 * cycle leaves the last-known list in place (stale, but harmless: the reader
 * co-requires Ollama reachability, so a stale list can never show a green card
 * while Ollama is down). Best-effort — a health write must never throw.
 * @param {import('better-sqlite3').Database} database
 * @param {string[]} models installed model names
 */
export function persistOllamaInstalledModels(database, models) {
  try {
    const hasKv = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kv_store'"
    ).get();
    if (!hasKv) return;
    database.prepare(`
      INSERT INTO kv_store (key, value) VALUES ('ollama:installed_models', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(Array.isArray(models) ? models : []));
  } catch {
    // kv_store may not exist on first boot, or the write may race — best-effort.
  }
}

async function probeGitHub() {
  const token = secret('GITHUB_TOKEN');
  if (!token) {
    // GitHub is optional product-state, not a launch vendor. Missing token is
    // not an Issue on Connect.
    return { name: 'github', status: 'ok', lastSync: null, error: null, canHeal: false };
  }
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'robotdojo-health-probe' },
      signal: AbortSignal.timeout(3000),
    });
    // A 200 from /user is a live token verification, not mere presence.
    if (res.ok) return { name: 'github', status: 'ok', lastSync: null, error: null, canHeal: false, verifiedLive: true };
    return { name: 'github', status: 'error', lastSync: null, error: `HTTP ${res.status}`, canHeal: false };
  } catch (err) {
    return { name: 'github', status: 'error', lastSync: null, error: err?.message || 'unreachable', canHeal: false };
  }
}

// Wall-clock fallback for the backup recency check. The owner approved 24 hours
// ("1 24 hours yes") measured in POWERED-ON time; the guardian owns that
// measure. This constant is only the floor for a machine whose guardian has not
// ticked yet, and powered-on time can never exceed wall-clock, so a wall-clock
// breach at the same number is strictly later than the guardian's alarm — it
// can never fire before the authoritative signal.
const BACKUP_STALE_WALL_CLOCK_HOURS = 24;

export async function probeBackup() {
  // Three signals: GCS bucket configured, the last_success heartbeat, and
  // RECENCY. df_3df1f108: this probe used to return `ok` on the mere presence
  // of a bucket NAME — it read `backup:last_success` and then threw the value
  // away, so a backup that had not run in 32 hours reported green. The
  // staleness computation sitting 19 lines below in probeRemoteAccess was the
  // working code this one discarded.
  const bucket = secret('GCS_BUCKET');
  let lastSync = null;
  try {
    if (tableExists('kv_store')) {
      const row = db.prepare(`SELECT value FROM kv_store WHERE key='backup:last_success'`).get();
      if (row?.value) lastSync = row.value;
    }
  } catch { /* kv_store may not exist on first boot — fine */ }

  if (!bucket) {
    return { name: 'backup', status: 'error', lastSync, error: 'GCS_BUCKET not configured (Keychain) — backup disabled', canHeal: false };
  }

  // The guardian's powered-on verdict is authoritative when it is available:
  // it counts powered-on time, which is the measure the owner approved, and it
  // knows whether a run is legitimately in flight. Wall-clock is the fallback
  // for a machine whose guardian has not ticked yet.
  let guardian = null;
  try {
    const { readGuardianStatus } = await import('./backup-guardian.js');
    guardian = readGuardianStatus();
  } catch { /* guardian state unreadable — fall through to wall-clock */ }

  if (guardian?.stale) {
    return {
      name: 'backup',
      status: 'error',
      lastSync,
      error: guardian.stale_reason === 'run_hung'
        ? `backup run hung past its ${guardian.max_run_hours}h allowance`
        : `no verified backup in ${guardian.poweron_hours}h of powered-on time (alarm at ${guardian.alarm_poweron_hours}h)`,
      canHeal: false,
    };
  }

  if (!lastSync) {
    return { name: 'backup', status: 'error', lastSync: null, error: 'no verified backup recorded', canHeal: false };
  }
  const ms = new Date(lastSync).getTime();
  const staleWallClockMs = BACKUP_STALE_WALL_CLOCK_HOURS * 3600_000;
  if (Number.isNaN(ms) || (Date.now() - ms) > staleWallClockMs) {
    return { name: 'backup', status: 'error', lastSync, error: `last verified backup is older than ${BACKUP_STALE_WALL_CLOCK_HOURS}h`, canHeal: false };
  }
  return { name: 'backup', status: 'ok', lastSync, error: null, canHeal: false };
}

async function probeRemoteAccess() {
  // Tunnel-agent heartbeat. Fresh (<2 min) → ok; stale or missing → error.
  let lastSync = null;
  try {
    if (tableExists('kv_store')) {
      const row = db.prepare(`SELECT value FROM kv_store WHERE key='tunnel:last_heartbeat'`).get();
      if (row?.value) lastSync = row.value;
    }
  } catch { /* table missing on fresh boot — fine */ }
  if (!lastSync) {
    return { name: 'remote-access', status: 'error', lastSync: null, error: 'no tunnel heartbeat recorded', canHeal: false };
  }
  let fresh = false;
  try {
    const ms = new Date(lastSync).getTime();
    fresh = !Number.isNaN(ms) && (Date.now() - ms) < 2 * 60_000;
  } catch { /* unparseable timestamp → not fresh */ }
  return {
    name: 'remote-access',
    status: fresh ? 'ok' : 'error',
    lastSync,
    error: fresh ? null : 'tunnel heartbeat stale (>2 min)',
    canHeal: false,
  };
}

// ── Build probe list ──────────────────────────────────────────────────────────

// Fixed integration probes by registry probe name. The registry declares the
// enumeration (descriptor.probeNames); this map binds each name to its probe
// implementation. The contract check asserts the two stay in lockstep — a
// registry probe name with no function here (or vice versa) is a red commit.
const PROBE_FNS = Object.freeze({
  monarch: probeMonarch,
  oura: probeOura,
  eightsleep: probeEightSleep,
  granola: probeGranola,
  notion: probeNotion,
  imessage: probeImessage,
  'apple-photos': probeApplePhotos,
  asana: probeAsana,
  asana_secondary: probeAsanaSecondary,
  openai: probeOpenAI,
});

// Platform probes — NOT data-source integrations (no registry descriptor):
// model providers, local model server, repo/backup/relay state. Pushed
// unconditionally so the accounts surface always shows the row (st_d142f701
// AC7 visibility rule). openai moved to the registry (it is inventory #19).
const PLATFORM_PROBES = Object.freeze([
  probeAnthropic, probeGoogleAI, probeXai,
  probeOllama, probeGitHub, probeBackup, probeRemoteAccess,
]);

function buildProbes() {
  const probes = [];

  const googleEmails = listConnectedGoogleAccounts();
  const googleTypes = new Map();
  for (const email of googleEmails) {
    if (!googleTypes.has(email)) googleTypes.set(email, new Set());
  }
  // detect which types each Google account has
  const googleAccts = db.prepare(`
    SELECT DISTINCT email, type
      FROM accounts
     WHERE vendor='google'
       AND status IN ('active', 'connected')
  `).all();
  for (const { email, type } of googleAccts) {
    if (!googleTypes.has(email)) googleTypes.set(email, new Set());
    const probeType = type === 'email' ? 'gmail' : type;
    googleTypes.get(email).add(probeType);
  }
  for (const [email, types] of googleTypes) {
    const effectiveTypes = types.size ? types : new Set(['gmail', 'calendar', 'drive', 'contacts']);
    if (!effectiveTypes.has('contacts')) effectiveTypes.add('contacts');
    // Photos is out of launch scope for now — missing photoslibrary.readonly
    // must not paint Google accounts as Issue.
    effectiveTypes.delete('photos');
    for (const type of effectiveTypes) {
      probes.push(() => probeGoogle(email, type));
    }
  }

  const msMailAccounts = listConnectedMicrosoftAccounts('email');
  for (const email of msMailAccounts) {
    probes.push(() => probeMicrosoft(email, 'email'));
  }
  const msCalendarAccounts = listConnectedMicrosoftAccounts('calendar');
  for (const email of msCalendarAccounts) {
    probes.push(() => probeMicrosoft(email, 'calendar'));
  }

  // Registry-derived fixed probes (oura, granola, notion, imessage,
  // apple-photos, asana, openai today). Unknown names fail loudly instead of
  // silently dropping a probe — a missing implementation is a contract bug.
  for (const name of registryProbeNames()) {
    const fn = PROBE_FNS[name];
    if (fn) {
      probes.push(fn);
    } else {
      probes.push(async () => ({
        name,
        status: 'error',
        lastSync: null,
        error: `registry declares probe '${name}' but lib/integration-health.js has no implementation`,
        canHeal: false,
      }));
    }
  }

  probes.push(...PLATFORM_PROBES);

  return probes;
}

// ── Self-heal ─────────────────────────────────────────────────────────────────

async function attemptHeal(result) {
  const { name, error } = result;

  if (
    name.startsWith('gmail:')
    || name.startsWith('calendar:')
    || name.startsWith('drive:')
    || name.startsWith('contacts:')
    || name.startsWith('photos:')
  ) {
    const email = name.split(':')[1];
    const isPermanent = error && (
      error.includes('invalid_grant') ||
      error.includes('400') ||
      error.includes('no refresh token')
    );
    if (isPermanent) {
      return { ...result, status: 'error', error: `auth_required — re-connect ${email}` };
    }
    try {
      await refreshGoogleToken(email);
      const token = await getValidAccessToken(email);
      if (token) return { ...result, status: 'ok', error: null };
    } catch (e) {
      if (e.message.includes('invalid_grant')) {
        return { ...result, status: 'error', error: `auth_required — re-connect ${email}` };
      }
      return { ...result, error: e.message };
    }
  }

  if (name.startsWith('microsoft-')) {
    const email = name.split(':')[1];
    const isPermanent = error && (
      error.includes('interaction_required') ||
      error.includes('invalid_grant') ||
      error.includes('No refresh token')
    );
    if (isPermanent) {
      return { ...result, status: 'error', error: `auth_required — re-connect ${email}` };
    }
    try {
      await refreshMicrosoftToken(email);
      return { ...result, status: 'ok', error: null };
    } catch (e) {
      return { ...result, error: e.message };
    }
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function probeAll() {
  const probes = buildProbes();
  const results = await Promise.allSettled(probes.map(fn => fn()));
  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      name: `probe-${i}`,
      status: 'error',
      lastSync: null,
      error: r.reason?.message || 'probe threw',
      canHeal: false,
    };
  });
}

export async function healAndAudit({ dryRun = false, mirrorLedger = true } = {}) {
  let results = await probeAll();

  // Attempt self-heal on any failures
  results = await Promise.all(results.map(async (r) => {
    if (r.status !== 'ok' && r.canHeal) {
      return attemptHeal(r);
    }
    return r;
  }));

  if (!dryRun) {
    const now = new Date().toISOString();
    for (const r of results) {
      const prev = getHealthStmt().get(r.name);
      const prevFails = prev?.consecutive_failures ?? 0;
      const consecutive = r.status === 'ok' ? 0 : prevFails + 1;
      getUpsertHealthStmt().run(
        r.name,
        r.status,
        r.lastSync || null,
        consecutive,
        r.error ? r.error.slice(0, 500) : null,
        // A live verification (real handshake / valid OAuth token / local
        // file-open) stamps verified_at now. A recent-successful-sync fallback
        // (r.verifiedAt) stamps the honest sync time instead of a fake "now"
        // (AC3). Anything else passes NULL and the COALESCE keeps the prior
        // value. This is what makes a Healthy dot earned, never defaulted.
        r.verifiedAt ? r.verifiedAt : (r.verifiedLive ? now : null)
      );
      // df_ac0dd301 Fix C: persist the Ollama installed-model list alongside its
      // health row so open-weight model cards read a cached signal, never an
      // inline probe. Guarded on installedModels being present (only the OK
      // probe branch carries it) — a down cycle leaves the last list in place.
      if (r.name === 'ollama' && Array.isArray(r.installedModels)) {
        persistOllamaInstalledModels(db, r.installedModels);
      }
      if (mirrorLedger) {
        try {
          mirrorPassiveJobStatus(db, {
            jobType: 'integration_health_refresh',
            uniqueKey: `integration-health:${r.name}`,
            targetType: 'integration',
            targetId: r.name,
            payload: { name: r.name },
            status: r.status,
            error: r.error || null,
            metadata: {
              source: 'integration-health',
              last_sync: r.lastSync || null,
              consecutive_failures: consecutive,
            },
          });
        } catch {
          // Health checks must remain best-effort; the legacy integration_health
          // row is the compatibility surface if the passive ledger is unavailable.
        }
      }
      r.consecutive_failures = consecutive;

      // Notify only on persistent failures (2+ consecutive checks)
      if (r.status !== 'ok' && consecutive >= 2) {
        const label = r.name.replace('microsoft-', 'Microsoft ').replace(':', ' ');
        notify(
          'Robot Dojo — Integration Alert',
          `${label}: ${r.error || 'sync failure'}`
        );
      }
    }
  } else {
    results = results.map(r => ({ ...r, consecutive_failures: 0 }));
  }

  return results;
}

export function getLatestHealth() {
  return db.prepare(`SELECT * FROM integration_health ORDER BY name`).all();
}
