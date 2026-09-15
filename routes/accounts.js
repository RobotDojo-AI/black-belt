/**
 * Accounts & Identity API — account management, imports, LLM providers, identity files.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMailboxAccounts, setAccountTopic } from '../lib/account-topic.js';
import { Hono } from 'hono';
import db from '../lib/db.js';
import config, { overrideSecret, secret } from '../lib/config.js';
import { mintAuthToken } from '../lib/auth.js';
import { MODELS } from '../lib/compute-tier.js';
import {
  getKeychainIntegrationByProvider,
  insertUserIntegration,
  getKeychainKeyByProvider,
  listIntegrationHealth,
  listKeychainIntegrationsBySection,
  getGoogleAccountEmails,
  getGoogleAccountRows,
  getGoogleEmailCount,
  getGoogleCalendarCount,
  getGoogleDriveCount,
  getGooglePhotosCount,
  getGoogleContactsCount,
  getMicrosoftEmailCount,
  getMicrosoftCalendarCount,
  getImessageCount,
  getContactsCount,
  getApplePhotosCount,
  getAppleCalendarCount,
  getGranolaCount,
  getNotionChunkCount,
  getAsanaChunkCount,
  listAdvertisableAccounts,
  listGoogleAccountSummaries,
  listMicrosoftAccountSummaries,
  setAccountCredentialStatus,
  listUserIds,
  getImportsSnapshotFreshness,
  listImportsSnapshot,
  listDropFolderImportRows,
  listAccountsWithKeychainKey,
  getHealthDocCount,
  getSpend30dByProvider,
  getRobotDojoCountSnapshot,
  getAccountStatusByEmail,
  listImportedEmailAccounts,
  upsertIntegrationHealth,
  countHealthDataPoints,
  countHealthNotes,
  latestHealthDataPointTimestamp,
  countDistinctHealthIngestionDocs,
  maxHealthIngestionTimestamp,
  OPEN_WEIGHT_MODEL_FAMILIES,
  isOpenWeightModelRunnable,
} from '../lib/accounts-queries.js';
import { getAboutInfo } from '../lib/about.js';
import { getAgentsMdForFrontend } from '../lib/agents-md-queries.js';
import { getPersonaSyncTargets, setPersonaSyncTarget } from '../lib/persona-sync.js';
import { getMemoryPrompt } from '../lib/memory-prompt.js';
import { getInviteTargets } from '../lib/invite-targets-queries.js';
import { applyLaunchContract, findLaunchIntegration, normalizeLaunchCard, isLaunchHiddenProvider } from '../lib/launch-integrations.js';
import { buildImportsEnvelope } from '../lib/imports-envelope.js';
import { backgroundStateFromHealth, queueIntegrationJobs, queueOAuthSync, recordIntegrationJobHealth } from '../lib/oauth-sync-queue.js';
import { probeApiKeyLive, hasLiveProbe } from '../lib/api-key-probe.js';
import { recordLiveVerification, freshestHealthyChildVerifiedAt } from '../lib/integration-status.js';
import { getPassiveJobSummary } from '../lib/passive-jobs.js';
import { destroySessionsForUser } from '../lib/session.js';
import { upsertMicrosoftAccounts } from '../lib/oauth-queries.js';
import {
  getClientCredentialsToken,
  getMicrosoftAppRoles,
  listConnectedMicrosoftAccounts,
  microsoftRolesSupport,
} from '../lib/microsoft-oauth.js';
import { getCachedPermissions } from '../lib/macos-permissions.js';
import {
  deleteKeychainSecret,
  readKeychainSecret,
  writeKeychainSecret,
} from '../lib/keychain.js';
import { accountPersonaCards } from '../lib/account-personas.js';
import { PERSONA_ORDER } from '../lib/agent-personas.js';
import { openEditTarget } from '../lib/accounts-open-target.js';
import { openApp, openSettingsPane } from '../lib/accounts-open-app.js';
import { AGENT_SKILLS_DIR, USER_DATABASES_DIR, USER_MEMORY_DIR, USER_PROFILE_PATH, USER_TRANSCRIPTS_DIR } from '../lib/robotdojo-paths.js';
import { GOOGLE_DRIVE_FULL_HISTORY_SCOPE, GOOGLE_PHOTOS_READONLY_SCOPE } from '../lib/google-scopes.js';

const routes = new Hono();

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_FORK_STATUS = { status: 'forked', label: 'Forked' };
const FORK_STATUS_TTL_MS = 5 * 60 * 1000;
let forkStatusCache = { value: DEFAULT_FORK_STATUS, expiresAt: 0, refreshing: false };

function getForkStatus() {
  if (Date.now() < forkStatusCache.expiresAt) return forkStatusCache.value;
  refreshForkStatus();
  return forkStatusCache.value;
}

function execGit(args) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout || '').trim());
    });
  });
}

function refreshForkStatus() {
  if (forkStatusCache.refreshing) return;
  forkStatusCache.refreshing = true;
  Promise.all([
    execGit(['remote', 'get-url', 'origin']),
    execGit(['rev-parse', '--abbrev-ref', 'HEAD']),
    execGit(['status', '--porcelain']),
  ]).then(([origin, branch, status]) => {
    if (!origin || !branch) {
      forkStatusCache.value = DEFAULT_FORK_STATUS;
      forkStatusCache.expiresAt = Date.now() + 30_000;
      return;
    }
    const dirty = String(status || '').length > 0;
    const officialOrigin = /github\.com[:/]RobotDojo-AI\/black-belt(?:\.git)?$/i.test(origin);
    const forked = dirty || branch !== 'main' || !officialOrigin;
    forkStatusCache.value = {
      status: forked ? 'forked' : 'not_forked',
      label: forked ? 'Forked' : 'Not Forked',
    };
    forkStatusCache.expiresAt = Date.now() + FORK_STATUS_TTL_MS;
  }).catch(() => {
    forkStatusCache.value = DEFAULT_FORK_STATUS;
    forkStatusCache.expiresAt = Date.now() + 30_000;
  }).finally(() => {
    forkStatusCache.refreshing = false;
  });
}

function safeReadText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function extractBullets(content, labels) {
  const text = String(content || '');
  return labels.map((label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`^[-*]\\s*\\*\\*${escaped}:\\*\\*\\s*(.+)$`, 'mi'));
    return match ? `- **${label}:** ${match[1].trim()}` : '';
  }).filter(Boolean);
}

function profileDefaultsFromUserMd() {
  const text = safeReadText(USER_PROFILE_PATH);
  const readField = (label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^[-*]\\s*\\*\\*${escaped}:\\*\\*\\s*(.+)$`, 'mi');
    const hit = text.match(re);
    return hit ? hit[1].trim() : '';
  };
  return {
    name: readField('Name'),
    display_name: readField('Call User') || readField('Display Name') || readField('Name'),
  };
}

function providerFromChatSource(source) {
  const s = String(source || '').toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku/.test(s)) return 'anthropic';
  if (/gpt|openai|chatgpt|research|o1|o3|o4/.test(s)) return 'openai';
  if (/gemini|google/.test(s)) return 'google';
  if (/grok|xai/.test(s)) return 'xai';
  if (/ollama|llama|qwen|mistral/.test(s)) return 'ollama';
  return null;
}

function chatTranscriptMetaFromFile(path) {
  const name = String(path || '').split('/').pop() || '';
  let source = name.match(/^\d{4}-\d{2}-\d{2}-\d{4}-([a-z0-9]+)-/i)?.[1] || '';
  let id = '';
  try {
    const head = readFileSync(path, 'utf8').slice(0, 1200);
    const sourceMatch = head.match(/^source:\s*"?([^"\n]+)"?/mi);
    if (sourceMatch?.[1]) source = sourceMatch[1].trim();
    const idMatch = head.match(/^id:\s*"?([^"\n]+)"?/mi);
    if (idMatch?.[1]) id = idMatch[1].trim();
  } catch { /* ignore unreadable transcript */ }
  return { id, source };
}

function listMarkdownFiles(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      listMarkdownFiles(path, out);
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

function addChatImportRef(byProvider, provider, ref) {
  if (!provider) return;
  const stableRef = String(ref || '').trim();
  if (!stableRef) return;
  if (!byProvider.has(provider)) byProvider.set(provider, new Set());
  byProvider.get(provider).add(stableRef);
}

function chatTranscriptRefsByProvider() {
  const shouldScan = process.env.ROBOTDOJO_INTEGRATION_CARDS_SCAN_TRANSCRIPTS === '1';
  if (!shouldScan) return new Map();
  const chatDir = resolve(USER_TRANSCRIPTS_DIR, 'chat');
  const refs = new Map();
  for (const file of listMarkdownFiles(chatDir)) {
    const meta = chatTranscriptMetaFromFile(file);
    const provider = providerFromChatSource(meta.source) || 'unknown';
    addChatImportRef(refs, provider, meta.id ? `conversation:${meta.id}` : `file:${file}`);
  }
  return refs;
}

function dbChatImportRefsByProvider(database) {
  const refs = new Map();
  let rows = [];
  try {
    rows = database.prepare(`
      SELECT c.id, c.model, je.value AS tag
      FROM conversations c, json_each(c.tags) je
      WHERE je.value LIKE 'import-%'
        AND c.deleted_at IS NULL
    `).all();
  } catch {
    return refs;
  }
  for (const row of rows) {
    const tag = String(row.tag || '').replace(/^import-/, '');
    const provider = providerFromChatSource(`${tag} ${row.model || ''}`) || 'unknown';
    addChatImportRef(refs, provider, `conversation:${row.id}`);
  }
  return refs;
}

function llmImportCountsByProvider(snapshotRows = []) {
  const byProvider = new Map();
  for (const row of snapshotRows) {
    if (row.import_type !== 'llm') continue;
    const label = row.source_label || row.account_key || row.vendor || 'LLM import';
    const provider = providerFromChatSource(`${label} ${row.vendor || ''}`);
    if (!provider) continue;
    const count = Number(row.item_count) || 0;
    if (count <= 0) continue;
    byProvider.set(provider, (byProvider.get(provider) || 0) + count);
  }
  return byProvider;
}

function chatImportCountsByProvider(database, snapshotRows = []) {
  const refs = chatTranscriptRefsByProvider();
  for (const [provider, dbRefs] of dbChatImportRefsByProvider(database)) {
    for (const ref of dbRefs) addChatImportRef(refs, provider, ref);
  }

  const counts = new Map([...refs.entries()].map(([provider, set]) => [provider, set.size]));
  for (const [provider, snapshotCount] of llmImportCountsByProvider(snapshotRows)) {
    counts.set(provider, Math.max(counts.get(provider) || 0, snapshotCount));
  }
  return counts;
}

function parseAccountMetadata(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function googleScopesForAccountRow(row) {
  const metadata = parseAccountMetadata(row?.metadata);
  const raw = metadata.google_oauth_scopes || metadata.oauth_scopes || metadata.scopes || [];
  const scopes = Array.isArray(raw) ? raw
    : typeof raw === 'string' ? raw.split(/\s+/)
      : [];
  return new Set(scopes.map((scope) => String(scope).trim()).filter(Boolean));
}

function missingGoogleScopeState(row, requiredScope, label) {
  if (!row) return null;
  const scopes = googleScopesForAccountRow(row);
  if (scopes.size === 0) return null;
  if (scopes.has(requiredScope)) return null;
  return {
    state: 'needs_oauth',
    error: `Re-auth Google to grant ${label}.`,
  };
}

// st_4e7e3aaf AC9 — list visible build-pipeline skills. SKILL.md content is
// returned untruncated so the Skills wiki page renders the full file. The
// hand-tuned 5000-char cap that used to live here cut content mid-sentence.
function listSkillTargets() {
  const skillsRoot = AGENT_SKILLS_DIR;
  const visible = new Set(['goal', 'defect', 'story', 'work', 'framing', 'research', 'scope', 'plan', 'build', 'qa', 'close']);
  const order = ['goal', 'defect', 'story', 'work', 'framing', 'research', 'scope', 'plan', 'build', 'qa', 'close'];
  const out = [];
  try {
    for (const name of readdirSync(skillsRoot)) {
      if (!visible.has(name)) continue;
      const p = resolve(skillsRoot, name, 'SKILL.md');
      if (!existsSync(p)) continue;
      const st = statSync(p);
      if (!st.isFile()) continue;
      out.push({
        id: `skill:${name}`,
        label: name,
        path: `agents/skills/${name}/SKILL.md`,
        preview: safeReadText(p),
      });
    }
  } catch { /* no skills dir */ }
  return out.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}

// st_4e7e3aaf AC9 — Agents now renders six per-persona cards via the
// /api/accounts/agent-personas route, not as an editTarget. The legacy
// root agents-file target is removed; persona files are opened individually
// through the same source-file allowlist as Skills and You.
function editTargetMap() {
  const map = new Map();
  const add = (id, label, relPath) => {
    const path = resolve(ROOT, relPath);
    map.set(id, { id, label, path, relPath, content: safeReadText(path) });
  };
  for (const name of PERSONA_ORDER) {
    add(`agent:${name.toLowerCase()}`, name, `agents/personas/${name}.md`);
  }
  add('you:user', 'You', 'user/workbenches/user/wk_user/USER.md');
  for (const t of listSkillTargets()) {
    map.set(t.id, { id: t.id, label: t.label, path: resolve(ROOT, t.path), relPath: t.path, content: safeReadText(resolve(ROOT, t.path)) });
  }
  return map;
}

// st_4e7e3aaf AC9 — preview is now the raw file content (no synthesis,
// no truncation). The frontend renders it with marked.js + DOMPurify so
// the user sees the wiki/markdown they would edit, not a fabricated summary.
function editTargetsPayload() {
  const map = editTargetMap();
  const target = (id) => {
    const t = map.get(id);
    if (!t) return null;
    return { id: t.id, label: t.label, path: t.relPath, preview: t.content };
  };
  return {
    you: { targets: [target('you:user')].filter(Boolean) },
    skills: { targets: listSkillTargets() },
  };
}

function toDashboardCounts(counts = {}) {
  const chat = Number(counts.chat || counts.transcripts || 0);
  const email = Number(counts.email || 0);
  const contacts = Number(counts.contacts || 0);
  const calendar = Number(counts.calendar || 0);
  const sms = Number(counts.sms || counts.messages || 0);
  const photos = Number(counts.photos || 0);
  const health = Number(counts.health || 0);
  const known = chat + email + contacts + calendar + sms + photos + health;
  const total = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
  return { chat, email, contacts, calendar, sms, photos, health, other: Math.max(0, total - known) };
}

function dashboardFromIntegrationCards(payload) {
  const updatedAt = payload?.count_snapshot?.updatedAt || new Date().toISOString();
  const groups = [];
  if (payload?.robot_dojo?.rows?.length) {
    groups.push({
      id: 'robot_dojo',
      label: 'Robot Dojo',
      showAccount: false,
      rows: payload.robot_dojo.rows.map((r) => ({
        provider: r.provider,
        label: r.label,
        type: r.type,
        account: '',
        counts: r.counts,
        state: r.state || 'ready',
        lastSeenAt: r.lastSeenAt || updatedAt,
        recovery: r.recovery || '',
        action: { kind: 'none', status: 'ready' },
        spend30dUsd: null,
      })),
    });
  }
  for (const section of payload?.sections || []) {
    if (!['foundation_models', 'workspace', 'productivity', 'health', 'finances'].includes(section.id)) continue;
    groups.push({
      id: section.id,
      label: section.label,
      showAccount: section.id === 'workspace' || section.id === 'productivity' || section.id === 'finances',
      rows: (section.cards || []).map((card) => ({
        provider: card.provider,
        label: card.name || card.provider,
        type: card.substrate_type || card.auth || '',
        account: card.provider_identity?.account || '',
        counts: toDashboardCounts(card.artifact_counts_by_type || {}),
        state: card.connection_status || card.status || (card.connected ? 'connected' : 'ready'),
        lastSeenAt: card.last_seen_at || card.last_sync_at || card.last_sync || null,
        action: card.primary_action || { kind: 'none', status: card.connected ? 'connected' : 'ready' },
        spend30dUsd: typeof card.spend_30d_usd === 'number' ? card.spend_30d_usd : null,
      })),
    });
  }
  return {
    oneTimePrompt: { id: 'foundation-model-memory-prompt', dismissed: false },
    updatedAt,
    groups,
  };
}

// ─── Key Management ───────────────────────────────────────────────────────────

// WHY: KEY_MAP was a static object that required a code change + deploy to add
// a new provider. It has been replaced by the keychain_integrations DB table
// (migration 050). Adding a new integration = INSERT a row. No code change needed.

// WHY: Keychain reads shell out to /usr/bin/security — blocking the event loop
// for the duration of the subprocess. On repeated page loads these add up.
// A 60-second TTL covers the realistic session refresh cycle without risking stale credentials.
const keychainCache = new Map(); // key → { value, expiresAt }

function cachedKeychainRead(keychainKey) {
  const hit = keychainCache.get(keychainKey);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  let value = null;
  try { value = readKeychainSecret(keychainKey); } catch { value = null; }
  keychainCache.set(keychainKey, { value, expiresAt: Date.now() + 60_000 });
  return value;
}

function maskKey(key) {
  if (!key) return null;
  // Show only last 4 chars — never expose the full key to the frontend.
  return '***' + String(key).slice(-4);
}

// WHY centralized helper, not local shell strings: credentials must be looked up
// through one account-fallback policy everywhere or integrations drift.
function keychainRead(serviceName) {
  return readKeychainSecret(serviceName);
}

function keychainWrite(serviceName, value) {
  const ok = writeKeychainSecret(serviceName, value);
  // WHY: bust the cache immediately so integration-cards reflects the new key
  // without waiting for the 60-second TTL to expire.
  keychainCache.delete(serviceName);
  if (!String(serviceName).startsWith('robotdojo-')) keychainCache.delete(`robotdojo-${serviceName}`);
  return ok;
}

function normalizeProviderKey(provider) {
  const p = String(provider || '').trim().toLowerCase();
  return p === 'grok' ? 'xai' : p;
}

const PROVIDER_KEYCHAIN_ALIASES = Object.freeze({
  google: ['robotdojo-GOOGLE_AI_API_KEY', 'robotdojo-GOOGLE_API_KEY'],
  google_ai: ['robotdojo-GOOGLE_AI_API_KEY', 'robotdojo-GOOGLE_API_KEY'],
  xai: ['robotdojo-XAI_API_KEY', 'robotdojo-GROK_API_KEY'],
  grok: ['robotdojo-XAI_API_KEY', 'robotdojo-GROK_API_KEY'],
  notion: ['robotdojo-NOTION_TOKEN'],
  asana_secondary: ['robotdojo-ASANA_PAT_SECONDARY'],
});

function keychainServicesForProvider(provider, catalogKey = null) {
  const normalized = normalizeProviderKey(provider);
  const services = [
    catalogKey,
    ...(PROVIDER_KEYCHAIN_ALIASES[normalized] || []),
  ].filter(Boolean);
  return [...new Set(services.map((service) => String(service).startsWith('robotdojo-') ? String(service) : `robotdojo-${service}`))];
}

function envKeyForKeychainService(serviceName) {
  return String(serviceName || '')
    .replace(/^robotdojo-/i, '')
    .replace(/-/g, '_')
    .toUpperCase();
}

function readProviderKey(provider, catalogKey = null, { cached = false } = {}) {
  for (const service of keychainServicesForProvider(provider, catalogKey)) {
    const envValue = process.env[envKeyForKeychainService(service)];
    if (envValue) return envValue;
    const value = cached ? cachedKeychainRead(service) : keychainRead(service);
    if (value) return value;
  }
  return null;
}

function deleteProviderKeys(provider, catalogKey = null) {
  let ok = true;
  for (const service of keychainServicesForProvider(provider, catalogKey)) {
    ok = keychainDelete(service) && ok;
  }
  return ok;
}

function keychainDelete(serviceName) {
  const ok = deleteKeychainSecret(serviceName);
  // WHY: bust the cache so integration-cards shows disconnected immediately.
  keychainCache.delete(serviceName);
  if (!String(serviceName).startsWith('robotdojo-')) keychainCache.delete(`robotdojo-${serviceName}`);
  return ok;
}

const ACCOUNT_SECRET_ALLOWLIST = new Map([
  ['ANTHROPIC_API_KEY', 'Anthropic API key'],
  ['OPENAI_API_KEY', 'OpenAI API key'],
  ['SPEECHIFY_API_KEY', 'Speechify API key'],
  ['GOOGLE_AI_API_KEY', 'Google AI API key'],
  ['GOOGLE_API_KEY', 'Google API key'],
  ['GROK_API_KEY', 'Grok API key'],
  ['XAI_API_KEY', 'xAI API key'],
  ['OLLAMA_HOST', 'Ollama host'],
  ['MICROSOFT_TENANT_ID', 'Microsoft tenant ID'],
  ['MICROSOFT_CLIENT_ID', 'Microsoft client ID'],
  ['MICROSOFT_CLIENT_SECRET', 'Microsoft client secret'],
]);

function normalizeSecretKeyName(key) {
  const normalized = String(key || '')
    .trim()
    .replace(/^robotdojo-/i, '')
    .replace(/-/g, '_')
    .toUpperCase();
  return ACCOUNT_SECRET_ALLOWLIST.has(normalized) ? normalized : null;
}

function secretStatus(key) {
  const configured = !!secret(key);
  return {
    label: ACCOUNT_SECRET_ALLOWLIST.get(key) || key,
    configured,
    present: configured,
  };
}

const API_KEY_BACKGROUND_IMPORT_PROVIDERS = new Set(['asana', 'asana_secondary', 'oura']);

function queueApiKeyBackgroundImport(provider) {
  if (!API_KEY_BACKGROUND_IMPORT_PROVIDERS.has(provider)) {
    return { queued: 0, provider, jobs: [], names: [] };
  }
  return queueIntegrationJobs(db, provider);
}

function apiKeyLaunchState(provider, key, healthState) {
  if (!key) return 'needs_key';
  const normalized = normalizeProviderKey(provider);
  if (healthState && !(healthState === 'queued' && !API_KEY_BACKGROUND_IMPORT_PROVIDERS.has(normalized))) {
    return healthState;
  }
  return 'connected';
}

const LAUNCH_STATE_SEVERITY = new Map([
  ['failed', 100],
  ['needs_permission', 95],
  ['error_recoverable', 90],
  ['running', 80],
  ['importing', 75],
  ['queued', 70],
  ['partial', 65],
  ['paused', 60],
  ['needs_key', 50],
  ['needs_oauth', 50],
  ['ready', 10],
  ['done', 5],
  ['connected', 0],
]);

function strongestLaunchState(states = []) {
  return states
    .filter(Boolean)
    .sort((a, b) => (LAUNCH_STATE_SEVERITY.get(b) ?? -1) - (LAUNCH_STATE_SEVERITY.get(a) ?? -1))[0] || null;
}

function strongestStateSource(sources = []) {
  return sources
    .filter((source) => source?.state)
    .sort((a, b) => (LAUNCH_STATE_SEVERITY.get(b.state) ?? -1) - (LAUNCH_STATE_SEVERITY.get(a.state) ?? -1))[0] || null;
}

// POST /api/accounts/keys — store a provider API key in macOS Keychain.
// Replaces the insecure execSync version in routes/chat.js.
routes.post('/api/accounts/keys', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const { key } = body || {};
  const provider = normalizeProviderKey(body?.provider);
  if (!provider || !key || key.trim() === '') {
    return c.json({ error: 'validation_error' }, 400);
  }

  // WHY: look up the provider in the keychain_integrations catalog instead of
  // the old static KEY_MAP. keychain_key already stores the full prefixed name
  // (e.g. robotdojo-ASANA_PAT), so write it directly — no manual prefixing.
  let row = getKeychainIntegrationByProvider(db, provider);
  if (!row && provider === 'asana_secondary') {
    row = { keychain_key: 'robotdojo-ASANA_PAT_SECONDARY' };
  }
  if (row && provider === 'notion') {
    row = { ...row, keychain_key: 'robotdojo-NOTION_TOKEN' };
  }
  if (!row) {
    // WHY: only auto-insert when the caller explicitly supplies a keychainKey.
    // Without it, treat the provider as truly unknown and return 400.
    // This preserves the VC 3 contract while enabling user-added integrations.
    const { displayName, keychainKey } = body || {};
    if (!keychainKey) {
      return c.json({ error: `Unknown provider: ${provider}` }, 400);
    }
    // Allow unknown providers: auto-insert into catalog with source='user'.
    const derivedName = displayName || provider;
    insertUserIntegration(db, provider, derivedName, keychainKey);
    row = { keychain_key: keychainKey };
  }

  const ok = keychainWrite(row.keychain_key, key.trim());
  if (!ok) {
    return c.json({ error: 'keychain_write_failed' }, 500);
  }

  // df_355651ca AC4 — flip any needs_credential accounts row back to active
  // inline, so sessions re-advertise the token immediately; the reconciler's
  // 15-minute presence verification is the backstop, not the primary path.
  setAccountCredentialStatus(db, row.keychain_key, 'active');

  // Launch contract: cloud keys do not delete Ollama. Local/Ollama remains the
  // setup-help path before a user has a cloud key and the fallback when a cloud
  // provider is temporarily unavailable.
  //
  // Connection-live boundary: saving a source key never performs ingestion
  // inline. It only records that the scheduled background worker now has work.
  const background = queueApiKeyBackgroundImport(provider);
  if (background.queued === 0) {
    recordIntegrationJobHealth(db, provider, 'ok');
  }

  // Story st_d9fc573b — bust integration-cards cache so the new key surfaces
  // on the next render without waiting for the 60-second TTL.
  bustIntegrationCardsCache(null);
  return c.json({
    ok: true,
    provider,
    background_import: background.queued > 0 ? 'queued' : 'not_required',
    queued: background.names || [],
  });
});

routes.post('/api/accounts/store-secret', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const key = normalizeSecretKeyName(body?.key);
  const value = String(body?.value || '').trim();
  if (!key) return c.json({ error: 'secret_not_allowed' }, 400);
  if (!value) return c.json({ error: 'secret_value_required' }, 400);

  const ok = keychainWrite(key, value);
  if (!ok) return c.json({ error: 'keychain_write_failed' }, 500);
  overrideSecret(key, value);
  bustIntegrationCardsCache(null);
  return c.json({ ok: true, key });
});

// POST /api/accounts/keys/test — probe the provider's models endpoint to verify
// the stored key is valid. Uses zero-cost listing calls, never billable inference.
routes.post('/api/accounts/keys/test', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const provider = normalizeProviderKey(body?.provider);
  // WHY: catalog lookup replaces KEY_MAP. If provider unknown, return no_probe
  // instead of crashing — new providers added to catalog may lack a probe URL.
  let catalogRow = getKeychainKeyByProvider(db, provider);
  if (!catalogRow && provider === 'asana_secondary') {
    catalogRow = { keychain_key: 'robotdojo-ASANA_PAT_SECONDARY' };
  }
  if (catalogRow && provider === 'notion') {
    catalogRow = { ...catalogRow, keychain_key: 'robotdojo-NOTION_TOKEN' };
  }
  if (!catalogRow) {
    return c.json({ status: 'no_probe' });
  }

  const providerKey = readProviderKey(provider, catalogRow.keychain_key);
  if (!providerKey) {
    return c.json({ status: 'no_key' });
  }

  // Thin Facade — the zero-cost /v1/models handshake lives in lib/api-key-probe.js
  // and is shared with the 15-minute cadence pass. Providers with no live probe
  // (e.g. elevenlabs, stripe) return no_probe instead of crashing.
  if (!hasLiveProbe(provider)) return c.json({ status: 'no_probe' });

  const { status, error } = await probeApiKeyLive(provider, providerKey);

  if (status === 'valid') {
    // A 200 is a real live verification — stamp verified_at under the SAME name
    // the card reads so the dot earns Healthy immediately. recordIntegrationJobHealth
    // mirrors the ok state to the passive ledger for observability.
    recordLiveVerification(db, provider);
    recordIntegrationJobHealth(db, provider, 'ok');
  } else {
    recordIntegrationJobHealth(db, provider, 'error', { error });
  }
  bustIntegrationCardsCache(null);
  return c.json({ status });
});

// GET /api/accounts/keys/:provider — intentionally does not reveal stored
// provider secrets. Keys can be replaced or deleted, but never read back.
routes.get('/api/accounts/keys/:provider', (c) => {
  const provider = normalizeProviderKey(c.req.param('provider'));
  let row = getKeychainKeyByProvider(db, provider);
  if (!row && provider === 'asana_secondary') row = { keychain_key: 'robotdojo-ASANA_PAT_SECONDARY' };
  if (row && provider === 'notion') row = { ...row, keychain_key: 'robotdojo-NOTION_TOKEN' };
  if (!row) return c.json({ error: `Unknown provider: ${provider}` }, 400);
  const stored = Boolean(readProviderKey(provider, row.keychain_key));
  return c.json({ provider, stored, reveal: false, error: 'key_reveal_disabled' }, 405);
});

// DELETE /api/accounts/keys/:provider — remove a provider key from Keychain.
// Idempotent: deleting an absent key returns ok:true.
routes.delete('/api/accounts/keys/:provider', (c) => {
  const provider = normalizeProviderKey(c.req.param('provider'));
  // WHY: catalog lookup replaces KEY_MAP. keychain_key is the full prefixed name.
  let row = getKeychainKeyByProvider(db, provider);
  if (!row && provider === 'asana_secondary') row = { keychain_key: 'robotdojo-ASANA_PAT_SECONDARY' };
  if (row && provider === 'notion') row = { ...row, keychain_key: 'robotdojo-NOTION_TOKEN' };
  if (!row) {
    return c.json({ error: `Unknown provider: ${provider}` }, 400);
  }
  deleteProviderKeys(provider, row.keychain_key);
  // df_355651ca AC4 — the credential is gone from every alias service; flag
  // the matching accounts rows now so sessions stop advertising the token
  // immediately instead of within one reconciler cadence.
  for (const service of keychainServicesForProvider(provider, row.keychain_key)) {
    setAccountCredentialStatus(db, service, 'needs_credential');
  }
  bustIntegrationCardsCache(null);
  return c.json({ ok: true });
});

// GET /api/accounts/integration-cards — aggregates all card data for the
// Integrations tab: provider connection state, doc counts, masked credentials.
// One endpoint → one fetch on init → immediate render. No waterfall.
//
// Caching: per-user snapshot cache. Credential writes explicitly bust it, so
// dashboard counts can stay cheap without making key CRUD feel stale.
// Invalidated on POST/DELETE /api/accounts/keys and POST /api/accounts.
const integrationCardsCache = new Map(); // userId → { payload, expiresAt }
const integrationCardsInFlight = new Map(); // userId → Promise<payload>
const integrationCardsRefreshState = new Map(); // userId → refresh metadata
const INTEGRATION_CARDS_TTL_MS = 60 * 1000;
const INTEGRATION_CARDS_REFRESH_DELAY_MS = Number(process.env.ROBOTDOJO_INTEGRATION_CARDS_REFRESH_DELAY_MS || 250);
const INTEGRATION_CARDS_TEST_SYNC = process.env.ROBOTDOJO_DB === ':memory:';
const ACCOUNT_PASSIVE_JOB_TYPES = [
  'oauth_sync',
  'local_sync',
  'granola_sync',
  'oura_sync',
  'asana_sync',
  'notion_sync',
  'imports_snapshot',
  'drop_folder_import',
  'llm_export_import',
  'health_import',
  'chunk_source_scan',
  'embedding_topic',
];

function bustIntegrationCardsCache(userId) {
  if (userId == null) {
    for (const hit of integrationCardsCache.values()) hit.expiresAt = 0;
  } else {
    const hit = integrationCardsCache.get(userId);
    if (hit) hit.expiresAt = 0;
  }
}

function markIntegrationHealth(name, status, error = null) {
  upsertIntegrationHealth(db, name, status, error);
}

function getIntegrationCardsUserKey(c) {
  return c.get('user')?.id ?? 'anon';
}

function getIntegrationCardsCacheHit(userKey) {
  const hit = integrationCardsCache.get(userKey);
  return hit && Date.now() < hit.expiresAt ? hit.payload : null;
}

function getIntegrationCardsSnapshot(userKey) {
  return integrationCardsCache.get(userKey)?.payload || null;
}

function setIntegrationCardsRefreshState(userKey, patch) {
  integrationCardsRefreshState.set(userKey, {
    ...(integrationCardsRefreshState.get(userKey) || {}),
    ...patch,
  });
}

function tagIntegrationCardsPayload(payload, userKey, source) {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...payload,
    count_snapshot: {
      ...(payload.count_snapshot || {}),
      source,
      refresh: payload.count_snapshot?.refresh || source,
      cached_at: integrationCardsCache.get(userKey)?.updatedAt || null,
    },
    cache: {
      source,
      ttl_ms: INTEGRATION_CARDS_TTL_MS,
      ...(integrationCardsRefreshState.get(userKey) || {}),
    },
  };
}

function safePassiveSummary(jobTypes = ACCOUNT_PASSIVE_JOB_TYPES) {
  try {
    return getPassiveJobSummary({ jobTypes });
  } catch (err) {
    return {
      ok: false,
      error: err?.message || 'passive job summary unavailable',
      totals: { depth: 0, queued: 0, running: 0, paused: 0, done: 0, failed: 0, quarantined: 0 },
      queues: [],
    };
  }
}

// st_bf4978b0 (QA round 3) — a first-party Robot Dojo surface (the Chat card)
// is Healthy BY DEFINITION whenever the server is serving: assembling this
// payload at all proves liveness, so server-liveness IS the live verification.
// Stamp verified_at = now and a connected state on every first-party row. It
// must NEVER depend on an external probe and never render a false Issue.
function stampFirstPartyLiveness(robotDojo) {
  if (!robotDojo || !Array.isArray(robotDojo.rows)) return robotDojo;
  const now = new Date().toISOString();
  for (const row of robotDojo.rows) {
    row.verified_at = now;
    row.state = 'connected';
  }
  return robotDojo;
}

function fallbackIntegrationCardsPayload() {
  let fallbackHealthByName = {};
  try {
    fallbackHealthByName = Object.fromEntries(listIntegrationHealth(db).map((row) => [row.name, row]));
  } catch {
    fallbackHealthByName = {};
  }
  const safeAsanaCount = (provider) => {
    try { return getAsanaChunkCount(db, provider); } catch { return 0; }
  };
  const asanaCount = safeAsanaCount('asana');
  const asanaSecondaryCount = safeAsanaCount('asana_secondary');
  const asanaKnown = Boolean(fallbackHealthByName.asana || asanaCount > 0);
  const asanaSecondaryKnown = Boolean(fallbackHealthByName.asana_secondary || asanaSecondaryCount > 0);
  const asanaState = asanaKnown
    ? (backgroundStateFromHealth(fallbackHealthByName.asana) || (asanaCount > 0 ? 'connected' : 'queued'))
    : 'needs_key';
  const asanaSecondaryState = asanaSecondaryKnown
    ? (backgroundStateFromHealth(fallbackHealthByName.asana_secondary) || (asanaSecondaryCount > 0 ? 'connected' : 'queued'))
    : 'needs_key';
  const asanaLaunchState = strongestLaunchState([
    asanaKnown ? asanaState : null,
    asanaSecondaryKnown ? asanaSecondaryState : null,
    (asanaKnown || asanaSecondaryKnown) ? 'connected' : 'needs_key',
  ]);
  const asanaError = [fallbackHealthByName.asana, fallbackHealthByName.asana_secondary]
    .filter((row) => row?.last_error)
    .sort((a, b) => {
      const aState = backgroundStateFromHealth(a);
      const bState = backgroundStateFromHealth(b);
      return (LAUNCH_STATE_SEVERITY.get(bState) ?? -1) - (LAUNCH_STATE_SEVERITY.get(aState) ?? -1);
    })[0]?.last_error || null;
  const asanaFallbackCard = {
    provider: 'asana',
    name: 'Asana',
    auth: 'api_key',
    connected: asanaKnown || asanaSecondaryKnown,
    credential: null,
    doc_count: asanaCount + asanaSecondaryCount,
    substrate_type: 'api_key',
    launch_state: asanaLaunchState,
    integration_error: asanaError,
    accounts: [
      {
        provider: 'asana',
        label: 'Primary',
        connected: asanaKnown,
        credential: null,
        products: { tasks: asanaKnown ? asanaCount : 0 },
        sync_state: asanaState,
        last_sync: fallbackHealthByName.asana?.last_sync || null,
        last_check: fallbackHealthByName.asana?.last_check || null,
        last_error: fallbackHealthByName.asana?.last_error || null,
      },
      {
        provider: 'asana_secondary',
        label: 'Secondary',
        connected: asanaSecondaryKnown,
        credential: null,
        products: { tasks: asanaSecondaryKnown ? asanaSecondaryCount : 0 },
        sync_state: asanaSecondaryState,
        last_sync: fallbackHealthByName.asana_secondary?.last_sync || null,
        last_check: fallbackHealthByName.asana_secondary?.last_check || null,
        last_error: fallbackHealthByName.asana_secondary?.last_error || null,
      },
    ],
  };
  const fallbackApiKeyStatus = (provider, catalogKey = null) => {
    const normalized = normalizeProviderKey(provider);
    let catalogRow = null;
    try { catalogRow = getKeychainKeyByProvider(db, normalized); } catch { catalogRow = null; }
    const key = readProviderKey(normalized, catalogKey || catalogRow?.keychain_key || null, { cached: true });
    const health = fallbackHealthByName[normalized] || null;
    const healthState = backgroundStateFromHealth(health);
    const connected = !!key;
    return {
      credential: key ? maskKey(key) : null,
      connected,
      launch_state: apiKeyLaunchState(normalized, key, healthState),
      integration_error: health?.last_error || null,
      last_sync: health?.last_sync || null,
      last_check: health?.last_check || null,
      verified_at: health?.verified_at || null,
    };
  };
  const anthropicStatus = fallbackApiKeyStatus('anthropic');
  const googleAiStatus = fallbackApiKeyStatus('google');
  const openaiStatus = fallbackApiKeyStatus('openai');
  const xaiStatus = fallbackApiKeyStatus('xai');
  const foundationCards = [
    { provider: 'anthropic', name: 'Anthropic', auth: 'api_key', ...anthropicStatus, artifact_counts_by_type: {} },
    { provider: 'google', name: 'Google AI', auth: 'api_key', ...googleAiStatus, artifact_counts_by_type: {} },
    { provider: 'openai', name: 'OpenAI', auth: 'api_key', ...openaiStatus, artifact_counts_by_type: {} },
    { provider: 'xai', name: 'xAI', auth: 'api_key', ...xaiStatus, artifact_counts_by_type: {} },
    { provider: 'ollama', name: 'Ollama', auth: 'host', connected: false, credential: config.ollamaHost || 'http://localhost:11434', launch_state: 'needs_permission', artifact_counts_by_type: {} },
  ].map((card) => applyLaunchContract({ ...card, section: 'foundation_models', substrate_type: card.auth === 'host' ? 'local' : 'api_key', spend_30d_usd: 0 }, findLaunchIntegration(card.provider, 'foundation_models')));

  const notionStatus = fallbackApiKeyStatus('notion');
  const ouraStatus = fallbackApiKeyStatus('oura');

  // df_355651ca Key decision 5 — the fallback tells the truth about Google
  // and Microsoft. Accounts derive from the accounts table (≤50 rows) plus
  // the already-loaded health map; product counts stay zero until the warm
  // build (scheduled by the same request) replaces this payload seconds
  // later. The cold window can no longer render "nothing connected" while
  // accounts sync underneath, and a needs_reauth account stays visible and
  // annotated (AC5, never-hide).
  const fallbackHealthRowsFor = (names) => names.map((name) => fallbackHealthByName[name]).filter(Boolean);
  const latestFallback = (rows, field) => rows.map((row) => row[field]).filter(Boolean).sort().pop() || null;
  const strongestFallbackError = (rows) => rows
    .filter((row) => row.last_error)
    .sort((a, b) => {
      const aState = backgroundStateFromHealth(a);
      const bState = backgroundStateFromHealth(b);
      return (LAUNCH_STATE_SEVERITY.get(bState) ?? -1) - (LAUNCH_STATE_SEVERITY.get(aState) ?? -1);
    })[0]?.last_error || null;

  const safeSummaries = (fn) => {
    try { return fn(db); } catch { return []; }
  };
  const googleFallbackAccounts = safeSummaries(listGoogleAccountSummaries).map(({ email, account_status }) => {
    const rows = fallbackHealthRowsFor(['gmail', 'calendar', 'drive', 'contacts'].map((job) => `${job}:${email}`));
    return {
      email,
      products: { gmail: 0, calendar: 0, drive: 0, contacts: 0, docs: 0, sheets: 0, slides: 0, photos: 0, search_console: 0 },
      last_sync: latestFallback(rows, 'last_sync'),
      last_check: latestFallback(rows, 'last_check'),
      verified_at: latestFallback(rows, 'verified_at'),
      sync_state: strongestLaunchState(rows.map((row) => backgroundStateFromHealth(row))),
      last_error: strongestFallbackError(rows),
      capability_warnings: [],
      account_status,
    };
  });
  const googleFallbackState = strongestLaunchState(googleFallbackAccounts.map((account) => account.sync_state));

  // App-configured check via the 60s keychain cache — three cached reads at
  // most once a minute, never a Graph call on the request path.
  const microsoftFallbackConfigured = !!(
    cachedKeychainRead('robotdojo-MICROSOFT_TENANT_ID')
    && cachedKeychainRead('robotdojo-MICROSOFT_CLIENT_ID')
    && cachedKeychainRead('robotdojo-MICROSOFT_CLIENT_SECRET')
  );
  const microsoftFallbackAccounts = safeSummaries(listMicrosoftAccountSummaries).map(({ email, account_status }) => {
    const rows = fallbackHealthRowsFor([`microsoft-mail:${email}`, `microsoft-calendar:${email}`]);
    const syncState = strongestLaunchState(rows.map((row) => backgroundStateFromHealth(row)));
    return {
      email,
      connected: microsoftFallbackConfigured,
      source: 'db',
      products: { email: 0, calendar: 0 },
      last_sync: latestFallback(rows, 'last_sync'),
      last_check: latestFallback(rows, 'last_check'),
      verified_at: latestFallback(rows, 'verified_at'),
      sync_state: syncState || (microsoftFallbackConfigured ? 'connected' : 'needs_key'),
      last_error: strongestFallbackError(rows),
      account_status,
    };
  });
  const microsoftFallbackState = strongestLaunchState(microsoftFallbackAccounts
    .map((account) => account.sync_state)
    .filter((state) => state && state !== 'connected'));
  const microsoftFallbackConnected = microsoftFallbackConfigured && microsoftFallbackAccounts.length > 0;

  const workspaceCards = [
    {
      provider: 'google',
      name: 'Google',
      connected: googleFallbackAccounts.length > 0,
      accounts: googleFallbackAccounts,
      substrate_type: 'oauth',
      launch_state: googleFallbackAccounts.length > 0 ? (googleFallbackState || 'connected') : 'needs_oauth',
    },
    {
      provider: 'microsoft',
      name: 'Microsoft',
      connected: microsoftFallbackConnected,
      accounts: microsoftFallbackAccounts,
      credential: microsoftFallbackConfigured ? 'stored' : '',
      substrate_type: 'app_credentials',
      launch_state: microsoftFallbackState || (microsoftFallbackConnected ? 'connected' : (microsoftFallbackConfigured ? 'ready' : 'needs_key')),
      recovery: 'Microsoft uses tenant-admin Graph application permissions. Store tenant/client/secret, grant admin consent, then add mailbox email. Do not use the delegated approval prompt.',
    },
    { provider: 'apple', name: 'Apple', connected: false, doc_counts: { imessage: 0, contacts: 0, calendar: 0, photos_metadata: 0 }, permission_status: {}, substrate_type: 'local', launch_state: 'needs_permission' },
    { provider: 'imports', name: 'Imports', connected: false, accounts: [], substrate_type: 'local', launch_state: 'ready', one_time_import: true, stale_sensitive: false, recovery: 'Drop export files into user/inbox. Chat exports materialize into user/transcripts/chat; email archives index as Imports account rows.' },
  ].map((card) => applyLaunchContract({ ...card, section: 'workspace', spend_30d_usd: null }, findLaunchIntegration(card.provider, 'workspace')));

  const productivityCards = [
    asanaFallbackCard,
    // df_ac0dd301 Fix A: Brave is a DROPPED (non-launch) provider. It must not
    // leak onto the page during the ~30s cold window before the boot primer
    // warms the cache — so it is gone from the fallback too, matching the
    // launch-filtered catalog. (Brave was the only dropped provider hardcoded
    // in the fallback; the other 11 are registry/keychain-discovered.)
    { provider: 'notion', name: 'Notion', auth: 'api_key', ...notionStatus, doc_count: 0, substrate_type: 'api_key' },
    { provider: 'granola', name: 'Granola', connected: false, doc_count: 0, substrate_type: 'local', launch_state: 'needs_permission', recovery: 'Install Granola, open the Mac app, sign in, then return to Robot Dojo.' },
  ].map((card) => applyLaunchContract({ ...card, section: 'productivity', spend_30d_usd: null }, findLaunchIntegration(card.provider, 'productivity')));

  const healthCards = [
    { provider: 'oura', name: 'Oura', auth: 'api_key', ...ouraStatus, doc_count: 0, substrate_type: 'api_key' },
    { provider: 'apple-health', name: 'Apple Health files', connected: false, doc_count: 0, substrate_type: 'local', launch_state: 'ready', one_time_import: false, stale_sensitive: false },
    { provider: 'health-labs', name: 'Labs', connected: false, doc_count: 0, doc_counts: { files: 0 }, substrate_type: 'local', launch_state: 'ready', one_time_import: true, stale_sensitive: false },
  ].map((card) => applyLaunchContract({ ...card, section: 'health', spend_30d_usd: null }, findLaunchIntegration(card.provider, 'health')));

  const financesCards = [
    {
      provider: 'monarch',
      name: 'Monarch',
      connected: false,
      doc_count: 0,
      substrate_type: 'local',
      launch_state: 'needs_permission',
      recovery: 'Put the Monarch login in the Robot Dojo vault. Use a 1Password service account limited to that vault. Turn off Settings → Developer → Integrate with 1Password CLI so agents cannot see other vaults.',
    },
  ].map((card) => applyLaunchContract({ ...card, section: 'finances', spend_30d_usd: null }, findLaunchIntegration(card.provider, 'finances')));

  const allCards = [...foundationCards, ...workspaceCards, ...productivityCards, ...healthCards, ...financesCards]
    // st_fcdbe84f AC11 / st_fd14cdd4 — drop any launch-hidden providers from the
    // surface. The hidden set is EMPTY since st_fd14cdd4 unhid Microsoft (owner
    // directive); the filter stays so a future provider can be hidden via the set.
    .filter((card) => !isLaunchHiddenProvider(card.provider));
  const cards = allCards.map((card) => Object.assign(card, normalizeLaunchCard(card)));
  return {
    robot_dojo: stampFirstPartyLiveness({
      updatedAt: new Date().toISOString(),
      rows: [{
        provider: 'robotdojo-chat',
        label: 'Chat',
        type: 'First-party app',
        counts: { chat: 0, email: 0, calendar: 0, sms: 0, other: 0 },
        details: {},
        state: 'ready',
      }],
    }),
    count_snapshot: { updatedAt: new Date().toISOString(), refresh: 'cold' },
    sections: [
      { id: 'foundation_models', label: 'Foundation Models', cards: foundationCards },
      { id: 'workspace',         label: 'Workspace',         cards: workspaceCards },
      { id: 'productivity',      label: 'Productivity',      cards: productivityCards },
      { id: 'health',            label: 'Health',            cards: healthCards },
      { id: 'finances',          label: 'Finances',          cards: financesCards },
    ],
    cards,
    connected: 0,
    total: allCards.length,
    total_artifacts: 0,
    passive_jobs: safePassiveSummary(),
  };
}

function scheduleIntegrationCardsRefresh(c, userKey) {
  if (integrationCardsInFlight.has(userKey)) return integrationCardsInFlight.get(userKey);
  setIntegrationCardsRefreshState(userKey, {
    refreshing: true,
    refresh_started_at: new Date().toISOString(),
    last_error: null,
  });
  const promise = new Promise((resolve) => {
    const timer = setTimeout(resolve, INTEGRATION_CARDS_REFRESH_DELAY_MS);
    timer.unref?.();
  }).then(async () => {
    const started = Date.now();
    try {
      const payload = await buildIntegrationCardsPayload(c, { userKey, cacheChecked: true });
      setIntegrationCardsRefreshState(userKey, {
        refreshing: false,
        last_duration_ms: Date.now() - started,
        last_refreshed_at: new Date().toISOString(),
        last_error: null,
      });
      return payload;
    } catch (err) {
      setIntegrationCardsRefreshState(userKey, {
        refreshing: false,
        last_error: err?.message || String(err || 'integration cards refresh failed'),
      });
      console.warn('[accounts] integration-cards refresh failed:', err?.message || err);
      throw err;
    }
  }).finally(() => {
    if (integrationCardsInFlight.get(userKey) === promise) {
      integrationCardsInFlight.delete(userKey);
    }
  });
  integrationCardsInFlight.set(userKey, promise);
  return promise;
}

async function getIntegrationCardsPayload(c) {
  const userKey = getIntegrationCardsUserKey(c);
  const refresh = c.req.query('refresh') === '1';
  if (refresh && INTEGRATION_CARDS_TEST_SYNC) bustIntegrationCardsCache(userKey);
  const cached = getIntegrationCardsCacheHit(userKey);
  if (cached && !refresh) return tagIntegrationCardsPayload(cached, userKey, 'cache');

  if (INTEGRATION_CARDS_TEST_SYNC) {
    return buildIntegrationCardsPayload(c, { userKey, cacheChecked: Boolean(cached) });
  }

  const snapshot = cached || getIntegrationCardsSnapshot(userKey);
  if (snapshot) {
    scheduleIntegrationCardsRefresh(c, userKey).catch(() => {});
    return tagIntegrationCardsPayload(snapshot, userKey, refresh ? 'stale-refreshing' : 'stale');
  }
  // df_355651ca Key decision 4a — the no-snapshot branch also schedules a
  // build (fire-and-forget, never inline: the builder shells out to Keychain
  // and runs dozens of COUNTs). Without this line a cold cache could never be
  // populated in production — building required a snapshot only the builder
  // writes, so every response after a restart was the fallback forever.
  scheduleIntegrationCardsRefresh(c, userKey).catch(() => {});
  return tagIntegrationCardsPayload(fallbackIntegrationCardsPayload(), userKey, 'cold');
}

/**
 * Boot primer (df_355651ca Key decision 4b) — build the integration-cards
 * payload once and seed the cache for 'anon' plus every users.id, so the
 * account page is warm after a restart with zero page visits. Called from
 * index.js via bootLater; never on the request path.
 *
 * The payload is user-independent today (every builder query is global), so
 * one build serves all user keys. If the payload ever becomes per-user, this
 * is the one function to revisit.
 */
export async function primeIntegrationCardsCache() {
  // cacheChecked: true — the Hono context is never dereferenced on this path.
  const payload = await buildIntegrationCardsPayload(null, { userKey: 'anon', cacheChecked: true });
  const updatedAt = new Date().toISOString();
  const userIds = listUserIds(db).filter((id) => id !== 'anon');
  for (const id of userIds) {
    integrationCardsCache.set(id, {
      payload,
      expiresAt: Date.now() + INTEGRATION_CARDS_TTL_MS,
      updatedAt,
    });
  }
  return { primed: 1 + userIds.length, userKeys: ['anon', ...userIds] };
}

// Exported so the anti-regression guard (scripts/check-integration-truth.js,
// `--check card-truth`) can assemble the REAL card payload in-process against
// the live DB — no HTTP server, no network. `primeIntegrationCardsCache` proves
// the c=null + cacheChecked:true path never dereferences the Hono context.
export async function buildIntegrationCardsPayload(c, { userKey = getIntegrationCardsUserKey(c), cacheChecked = false } = {}) {
  if (!cacheChecked) {
    if (c.req.query('refresh') === '1') {
      bustIntegrationCardsCache(userKey);
    }
    const cached = getIntegrationCardsCacheHit(userKey);
    if (cached) return cached;
  }

  // Build a fast doc-count lookup from integration_health names
  const healthRows = listIntegrationHealth(db);
  const healthByName = {};
  for (const r of healthRows) healthByName[r.name] = r;

  // Trailing 30-day spend per foundation-model provider (AC 14).
  const spendByProvider = getSpend30dByProvider(db);
  const importSnapshotRows = listImportsSnapshot(db);
  const chatCountsByProvider = chatImportCountsByProvider(db, importSnapshotRows);

  // ── Foundation Models section ──────────────────────────────────────────────

  function readCatalogKey(row) {
    let key = readProviderKey(row.provider, row.keychain_key, { cached: true });
    if (!key && row.provider === 'notion') {
      key = cachedKeychainRead('robotdojo-NOTION_TOKEN');
    }
    if (!key && (row.provider === 'google' || row.provider === 'google-ai')) {
      key = cachedKeychainRead('robotdojo-GOOGLE_AI_API_KEY') || cachedKeychainRead('robotdojo-GOOGLE_API_KEY');
    }
    if (!key && row.provider === 'oura') {
      key = cachedKeychainRead('robotdojo-OURA_PAT') || cachedKeychainRead('robotdojo-OURA_CLIENT_SECRET');
    }
    if (!key && row.provider === 'asana') {
      key = cachedKeychainRead('robotdojo-ASANA_PAT') || secret('ASANA_PAT');
    }
    return key;
  }

  const foundationCards = [];

  // WHY: catalog-driven — display_name and keychain_key come from the DB,
  // so adding a new foundation model = INSERT a row in keychain_integrations.
  const foundationRows = listKeychainIntegrationsBySection(db, 'foundation_models');
  for (const row of foundationRows) {
    // df_ac0dd301 Fix C: open-weight models (mistral, and future llama/qwen) run
    // locally through Ollama, not a cloud key. Show one as healthy ONLY when it
    // is actually runnable right now — Ollama reachable AND a matching model
    // pulled; otherwise omit it entirely, never a needs-key card. healthByName
    // .ollama is the background signal built above; isOpenWeightModelRunnable
    // reads the cached installed-model list — the page never probes Ollama here.
    if (OPEN_WEIGHT_MODEL_FAMILIES.has(row.provider)) {
      const ollamaReachable = healthByName.ollama?.status === 'ok';
      if (!isOpenWeightModelRunnable(db, row.provider, ollamaReachable)) continue;
      const chatCount = chatCountsByProvider.get(row.provider) || 0;
      foundationCards.push(applyLaunchContract({
        provider: row.provider,
        name: row.display_name,
        auth: 'host',
        connected: true,
        credential: null,
        locked: false,
        section: 'foundation_models',
        substrate_type: 'local',
        launch_state: 'connected',
        artifact_counts_by_type: chatCount ? { chat: chatCount } : {},
      }, findLaunchIntegration(row.provider, 'foundation_models')));
      continue;
    }
    const key = readCatalogKey(row);
    const health = healthByName[row.provider];
    const healthState = backgroundStateFromHealth(health);
    const chatCount = chatCountsByProvider.get(row.provider) || 0;
    foundationCards.push(applyLaunchContract({
      provider: row.provider,
      name: row.display_name,
      auth: 'api_key',
      connected: !!key,
      credential: key ? maskKey(key) : null,
      locked: false,
      section: 'foundation_models',
      substrate_type: 'api_key',
      launch_state: apiKeyLaunchState(row.provider, key, healthState),
      integration_error: health?.last_error || null,
      last_sync: health?.last_sync || null,
      last_check: health?.last_check || null,
      // st_bf4978b0 — the live-verification timestamp the card's status dot reads
      // to earn Healthy. NULL until the cadence handshake or a real API call
      // verifies the key.
      verified_at: health?.verified_at || null,
      artifact_counts_by_type: chatCount
        ? { chat: chatCount }
        : {},
    }, findLaunchIntegration(row.provider, 'foundation_models')));
  }

  // Ollama: special case — connected if host is non-default or the background
  // integration monitor has seen it. The Accounts page must not probe local
  // network services inline; a slow localhost connect would block the server.
  let ollamaConnected = false;
  const ollamaHost = config.ollamaHost || 'http://localhost:11434';
  const isNonDefault = ollamaHost !== 'http://localhost:11434';
  const ollamaHealth = healthByName.ollama;
  const ollamaHealthState = backgroundStateFromHealth(ollamaHealth);
  if (isNonDefault) {
    ollamaConnected = true;
  } else if (ollamaHealthState === 'done' || ollamaHealthState === 'connected') {
    ollamaConnected = true;
  }
  const ollamaChatCount = chatCountsByProvider.get('ollama') || 0;
  const hasCloudFoundationProvider = foundationCards.some((card) => card.connected && card.provider !== 'ollama');
  const ollamaRequired = !hasCloudFoundationProvider;
  const ollamaOptionalOff = !ollamaRequired && !ollamaConnected;
  const ollamaLaunchState = ollamaConnected
    ? 'connected'
    : (ollamaRequired ? (ollamaHealthState || 'needs_permission') : 'ready');
  const ollamaContract = {
    ...findLaunchIntegration('ollama', 'foundation_models'),
    required: ollamaRequired,
    recovery: ollamaRequired
      ? 'Start Ollama locally or paste a cloud model provider key so first-session chat can run.'
      : 'Optional local Llama/Ollama fallback. Cloud foundation providers are already available.',
  };
  foundationCards.push(applyLaunchContract({
    provider: 'ollama',
    name: 'Ollama',
    auth: 'host',
    connected: ollamaConnected,
    credential: ollamaHost,
    locked: false,
    section: 'foundation_models',
    substrate_type: 'local',
    launch_state: ollamaLaunchState,
    health_state: ollamaOptionalOff ? 'ready' : ollamaHealthState,
    health_color: ollamaOptionalOff ? 'grey' : undefined,
    integration_error: ollamaRequired ? (ollamaHealth?.last_error || null) : null,
    last_sync: ollamaOptionalOff ? null : (ollamaHealth?.last_sync || null),
    last_check: ollamaOptionalOff ? null : (ollamaHealth?.last_check || null),
    verified_at: ollamaOptionalOff ? null : (ollamaHealth?.verified_at || null),
    artifact_counts_by_type: ollamaChatCount ? { chat: ollamaChatCount } : {},
    _launch_contract: ollamaContract,
  }, ollamaContract));

  // ── Workspace section ──────────────────────────────────────────────────────

  // Helper: get doc counts from integration_health for a given prefix pattern
  function healthDocCount(namePrefixes) {
    // Counts docs by looking at integration_health names that match the prefix
    // and querying the real tables (same logic as routes/integrations.js)
    let total = 0;
    for (const [name] of Object.entries(healthByName)) {
      for (const prefix of namePrefixes) {
        if (name.startsWith(prefix + ':') || name === prefix) {
          const [, email] = name.split(/:(.+)/);
          total += getHealthDocCount(db, name, email);
        }
      }
    }
    return total;
  }

  function healthRowsFor(names) {
    return names
      .map((name) => healthByName[name])
      .filter(Boolean);
  }

  function strongestHealthState(names) {
    return strongestLaunchState(healthRowsFor(names).map((row) => backgroundStateFromHealth(row)));
  }

  function latestHealthSync(names) {
    return healthRowsFor(names)
      .map((row) => row.last_sync)
      .filter(Boolean)
      .sort()
      .pop() || null;
  }

  function latestHealthCheck(names) {
    return healthRowsFor(names)
      .map((row) => row.last_check)
      .filter(Boolean)
      .sort()
      .pop() || null;
  }

  // st_bf4978b0 — newest live-verification across an account's product health
  // rows (gmail:x, calendar:x, …). This is what the OAuth account dot reads to
  // earn Healthy inside the 180-min window; distinct from last_check/last_sync.
  function latestHealthVerified(names) {
    return healthRowsFor(names)
      .map((row) => row.verified_at)
      .filter(Boolean)
      .sort()
      .pop() || null;
  }

  function strongestHealthError(names) {
    return healthRowsFor(names)
      .filter((row) => row.last_error)
      .sort((a, b) => {
        const aState = backgroundStateFromHealth(a);
        const bState = backgroundStateFromHealth(b);
        return (LAUNCH_STATE_SEVERITY.get(bState) ?? -1) - (LAUNCH_STATE_SEVERITY.get(aState) ?? -1);
      })[0]?.last_error || null;
  }

  function healthDataPointCount(sources) {
    try {
      return countHealthDataPoints(db, sources);
    } catch {
      return 0;
    }
  }

  function healthNoteCount(source) {
    try {
      return countHealthNotes(db, source);
    } catch {
      return 0;
    }
  }

  function latestHealthDataTimestamp(sources) {
    try {
      return latestHealthDataPointTimestamp(db, sources);
    } catch {
      return null;
    }
  }

  function countHealthIngestionDocs(sources) {
    try {
      return countDistinctHealthIngestionDocs(db, sources);
    } catch {
      return 0;
    }
  }

  function latestHealthIngestionTimestamp(sources) {
    try {
      return maxHealthIngestionTimestamp(db, sources);
    } catch {
      return null;
    }
  }

  function countPdfFilesInDir(dir) {
    try {
      if (!existsSync(dir)) return 0;
      return readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.pdf')).length;
    } catch {
      return 0;
    }
  }

  // Google: group by email with per-product counts
  const googleAccounts = getGoogleAccountEmails(db);
  const googleAccountCards = googleAccounts.map(({ email }) => {
    const accountRows = getGoogleAccountRows(db, email);
    const rowByType = new Map(accountRows.map((row) => [row.type, row]));
    const emailCount = getGoogleEmailCount(db, email);
    const calCount = getGoogleCalendarCount(db, email);
    const driveCount = getGoogleDriveCount(db, email);
    const contactsCount = getGoogleContactsCount(db, email);
    const photosCount = getGooglePhotosCount(db, email);
    const productHealthNames = ['gmail', 'calendar', 'drive', 'contacts'].map((job) => `${job}:${email}`);
    const optionalHealthNames = ['photos'].map((job) => `${job}:${email}`);
    const healthState = strongestHealthState(productHealthNames);
    const healthError = strongestHealthError(productHealthNames);
    const optionalWarnings = healthRowsFor(optionalHealthNames)
      .filter((row) => row.last_error)
      .map((row) => ({
        product: row.name.split(':', 1)[0],
        state: backgroundStateFromHealth(row),
        error: row.last_error,
      }));
    const capabilityIssues = [
      missingGoogleScopeState(rowByType.get('drive'), GOOGLE_DRIVE_FULL_HISTORY_SCOPE, 'full Drive history read access'),
      missingGoogleScopeState(rowByType.get('email'), GOOGLE_PHOTOS_READONLY_SCOPE, 'Google Photos read-only access'),
    ].filter(Boolean);
    const strongest = strongestStateSource([
      { state: healthState, error: healthError },
      ...capabilityIssues,
    ]);
    const hasSyncedData = emailCount + calCount + driveCount + contactsCount + photosCount > 0;
    const syncState = strongest?.state || (hasSyncedData ? 'done' : null);
    const last_sync = latestHealthSync(productHealthNames);
    const last_check = latestHealthCheck(productHealthNames);
    const verified_at = latestHealthVerified(productHealthNames);
    const last_error = strongest?.error || null;
    // st_d142f701 AC2: surface account_status to the UI so the accounts
    // surface renders a Reconnect CTA when invalid_grant has cleared the
    // Keychain tokens and flipped the row to needs_reauth.
    const account_status = capabilityIssues.length ? 'needs_reauth' : getAccountStatusByEmail(db, 'google', email);
    return {
      email,
      products: {
        gmail: emailCount,
        calendar: calCount,
        drive: driveCount,
        contacts: contactsCount,
        docs: driveCount,
        sheets: 0,
        slides: 0,
        photos: photosCount,
        search_console: 0,
      },
      last_sync,
      last_check,
      verified_at,
      sync_state: syncState,
      last_error,
      capability_warnings: optionalWarnings,
      account_status,
    };
  });
  const googleSyncState = strongestLaunchState(googleAccountCards.map((account) => account.sync_state));
  const googleLastError = googleAccountCards
    .filter((account) => account.last_error)
    .sort((a, b) => (LAUNCH_STATE_SEVERITY.get(b.sync_state) ?? -1) - (LAUNCH_STATE_SEVERITY.get(a.sync_state) ?? -1))[0]?.last_error || null;

  const workspaceCards = [
    applyLaunchContract({
      provider: 'google',
      name: 'Google',
      connected: googleAccounts.length > 0,
      accounts: googleAccountCards,
      locked: false,
      section: 'workspace',
      substrate_type: 'oauth',
      launch_state: googleSyncState || undefined,
      integration_error: googleLastError,
      // st_bf4978b0 (QA round 3) — an aggregate/group parent earns its Healthy
      // dot ONLY by inheriting a genuinely-verified, in-window child. NULL when
      // no account is live-verified (honest not-Healthy); never fabricated, so
      // this can never turn a broken account green.
      verified_at: freshestHealthyChildVerifiedAt({ accounts: googleAccountCards, provider: 'google', substrate_type: 'oauth' }),
    }, findLaunchIntegration('google', 'workspace')),
  ];

  // Microsoft
  const microsoftAppConfigured = !!(
    secret('MICROSOFT_TENANT_ID')
    && secret('MICROSOFT_CLIENT_ID')
    && secret('MICROSOFT_CLIENT_SECRET')
  );
  const microsoftLiveEmailSet = new Set([
    ...listConnectedMicrosoftAccounts('email'),
    ...listConnectedMicrosoftAccounts('calendar'),
  ]);
  const registryOnlyMicrosoftEmails = listConnectedMicrosoftAccounts()
    .filter((email) => email && !microsoftLiveEmailSet.has(email));
  const msAccounts = [
    ...[...microsoftLiveEmailSet].map((email) => ({ email, source: 'db' })),
    ...registryOnlyMicrosoftEmails.map((email) => ({ email, source: 'legacy_registry' })),
  ];
  const msAccountCards = msAccounts.map(({ email, source }) => {
    const isLiveAccount = source === 'db';
    const emailCount = getMicrosoftEmailCount(db, email);
    const calCount = getMicrosoftCalendarCount(db, email);
    const microsoftHealthNames = [`microsoft-mail:${email}`, `microsoft-calendar:${email}`];
    const syncState = strongestLaunchState([
      backgroundStateFromHealth(healthByName[microsoftHealthNames[0]]),
      backgroundStateFromHealth(healthByName[microsoftHealthNames[1]]),
    ]);
    const connected = microsoftAppConfigured && isLiveAccount;
    const microsoftHealthError = strongestHealthError(microsoftHealthNames);
    // st_d142f701 AC2: same as Google — bubble needs_reauth up to the UI.
    const account_status = getAccountStatusByEmail(db, 'microsoft', email);
    return {
      email,
      connected,
      source,
      products: { email: emailCount, calendar: calCount },
      last_sync: latestHealthSync(microsoftHealthNames),
      last_check: latestHealthCheck(microsoftHealthNames),
      verified_at: latestHealthVerified(microsoftHealthNames),
      sync_state: connected
        ? (syncState || 'connected')
        : (microsoftAppConfigured && source === 'legacy_registry' ? 'error_recoverable' : 'needs_key'),
      last_error: connected
        ? microsoftHealthError
        : (microsoftAppConfigured && source === 'legacy_registry'
          ? 'Legacy Microsoft token found without a mailbox row. Add the mailbox again to queue background imports.'
          : 'Store Microsoft tenant ID, client ID, and client secret in Accounts.'),
      account_status,
    };
  });
  const microsoftSyncState = strongestLaunchState(msAccountCards
    .map((account) => account.sync_state)
    .filter((state) => state && state !== 'connected'));
  const microsoftConnected = msAccountCards.some((account) => account.connected);
  workspaceCards.push(applyLaunchContract({
    provider: 'microsoft',
    name: 'Microsoft',
    connected: microsoftConnected,
    accounts: msAccountCards,
    credential: microsoftAppConfigured ? 'stored' : '',
    locked: false,
    section: 'workspace',
    substrate_type: 'app_credentials',
    launch_state: microsoftSyncState || (microsoftConnected ? 'connected' : (microsoftAppConfigured ? 'ready' : 'needs_key')),
    // st_bf4978b0 (QA round 3) — inherit Healthy from a live-verified mailbox
    // (OAuth-class 180m window); NULL when none is verified. Never fabricated.
    verified_at: freshestHealthyChildVerifiedAt({ accounts: msAccountCards, provider: 'microsoft', substrate_type: 'oauth' }),
    recovery: 'Microsoft uses tenant-admin Graph application permissions. Store tenant/client/secret, grant admin consent, then add mailbox email. Do not use the delegated approval prompt.',
  }, findLaunchIntegration('microsoft', 'workspace')));

  // Apple: Mac-local — iMessage, local Contacts, Photos, Calendar.
  // Apple has no OAuth row in accounts; presence is local data or permission.
  // Do not count google_contacts here: Google Contacts belong to Google.
  const imessageCount = getImessageCount(db);
  const contactsCount = getContactsCount(db);
  const applePhotosCount = getApplePhotosCount(db);
  const appleCalendarCount = getAppleCalendarCount(db);
  const appleHealthNames = ['imessage', 'imessage:local', 'apple-photos'];
  const appleLastSync = latestHealthSync(appleHealthNames);
  const appleLastCheck = latestHealthCheck(appleHealthNames);
  const appleVerifiedAt = latestHealthVerified(appleHealthNames);
  const appleHealthState = strongestHealthState(appleHealthNames);
  const appleHealthError = strongestHealthError(appleHealthNames);
  const applePermissions = getCachedPermissions() || {
    full_disk: false,
    contacts: false,
    calendar: false,
    photos: false,
    reminders: false,
  };
  const applePermissionGranted = !!(
    applePermissions.full_disk
    || applePermissions.contacts
    || applePermissions.calendar
    || applePermissions.photos
  );
  const appleHasData = imessageCount > 0 || contactsCount > 0 || applePhotosCount > 0 || appleCalendarCount > 0;
  const appleLaunchState = strongestLaunchState([
    appleHealthState,
    (appleHasData || applePermissionGranted) ? 'connected' : 'needs_permission',
  ]);
  workspaceCards.push(applyLaunchContract({
    provider: 'apple',
    name: 'Apple',
    connected: appleHasData || applePermissionGranted,
    doc_counts: { imessage: imessageCount, contacts: contactsCount, calendar: appleCalendarCount, photos_metadata: applePhotosCount },
    permission_status: applePermissions,
    last_sync: appleLastSync,
    last_check: appleLastCheck,
    verified_at: appleVerifiedAt,
    integration_error: appleHealthError,
    launch_state: appleLaunchState,
    locked: false,
    section: 'workspace',
    substrate_type: 'local',
  }, findLaunchIntegration('apple', 'workspace')));

  // Imports: local archive sources (.mbox/.eml) normalized into canonical rows.
  const importedEmailAccounts = listImportedEmailAccounts(db, {
    snapshotRows: importSnapshotRows,
    live: false,
    liveFallback: true,
  });
  const importAccountCards = importedEmailAccounts.map((account) => {
    const emailCount = Number(account.email_count) || 0;
    // Imports are one-time local archive rows, not live mailboxes. Once an
    // archive source exists on this surface, operational health is binary:
    // it is indexed locally, while file-level failures live in the Imports
    // drop/history surface.
    return {
      provider: 'imports',
      label: account.display_name,
      email: account.account_key,
      connected: true,
      products: { email: emailCount },
      sync_state: 'done',
      health_color: 'green',
      health_state: 'done',
      one_time_import: true,
      stale_sensitive: false,
      last_sync: account.last_sync || account.latest_at || null,
      last_error: null,
      recovery: 'Historical email archive indexed locally.',
      auth: 'local',
      substrate_type: 'local',
      source: 'import_archive',
      live_vendor: null,
      live_account_status: null,
    };
  });
  const importsLastSync = importAccountCards.map((account) => account.last_sync).filter(Boolean).sort().pop() || null;
  const importsLaunchState = strongestLaunchState(importAccountCards.map((account) => account.sync_state));
  workspaceCards.push(applyLaunchContract({
    provider: 'imports',
    name: 'Imports',
    connected: importAccountCards.length > 0,
    accounts: importAccountCards,
    last_sync: importsLastSync,
    integration_error: null,
    locked: false,
    section: 'workspace',
    substrate_type: 'local',
    launch_state: importsLaunchState || (importAccountCards.length > 0 ? 'connected' : 'ready'),
    health_color: importAccountCards.length > 0 ? 'green' : null,
    health_state: importAccountCards.length > 0 ? 'done' : null,
    one_time_import: true,
    stale_sensitive: false,
    recovery: 'Drop export files into user/inbox. Chat exports materialize into user/transcripts/chat; email archives index as Imports account rows.',
  }, findLaunchIntegration('imports', 'workspace')));

  // ── Productivity section ───────────────────────────────────────────────────

  let granolaInstalled = false;
  let granolaTokenAvailable = false;
  let granolaSignedIn = false;
  let granolaAccountEmail = null;
  try {
    const { STORED_ACCOUNTS_FILE, getGranolaLocalSession } = await import('../lib/granola-client.js');
    // Do not unwrap Granola's encrypted session in the Accounts page. That path
    // can block on macOS Keychain; background sync owns live token reads.
    const granolaSession = getGranolaLocalSession({ keychainSecret: '' });
    granolaInstalled = granolaSession.installed || existsSync(STORED_ACCOUNTS_FILE);
    granolaSignedIn = !!granolaSession.signedIn;
    granolaAccountEmail = granolaSession.email || null;
  } catch {
    granolaInstalled = false;
    granolaTokenAvailable = false;
    granolaSignedIn = false;
    granolaAccountEmail = null;
  }
  const granolaHealthError = strongestHealthError(['granola']);
  const staleGranolaTokenError = granolaSignedIn && /no granola token|token available|refresh_token/i.test(granolaHealthError || '');
  const granolaHealthState = staleGranolaTokenError ? null : strongestHealthState(['granola']);
  const granolaDocCount = getGranolaCount(db);
  const granolaConnected = granolaHealthState === 'done' || granolaSignedIn || granolaTokenAvailable || granolaDocCount > 0;
  const granolaLaunchState = strongestLaunchState([
    granolaHealthState,
    granolaConnected ? 'connected' : 'needs_permission',
  ]);

  // WHY: catalog-driven — iterate all productivity rows from keychain_integrations.
  // Granola is NOT in the catalog (it's local-cache based, no keychain_key) so
  // it remains hardcoded and is pushed AFTER the catalog loop.
  const productivityCatalogRows = listKeychainIntegrationsBySection(db, 'productivity');
  const productivityCards = [];

  for (const row of productivityCatalogRows) {
    if (row.provider === 'asana_secondary' || row.provider === 'oura' || row.provider === 'monarch') continue;
    const key = readCatalogKey(row);
    const card = {
      provider: row.provider,
      name: row.display_name,
      auth: 'api_key',
      connected: !!key,
      credential: key ? maskKey(key) : null,
      last_sync: healthByName[row.provider]?.last_sync || null,
      last_check: healthByName[row.provider]?.last_check || null,
      // st_bf4978b0 (QA round 3) — a leaf key card earns Healthy from its own
      // health row's live verification; without threading this the card renders
      // a FALSE Issue while the probe is succeeding (the card-assembly blind
      // spot the DB-row guard cannot see). Overwritten for asana below.
      verified_at: healthByName[row.provider]?.verified_at || null,
      locked: false,
      section: 'productivity',
      substrate_type: 'api_key',
    };
    // Notion gets doc_count from the chunks table
    if (row.provider === 'notion') {
      const h = Object.keys(healthByName).find(n => n.startsWith('notion'));
      card.doc_count = h ? getNotionChunkCount(db) : 0;
    } else if (row.provider === 'asana') {
      const asanaSecondaryKey = cachedKeychainRead('robotdojo-ASANA_PAT_SECONDARY') || secret('ASANA_PAT_SECONDARY');
      const asanaCount = getAsanaChunkCount(db, 'asana');
      const asanaSecondaryCount = getAsanaChunkCount(db, 'asana_secondary');
      const asanaTotalCount = asanaCount + asanaSecondaryCount;
      const asanaState = key ? (backgroundStateFromHealth(healthByName.asana) || (asanaCount > 0 ? 'connected' : 'queued')) : 'needs_key';
      const asanaSecondaryState = asanaSecondaryKey ? (backgroundStateFromHealth(healthByName.asana_secondary) || (asanaSecondaryCount > 0 ? 'connected' : 'queued')) : 'needs_key';
      const asanaLaunchState = strongestLaunchState([
        key ? asanaState : null,
        asanaSecondaryKey ? asanaSecondaryState : null,
        (key || asanaSecondaryKey) ? 'connected' : 'needs_key',
      ]);
      const asanaError = strongestHealthError(['asana', 'asana_secondary']);
      card.connected = !!(key || asanaSecondaryKey);
      card.doc_count = asanaTotalCount;
      card.launch_state = asanaLaunchState;
      card.integration_error = asanaError;
      card.accounts = [
        {
          provider: 'asana',
          label: 'Primary',
          connected: !!key,
          credential: key ? maskKey(key) : null,
          products: { tasks: key ? asanaCount : 0 },
          sync_state: asanaState,
          last_sync: healthByName.asana?.last_sync || null,
          last_check: healthByName.asana?.last_check || null,
          verified_at: healthByName.asana?.verified_at || null,
          last_error: healthByName.asana?.last_error || null,
        },
        {
          provider: 'asana_secondary',
          label: 'Secondary',
          connected: !!asanaSecondaryKey,
          credential: asanaSecondaryKey ? maskKey(asanaSecondaryKey) : null,
          products: { tasks: asanaSecondaryKey ? asanaSecondaryCount : 0 },
          sync_state: asanaSecondaryState,
          last_sync: healthByName.asana_secondary?.last_sync || null,
          last_check: healthByName.asana_secondary?.last_check || null,
          verified_at: healthByName.asana_secondary?.verified_at || null,
          last_error: healthByName.asana_secondary?.last_error || null,
        },
      ];
      // st_bf4978b0 (QA round 3) — the Asana group parent inherits Healthy from
      // whichever workspace token was live-verified most recently (other-key
      // 120m window). NULL when neither is verified.
      card.verified_at = freshestHealthyChildVerifiedAt(card);
    } else {
      const health = healthByName[row.provider];
      const healthState = backgroundStateFromHealth(health);
      card.launch_state = apiKeyLaunchState(row.provider, key, healthState);
      card.integration_error = health?.last_error || null;
    }
    productivityCards.push(applyLaunchContract(card, findLaunchIntegration(row.provider, 'productivity')));
  }

  if (!productivityCards.some((card) => card.provider === 'asana' || card.provider === 'asana_secondary')) {
    const asanaKey = cachedKeychainRead('robotdojo-ASANA_PAT') || secret('ASANA_PAT');
    const asanaSecondaryKey = cachedKeychainRead('robotdojo-ASANA_PAT_SECONDARY') || secret('ASANA_PAT_SECONDARY');
    const asanaCount = getAsanaChunkCount(db, 'asana');
    const asanaSecondaryCount = getAsanaChunkCount(db, 'asana_secondary');
    const asanaTotalCount = asanaCount + asanaSecondaryCount;
    const asanaState = asanaKey ? (backgroundStateFromHealth(healthByName.asana) || (asanaCount > 0 ? 'connected' : 'queued')) : 'needs_key';
    const asanaSecondaryState = asanaSecondaryKey ? (backgroundStateFromHealth(healthByName.asana_secondary) || (asanaSecondaryCount > 0 ? 'connected' : 'queued')) : 'needs_key';
    const asanaLaunchState = strongestLaunchState([
      asanaKey ? asanaState : null,
      asanaSecondaryKey ? asanaSecondaryState : null,
      (asanaKey || asanaSecondaryKey) ? 'connected' : 'needs_key',
    ]);
    const asanaError = strongestHealthError(['asana', 'asana_secondary']);
    productivityCards.push(applyLaunchContract({
      provider: 'asana',
      name: 'Asana',
      auth: 'api_key',
      connected: !!(asanaKey || asanaSecondaryKey),
      credential: asanaKey ? maskKey(asanaKey) : null,
      last_sync: healthByName.asana_secondary?.last_sync || null,
      last_check: healthByName.asana_secondary?.last_check || healthByName.asana?.last_check || null,
      locked: false,
      section: 'productivity',
      substrate_type: 'api_key',
      doc_count: (asanaKey || asanaSecondaryKey) ? asanaTotalCount : 0,
      launch_state: asanaLaunchState,
      integration_error: asanaError,
      // st_bf4978b0 (QA round 3) — inherit Healthy from the freshest verified
      // workspace token; NULL when neither is verified. Never fabricated.
      verified_at: freshestHealthyChildVerifiedAt({
        provider: 'asana',
        substrate_type: 'api_key',
        accounts: [
          { provider: 'asana', sync_state: asanaState, connected: !!asanaKey, verified_at: healthByName.asana?.verified_at || null },
          { provider: 'asana_secondary', sync_state: asanaSecondaryState, connected: !!asanaSecondaryKey, verified_at: healthByName.asana_secondary?.verified_at || null },
        ],
      }),
      accounts: [
        {
          provider: 'asana',
          label: 'Primary',
          connected: !!asanaKey,
          credential: asanaKey ? maskKey(asanaKey) : null,
          products: { tasks: asanaKey ? asanaCount : 0 },
          sync_state: asanaState,
          last_sync: healthByName.asana?.last_sync || null,
          last_check: healthByName.asana?.last_check || null,
          verified_at: healthByName.asana?.verified_at || null,
          last_error: healthByName.asana?.last_error || null,
        },
        {
          provider: 'asana_secondary',
          label: 'Secondary',
          connected: !!asanaSecondaryKey,
          credential: asanaSecondaryKey ? maskKey(asanaSecondaryKey) : null,
          products: { tasks: asanaSecondaryKey ? asanaSecondaryCount : 0 },
          sync_state: asanaSecondaryState,
          last_sync: healthByName.asana_secondary?.last_sync || null,
          last_check: healthByName.asana_secondary?.last_check || null,
          verified_at: healthByName.asana_secondary?.verified_at || null,
          last_error: healthByName.asana_secondary?.last_error || null,
        },
      ],
      recovery: 'Paste Asana personal access tokens. Robot Dojo stores them in Keychain as robotdojo-ASANA_PAT and robotdojo-ASANA_PAT_SECONDARY.',
    }, findLaunchIntegration('asana', 'productivity')));
  }

  // Granola: local-cache based, no keychain_key — stays hardcoded after catalog loop.
  productivityCards.push(applyLaunchContract({
    provider: 'granola',
    name: 'Granola',
    connected: granolaConnected || granolaDocCount > 0,
    provider_identity: granolaAccountEmail ? { account: granolaAccountEmail } : null,
    doc_count: granolaDocCount,
    last_sync: healthByName['granola']?.last_sync || null,
    last_check: healthByName['granola']?.last_check || null,
    // st_bf4978b0 (QA round 3) — thread the health row's live verification so a
    // signed-in Granola renders Healthy, not a false Issue.
    verified_at: staleGranolaTokenError ? null : (healthByName['granola']?.verified_at || null),
    integration_error: staleGranolaTokenError ? null : granolaHealthError,
    locked: false,
    section: 'productivity',
    substrate_type: 'local',
    launch_state: granolaLaunchState,
    recovery: granolaInstalled
      ? 'Open the Granola Mac app and sign in. Robot Dojo imports transcripts automatically in the background.'
      : 'Install Granola, open the Mac app, sign in, then return to Robot Dojo.',
  }, findLaunchIntegration('granola', 'productivity')));

  const ouraCatalogRow = getKeychainIntegrationByProvider(db, 'oura') || {
    provider: 'oura',
    display_name: 'Oura',
    keychain_key: 'robotdojo-OURA_PAT',
  };
  const ouraKey = readCatalogKey({ ...ouraCatalogRow, provider: 'oura' });
  const ouraDataSources = ['oura-json', 'oura_sync'];
  const ouraDocCount = healthDataPointCount(ouraDataSources) + healthNoteCount('oura');
  const ouraState = ouraKey
    ? (backgroundStateFromHealth(healthByName.oura) || (ouraDocCount > 0 ? 'connected' : 'queued'))
    : (ouraDocCount > 0 ? 'connected' : 'needs_key');
  const appleHealthSources = ['apple-health', 'apple_health', 'apple-health-xml', 'apple_health_xml', 'fhir'];
  const appleHealthIngestionSources = ['apple-health-xml', 'apple-health', 'apple_health', 'apple_health_xml', 'fhir'];
  const appleHealthDataPointCount = healthDataPointCount(appleHealthSources);
  const appleHealthLastSync = latestHealthDataTimestamp(appleHealthSources) || latestHealthIngestionTimestamp(appleHealthIngestionSources);
  const labPdfDir = resolve(USER_DATABASES_DIR, 'health/archive/labs');
  const labPdfDocCount = Math.max(countHealthIngestionDocs(['pdf-lab']), countPdfFilesInDir(labPdfDir));
  const labDataPointCount = healthDataPointCount(['pdf-lab', 'pdf']);
  const labLastSync = latestHealthDataTimestamp(['pdf-lab', 'pdf']) || latestHealthIngestionTimestamp(['pdf-lab']);

  const healthCards = [
    applyLaunchContract({
      provider: 'oura',
      name: ouraCatalogRow.display_name || 'Oura',
      auth: 'api_key',
      connected: !!ouraKey || ouraDocCount > 0,
      credential: ouraKey ? maskKey(ouraKey) : null,
      doc_count: ouraDocCount,
      last_sync: healthByName.oura?.last_sync || latestHealthDataTimestamp(ouraDataSources) || null,
      last_check: healthByName.oura?.last_check || null,
      // st_bf4978b0 (QA round 3) — thread the health row's live verification so
      // a working Oura key renders Healthy, not a false Issue.
      verified_at: healthByName.oura?.verified_at || null,
      locked: false,
      section: 'health',
      substrate_type: 'api_key',
      launch_state: ouraState,
    }, findLaunchIntegration('oura', 'health')),
    applyLaunchContract({
      provider: 'apple-health',
      name: 'Apple Health files',
      connected: appleHealthDataPointCount > 0,
      doc_count: appleHealthDataPointCount,
      last_sync: appleHealthLastSync,
      section: 'health',
      substrate_type: 'local',
      launch_state: appleHealthDataPointCount > 0 ? 'connected' : 'ready',
      health_color: appleHealthDataPointCount > 0 ? 'green' : null,
      health_state: appleHealthDataPointCount > 0 ? 'done' : null,
      one_time_import: false,
      stale_sensitive: false,
    }, findLaunchIntegration('apple-health', 'health')),
    applyLaunchContract({
      provider: 'health-labs',
      name: 'Labs',
      connected: labDataPointCount > 0 || labPdfDocCount > 0,
      doc_count: labDataPointCount,
      doc_counts: { files: labPdfDocCount },
      last_sync: labLastSync,
      section: 'health',
      substrate_type: 'local',
      launch_state: (labDataPointCount > 0 || labPdfDocCount > 0) ? 'connected' : 'ready',
      health_color: (labDataPointCount > 0 || labPdfDocCount > 0) ? 'green' : null,
      health_state: (labDataPointCount > 0 || labPdfDocCount > 0) ? 'done' : null,
      one_time_import: true,
      stale_sensitive: false,
      recovery: 'Drop lab PDFs into ~/robotdojo/user/inbox or keep them in user/databases/health/archive/labs; Robot Dojo extracts lab data points when possible and skips unreadable files.',
    }, findLaunchIntegration('health-labs', 'health')),
  ];

  let monarchSession = null;
  let monarchCurrent = null;
  try {
    const { readStoredMonarchSession } = await import('../lib/monarch-auth.js');
    monarchSession = readStoredMonarchSession();
  } catch { monarchSession = null; }
  try {
    const { readCurrentPointer } = await import('../lib/monarch-store.js');
    monarchCurrent = readCurrentPointer();
  } catch { monarchCurrent = null; }
  const monarchConnected = !!(monarchSession || monarchCurrent || healthByName.monarch?.status === 'ok');
  const monarchLaunchState = strongestLaunchState([
    backgroundStateFromHealth(healthByName.monarch),
    monarchConnected ? 'connected' : 'needs_permission',
  ]);
  const financesCards = [
    applyLaunchContract({
      provider: 'monarch',
      name: 'Monarch',
      connected: monarchConnected,
      doc_count: 0,
      last_sync: healthByName.monarch?.last_sync || monarchCurrent?.week || monarchSession?.obtainedAt || null,
      last_check: healthByName.monarch?.last_check || null,
      verified_at: healthByName.monarch?.verified_at || null,
      locked: false,
      section: 'finances',
      substrate_type: 'local',
      launch_state: monarchLaunchState,
      recovery: 'Put the Monarch login in the Robot Dojo vault. Use a 1Password service account limited to that vault. Turn off Settings → Developer → Integrate with 1Password CLI so agents cannot see other vaults.',
    }, findLaunchIntegration('monarch', 'finances')),
  ];

  // ── Connected / total count + artifact total ───────────────────────────────

  const allCards = [...foundationCards, ...workspaceCards, ...productivityCards, ...healthCards, ...financesCards];
  const total = allCards.length;
  const connected = allCards.filter(c => c.connected).length;

  let total_artifacts = 0;
  for (const { products } of googleAccountCards) {
    total_artifacts += (products.gmail || 0) + (products.calendar || 0) + (products.drive || 0) + (products.contacts || 0);
  }
  for (const { products } of importAccountCards) {
    total_artifacts += products.email || 0;
  }
  // WHY: notionDocCount is now embedded in the notion card; extract it from productivityCards.
  const notionDocCount = productivityCards.find(c => c.provider === 'notion')?.doc_count || 0;
  total_artifacts += imessageCount + contactsCount + granolaDocCount + notionDocCount + ouraDocCount + appleHealthDataPointCount + labPdfDocCount + labDataPointCount;

  // Story st_d9fc573b — extend each card with the new uniform-table fields:
  //   section            — which sub-section this card lives in (for the flat table)
  //   status             — 'connected' | 'disconnected' (string form of `connected`)
  //   substrate_type     — 'api_key' | 'oauth' | 'app_credentials' | 'local'
  //   spend_30d_usd      — numeric for foundation models, null otherwise
  //   last_sync_at       — alias for last_sync (kept on cards that already had it)
  //
  // WHY annotate-in-place: the existing { sections: [...] } payload is consumed
  // by the current frontend; we keep it intact and add a flat `cards` array
  // alongside for the redesigned six-column table. Both shapes are read by
  // VC 14 (cards filter by section) and VC 17 (cards.find by provider).
  function annotateFoundation(card) {
    card.section = 'foundation_models';
    card.status = card.launch_state || (card.connected ? 'connected' : 'needs_key');
    card.substrate_type = card.auth === 'host' ? 'local' : 'api_key';
    const spend = spendByProvider.get(card.provider);
    card.spend_30d_usd = typeof spend === 'number' ? Number(spend.toFixed(2)) : 0;
    card.last_sync_at = card.last_sync || null;
    card.last_check_at = card.last_check || null;
    return card;
  }
  function annotateWorkspace(card) {
    card.section = 'workspace';
    card.status = card.launch_state || (card.connected ? 'connected' : (card.provider === 'microsoft' ? 'needs_key' : 'needs_oauth'));
    if (card.provider === 'apple') card.substrate_type = 'local';
    else if (card.provider === 'microsoft') card.substrate_type = 'app_credentials';
    else card.substrate_type = card.substrate_type || 'oauth';
    card.spend_30d_usd = null;
    card.last_sync_at = card.last_sync || null;
    card.last_check_at = card.last_check || null;
    return card;
  }
  function annotateProductivity(card) {
    card.section = 'productivity';
    card.status = card.launch_state || (card.connected ? 'connected' : 'needs_key');
    if (card.provider === 'granola') card.substrate_type = 'local';
    else card.substrate_type = 'api_key';
    card.spend_30d_usd = null;
    card.last_sync_at = card.last_sync || null;
    card.last_check_at = card.last_check || null;
    return card;
  }
  for (const card of foundationCards) {
    Object.assign(annotateFoundation(card), applyLaunchContract(card, card._launch_contract || findLaunchIntegration(card.provider, 'foundation_models')));
    delete card._launch_contract;
  }
  for (const card of workspaceCards) Object.assign(annotateWorkspace(card), applyLaunchContract(card));
  for (const card of productivityCards) Object.assign(annotateProductivity(card), applyLaunchContract(card));
  healthCards.forEach((card) => {
    card.section = 'health';
    card.status = card.launch_state || card.status || (card.connected ? 'connected' : 'ready');
    card.substrate_type = card.substrate_type || (card.provider === 'oura' ? 'api_key' : 'local');
    card.spend_30d_usd = null;
    card.last_sync_at = card.last_sync || null;
    card.last_check_at = card.last_check || null;
    Object.assign(card, applyLaunchContract(card));
  });
  for (const card of financesCards) {
    card.section = 'finances';
    card.status = card.launch_state || (card.connected ? 'connected' : 'needs_permission');
    card.substrate_type = 'local';
    card.spend_30d_usd = null;
    card.last_sync_at = card.last_sync || null;
    card.last_check_at = card.last_check || null;
    Object.assign(card, applyLaunchContract(card));
  }
  // Flat cards array — the new six-column uniform table (AC 12, 14, 17)
  // reads from this. The old `sections` array stays for backward compat
  // with the existing frontend until Phase 2 swaps the renderer.
  const flatCards = [...foundationCards, ...workspaceCards, ...productivityCards, ...healthCards, ...financesCards]
    .map((card) => Object.assign(card, normalizeLaunchCard(card)));

  const payload = {
    robot_dojo: stampFirstPartyLiveness(getRobotDojoCountSnapshot(db)),
    count_snapshot: { updatedAt: new Date().toISOString(), refresh: 'periodic' },
    sections: [
      { id: 'foundation_models', label: 'Foundation Models', cards: foundationCards },
      { id: 'workspace',         label: 'Workspace',         cards: workspaceCards },
      { id: 'productivity',      label: 'Productivity',      cards: productivityCards },
      { id: 'health',            label: 'Health',            cards: healthCards },
      { id: 'finances',          label: 'Finances',          cards: financesCards },
    ],
    cards: flatCards,
    connected,
    total,
    total_artifacts,
    passive_jobs: safePassiveSummary(),
  };

  // Cache the assembled payload briefly. The cache is busted by
  // every key write/delete (bustIntegrationCardsCache called above) so a
  // user adding a key sees the new state on the next request.
  integrationCardsCache.set(userKey, {
    payload,
    expiresAt: Date.now() + INTEGRATION_CARDS_TTL_MS,
    updatedAt: new Date().toISOString(),
  });
  return payload;
}

routes.get('/api/accounts/integration-cards', async (c) => {
  return c.json(await getIntegrationCardsPayload(c));
});

routes.get('/api/accounts/integrations-dashboard', async (c) => {
  const payload = await getIntegrationCardsPayload(c);
  return c.json(dashboardFromIntegrationCards(payload));
});

routes.post('/api/integrations/microsoft/connect', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const email = String(body?.email || body?.mailbox || '').trim().toLowerCase();
  const displayName = String(body?.displayName || body?.display_name || email || 'Microsoft mailbox').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: 'mailbox_email_required', message: 'Enter the mailbox email to import with Microsoft Graph.' }, 400);
  }
  if (!secret('MICROSOFT_TENANT_ID') || !secret('MICROSOFT_CLIENT_ID') || !secret('MICROSOFT_CLIENT_SECRET')) {
    return c.json({
      error: 'microsoft_app_credentials_required',
      message: 'Store Microsoft tenant ID, client ID, and client secret first. Then grant Graph application permissions and add the mailbox.',
    }, 409);
  }

  try {
    await getClientCredentialsToken();
    const roles = await getMicrosoftAppRoles();
    const support = microsoftRolesSupport(roles);
    if (!support.mail) {
      return c.json({
        error: 'microsoft_mail_permission_required',
        message: 'Grant Microsoft Graph Application permission Mail.Read or Mail.ReadWrite, click Grant admin consent, then add the mailbox again.',
        roles_present: roles,
      }, 409);
    }

    const accountTypes = support.calendar ? ['email', 'calendar'] : ['email'];
    upsertMicrosoftAccounts(db, email, displayName, accountTypes);
    const jobs = support.calendar ? ['microsoft-mail', 'microsoft-calendar'] : ['microsoft-mail'];
    queueOAuthSync(db, 'microsoft', email, { jobs });
    markIntegrationHealth('microsoft', 'ok');
    bustIntegrationCardsCache(c.get('user')?.id ?? 'anon');
    return c.json({
      ok: true,
      provider: 'microsoft',
      email,
      permissions: support,
      queued: jobs,
      message: support.calendar
        ? 'Microsoft mailbox connected. Mail and calendar imports are queued.'
        : 'Microsoft mailbox connected. Mail import is queued. Add Calendars.Read application permission and grant admin consent to enable calendar imports.',
    });
  } catch (err) {
    markIntegrationHealth('microsoft', 'error', err.message);
    bustIntegrationCardsCache(c.get('user')?.id ?? 'anon');
    return c.json({
      error: 'microsoft_graph_app_failed',
      message: err.message,
    }, 502);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Story st_d9fc573b — accounts-page-cleanup endpoints
// ─────────────────────────────────────────────────────────────────────────────
//
// Auth: every endpoint below relies on the global /api/* cookie-or-Bearer
// middleware in lib/server.js. We do not re-declare requireAuth() here — the
// upstream middleware already populates c.var.user from either auth path.

/**
 * GET /api/accounts/about — single inline row for the Admin tab About box.
 * Story st_d9fc573b — AC 2.
 *
 * Source: package.json (version + license). Build date from process.env or
 * package.json.buildDate or today. GitHub URL is a constant.
 *
 * WHY no DB: this is pure deployment metadata. Computing it on every request
 * is cheap; caching here would just move the staleness window to no benefit.
 */
routes.get('/api/accounts/about', (c) => {
  let pkg = {};
  try {
    // import.meta.dirname is the absolute path of routes/, so go up one level.
    const pkgPath = resolve(import.meta.dirname, '..', 'package.json');
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    // Fall back to safe defaults — getAboutInfo handles missing fields.
  }
  return c.json({ ...getAboutInfo(pkg), fork_status: getForkStatus() });
});

routes.get('/api/accounts/app-state', async (c) => {
  let about = getAboutInfo({});
  try {
    const pkgPath = resolve(ROOT, 'package.json');
    about = getAboutInfo(JSON.parse(readFileSync(pkgPath, 'utf8')));
  } catch {}
  const include = new Set(String(c.req.query('include') || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean));
  const integrations = { cache: { refresh: 'periodic', ttl_ms: INTEGRATION_CARDS_TTL_MS } };
  if (include.has('integrations')) {
    integrations.payload = await getIntegrationCardsPayload(c);
  }
  return c.json({
    about: { ...about, fork_status: getForkStatus() },
    nav: ['how-to', 'general', 'integrations', 'agents', 'skills', 'you', 'shortcuts'],
    token: { configured: !!config.authToken },
    integrations,
  });
});

/**
 * GET /api/accounts/agents-md — legacy roster blob endpoint.
 * Story st_d9fc573b — AC 8, AC 9.
 *
 * st_4e7e3aaf AC9 replaces the Agents UI with per-persona cards via
 * /api/accounts/agent-personas. This older endpoint is preserved for any
 * external integration still polling it; the Accounts UI no longer renders
 * from it. Returns { content, state } as before.
 */
routes.get('/api/accounts/agents-md', (c) => {
  const force = c.req.query('force_state');
  const opts = force === 'new_user' ? { forceState: 'new_user' } : {};
  return c.json(getAgentsMdForFrontend(db, opts));
});

/**
 * GET /api/accounts/persona-sync — list every persona sync target with its
 * enabled/disabled state. Canonical supported targets always appear; any
 * extra stored targets (e.g. test fixtures, future products) appear after.
 */
routes.get('/api/accounts/persona-sync', (c) => {
  return c.json(getPersonaSyncTargets(db));
});

/**
 * POST /api/accounts/persona-sync — toggle a single target.
 * Body: { target: <id>, enabled: true|false }
 *
 * Accepts arbitrary target IDs (so test code can round-trip without
 * polluting the canonical list). The GET endpoint surfaces both canonical
 * and stored-but-unknown targets so the toggle is observable.
 */
routes.post('/api/accounts/persona-sync', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const target = typeof body?.target === 'string' ? body.target.trim() : '';
  if (!target) {
    return c.json({ error: 'missing_target' }, 400);
  }
  const enabled = !!body?.enabled;
  try {
    setPersonaSyncTarget(db, target, enabled);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: 'storage_failed', message: err.message }, 500);
  }
});

/**
 * GET /api/accounts/memory-prompt — return the foundation-model memory
 * export prompt for the Integrations tab click-to-copy card.
 * Story st_d9fc573b — AC 13. Prompt body is ≥ 800 chars.
 */
routes.get('/api/accounts/memory-prompt', (c) => {
  const payload = getMemoryPrompt();
  const etag = `"${payload.hash}"`;
  c.header('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
  c.header('ETag', etag);
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
  return c.json(payload);
});

/**
 * POST /api/accounts/seed-profile — ingest a foundation-model identity dump
 * as high-weight source (timeline + memory log). Miyagi then confirms with
 * the user before treating facts as settled. Does not overwrite the standing
 * profile on paste.
 */
routes.post('/api/accounts/seed-profile', async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch { /* empty body */ }
  const text = String(body?.text || '').trim();
  const conversationId = String(body?.conversationId || body?.conversation_id || '').trim() || null;
  const { ingestIdentityDump } = await import('../lib/identity-dump.js');
  const result = await ingestIdentityDump({ database: db, text, conversationId });
  if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
  return c.json({
    ok: true,
    ingested: true,
    source_id: result.sourceId,
    timeline_event_id: result.timelineEventId,
    chars: result.chars,
    chunks: result.chunks,
  });
});

/**
 * GET /api/accounts/invite-targets — personal leg (3 rows) + paginated
 * professional leg (st_b879a361). The professional leg is filtered by the
 * YC + big-tech + VC + AI-content qualification (referral_scores.qualifies_
 * for_referral=1) and sorted by the 4-tier order (has_path_c DESC,
 * company_priority_tier ASC, role_bucket_priority ASC, last_seen DESC).
 *
 * Query params:
 *   ?offset=N — page offset (clamped to [0, 30])
 *   ?limit=N  — page size (default 10, max remaining-cap)
 *
 * Response: { personal: [...], professional: { items, offset, has_more, total } }
 */
routes.get('/api/accounts/invite-targets', (c) => {
  const offsetRaw = c.req.query('offset');
  const limitRaw  = c.req.query('limit');
  const offset = offsetRaw !== undefined ? Math.max(0, Math.min(30, Number(offsetRaw) || 0)) : 0;
  const limit  = limitRaw  !== undefined ? Math.max(1, Math.min(30, Number(limitRaw)  || 10)) : 10;
  try {
    return c.json(getInviteTargets(db, { offset, limit }));
  } catch (err) {
    return c.json({
      error: 'storage_failed',
      message: err.message,
      personal: [],
      professional: { items: [], offset, has_more: false, total: 0 },
    }, 500);
  }
});

// --- Identity ---
// Identity routes moved to routes/identity.js (2026-04-19) — they now read
// from the hash-chained identity log under the private user substrate.

// --- Accounts ---

routes.get('/api/accounts', (c) => {
  try {
    // df_355651ca AC4 — advertisable rows only: api_key rows flagged
    // needs_credential are withheld from sessions (the hook renders every
    // api_key row it receives). OAuth rows always pass through (AC5).
    const rows = listAdvertisableAccounts(db);
    // Mask credentials — never expose secrets to the frontend
    const masked = rows.map(r => {
      const row = { ...r };
      if (row.credential) {
        try {
          const cred = JSON.parse(row.credential);
          const safe = {};
          for (const [k, v] of Object.entries(cred)) {
            if (typeof v === 'string' && v.length > 8) safe[k] = v.slice(0, 4) + '****' + v.slice(-4);
            else if (typeof v === 'string') safe[k] = '****';
            else safe[k] = v;
          }
          row.credential = JSON.stringify(safe);
        } catch {
          row.credential = '****';
        }
      }
      return row;
    });
    return c.json(masked);
  } catch {
    return c.json([]);
  }
});

routes.get('/api/accounts/mailboxes', (c) => {
  return c.json({ mailboxes: listMailboxAccounts(db) });
});

routes.patch('/api/accounts/:id/topic', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const result = setAccountTopic(db, id, body.topic_slug);
  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : 400;
    return c.json({ error: result.reason }, status);
  }
  bustIntegrationCardsCache(null);
  const script = fileURLToPath(new URL('../scripts/migrate-source-topics.js', import.meta.url));
  spawn(process.execPath, [script, '--limit', '800'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ROBOTDOJO_ALLOW_PLAINTEXT: process.env.ROBOTDOJO_ALLOW_PLAINTEXT || '1' },
  }).unref();
  return c.json(result);
});

/**
 * GET /api/accounts/dojo-token — surface the dojo's ROBOTDOJO_AUTH_TOKEN
 * to the accounts page (st_5a63545d AC 15). The token is the cross-device
 * login credential — pasted at /login on another device to sign in.
 *
 * Auth: requires an authenticated session (the global /api/* middleware
 * gates this route; only an already-signed-in operator can see the token).
 * WHY surface plaintext: this is the operator's own secret on their own
 * machine — the entire point of showing it is "copy it to another device".
 * Display is gated by session, not Bearer, so Referer-leaking via tab
 * sharing doesn't expose it.
 */
routes.get('/api/accounts/dojo-token', (c) => {
  const token = config.authToken;
  if (!token) return c.json({ error: 'not_configured' }, 503);
  return c.json({ token });
});

routes.put('/api/accounts/dojo-token', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (token.length < 24) return c.json({ error: 'token_too_short' }, 400);
  const ok = keychainWrite('robotdojo-ROBOTDOJO_AUTH_TOKEN', token);
  if (!ok) return c.json({ error: 'keychain_write_failed' }, 500);
  overrideSecret('ROBOTDOJO_AUTH_TOKEN', token);
  return c.json({ ok: true, token });
});

routes.post('/api/accounts/dojo-token/rotate', (c) => {
  const token = mintAuthToken();
  const ok = keychainWrite('robotdojo-ROBOTDOJO_AUTH_TOKEN', token);
  if (!ok) return c.json({ error: 'keychain_write_failed' }, 500);
  overrideSecret('ROBOTDOJO_AUTH_TOKEN', token);
  const userId = c.get('user')?.id;
  const signedOutSessions = userId ? destroySessionsForUser(userId) : 0;
  return c.json({ ok: true, token, signed_out_sessions: signedOutSessions });
});

routes.get('/api/accounts/edit-targets', (c) => c.json(editTargetsPayload()));

// st_4e7e3aaf AC9 — Agents page renders six per-persona cards in canonical
// PERSONA_ORDER via lib/agent-personas.js. This route is plumbing only —
// the lib function does the read + frontmatter parse + body extraction.
routes.get('/api/accounts/agent-personas', (c) => {
  try {
    return c.json(accountPersonaCards());
  } catch (err) {
    return c.json({ error: 'personas_unavailable', detail: err?.message || 'read failed' }, 500);
  }
});

// st_4e7e3aaf AC10 — open the underlying real file for an account edit-target
// (You / Skills) in the user's default editor. Auth-gated by the global
// /api/* Bearer middleware in lib/server.js; never added to PUBLIC_ROUTES.
// Path is resolved server-side from editTargetMap() — client supplies only an
// id, never a path.
routes.get('/api/accounts/open-target', (c) => {
  const id = String(c.req.query('id') || '').trim();
  if (!id) return c.json({ error: 'missing_id' }, 400);
  const result = openEditTarget(id, editTargetMap());
  if (result.error === 'unknown_target') return c.json(result, 404);
  if (result.error) return c.json(result, 500);
  return c.json(result);
});

// st_4e7e3aaf AC11 — Granola "Sign in" opens the local Granola app via
// `open -a`. Allowlist is in lib/accounts-open-app.js — Granola only.
routes.get('/api/accounts/open-app', (c) => {
  const name = String(c.req.query('name') || '').trim();
  if (!name) return c.json({ error: 'missing_name' }, 400);
  const result = openApp(name);
  if (result.error === 'unknown_app') return c.json(result, 400);
  if (result.error) return c.json(result, 500);
  return c.json(result);
});

// st_4e7e3aaf AC11 — Apple FDA "Open Full Disk Access settings" deep-links
// into System Settings. Pane is resolved from a server-side allowlist key,
// never from a raw URL the client supplies.
routes.get('/api/accounts/open-settings', (c) => {
  const pane = String(c.req.query('pane') || '').trim();
  if (!pane) return c.json({ error: 'missing_pane' }, 400);
  const result = openSettingsPane(pane);
  if (result.error === 'unknown_pane') return c.json(result, 400);
  if (result.error) return c.json(result, 500);
  return c.json(result);
});

routes.get('/api/accounts/profile-defaults', (c) => c.json(profileDefaultsFromUserMd()));

routes.get('/api/accounts/local-permission-target', (c) => {
  const settingsUrl = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
  const appPath = process.env.ROBOTDOJO_PERMISSION_APP || resolve(homedir(), 'Applications', 'Robot Dojo.app');
  const appRuntimePath = resolve(appPath, 'Contents', 'MacOS', 'Robot Dojo');
  const launcherPath = process.env.ROBOTDOJO_PERMISSION_LAUNCHER || resolve(config.configDir || resolve(homedir(), '.robotdojo'), 'bin', 'Robot Dojo');
  const appExists = existsSync(appPath);
  const appRuntimeExists = existsSync(appRuntimePath);
  const launcherExists = existsSync(launcherPath);
  const actualRuntimePath = process.execPath;
  const actualIsRobotDojo = actualRuntimePath === appRuntimePath || actualRuntimePath.includes('/Robot Dojo.app/');
  const shouldGrantRobotDojo = appExists && actualIsRobotDojo;
  const permissionTargetPath = shouldGrantRobotDojo ? appPath : actualRuntimePath;
  const permissionTargetName = shouldGrantRobotDojo ? 'Robot Dojo' : 'node';
  return c.json({
    app_name: 'Robot Dojo',
    app_path: appPath,
    app_exists: appExists,
    app_runtime_path: appRuntimePath,
    app_runtime_exists: appRuntimeExists,
    launcher_path: launcherPath,
    launcher_exists: launcherExists,
    helper_name: 'Robot Dojo',
    helper_path: launcherExists ? launcherPath : appPath,
    permission_target_name: permissionTargetName,
    permission_target_path: permissionTargetPath,
    runtime_name: actualIsRobotDojo ? 'Robot Dojo' : 'node',
    runtime_path: actualRuntimePath,
    node_path: actualRuntimePath,
    fallback_node_path: process.env.ROBOTDOJO_NODE_BIN || null,
    running_robot_dojo_runtime: actualIsRobotDojo,
    launch_agent_label: 'com.robotdojo.server',
    settings_url: settingsUrl,
    open_settings_command: `open "${settingsUrl}"`,
  });
});

routes.get('/api/accounts/edit-targets/:targetId', (c) => {
  const target = editTargetMap().get(c.req.param('targetId'));
  if (!target) return c.json({ error: 'unknown_target' }, 404);
  return c.json({ id: target.id, label: target.label, path: target.relPath, content: target.content });
});

routes.post('/api/accounts/edit-targets/:targetId', async (c) => {
  const target = editTargetMap().get(c.req.param('targetId'));
  if (!target) return c.json({ error: 'unknown_target' }, 404);
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const content = typeof body?.content === 'string' ? body.content : '';
  if (content.length < 1) return c.json({ error: 'empty_content' }, 400);
  writeFileSync(target.path, content, 'utf8');
  return c.json({ ok: true, id: target.id, path: target.relPath });
});

routes.post('/api/accounts/feature-request', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const description = String(body?.description || body?.body || '').trim();
  const email = String(body?.email || '').trim();
  if (description.length < 10) return c.json({ error: 'description_required' }, 400);
  const payload = {
    kind: 'feature_request',
    description,
    email,
    url: body?.url || c.req.header('referer') || '',
    userAgent: c.req.header('user-agent') || '',
    source: 'Accounts > Feature Request',
  };
  try {
    const res = await fetch('https://robotdojo.ai/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return c.json({ error: 'feedback_unavailable', fallback: 'Email miyagi@robotdojo.ai with this request.' }, 503);
    }
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'feedback_unavailable', fallback: 'Email miyagi@robotdojo.ai with this request.' }, 503);
  }
});

routes.get('/api/accounts/vendors', (c) => {
  // Return vendor definitions (used by "Add Account" form and integration registry)
  return c.json({
    google:      { name: 'Google',       auth: 'oauth',    types: ['email', 'calendar', 'drive'] },
    microsoft:   { name: 'Microsoft',    auth: 'app_credentials', types: ['email', 'calendar'] },
    anthropic:   { name: 'Anthropic',    auth: 'api_key',  types: ['other'] },
    asana:       { name: 'Asana',        auth: 'api_key',  types: ['task'] },
    asana_secondary:   { name: 'Asana (Secondary)', auth: 'api_key',  types: ['task', 'other'] },
    elevenlabs:  { name: 'ElevenLabs',   auth: 'api_key',  types: ['voice'] },
    speechify:   { name: 'Speechify',    auth: 'api_key',  types: ['voice'] },
    stripe:      { name: 'Stripe',       auth: 'api_key',  types: ['payments'] },
    openai:      { name: 'OpenAI',       auth: 'api_key',  types: ['other'] },
    notion:      { name: 'Notion',       auth: 'api_key',  types: ['other'] },
    oura:        { name: 'Oura',         auth: 'api_key',  types: ['health'] },
    figma:       { name: 'Figma',        auth: 'api_key',  types: ['other'] },
    brave:       { name: 'Brave Search', auth: 'api_key',  types: ['other'] },
    godaddy:     { name: 'GoDaddy',      auth: 'api_key',  types: ['domains'] },
    slab:        { name: 'Slab',         auth: 'api_key',  types: ['other'] },
    iproyal:     { name: 'iProyal',      auth: 'api_key',  types: ['proxy'] },
  });
});

routes.get('/api/accounts/imports', async (c) => {
  // Status-only read path: polling this endpoint must not start snapshot
  // recompute, embedding, import, sync, checkpoint, or compaction work.
  // Nightly/idle workers refresh imports_snapshot; the UI sees stale state
  // honestly instead of paying the compute cost in the foreground.
  const freshness = getImportsSnapshotFreshness(db);
  const rows = listImportsSnapshot(db);
  const dropFolderRows = listDropFolderImportRows(db);
  return c.json({
    ...buildImportsEnvelope({ snapshotRows: rows, dropFolderRows, freshness }),
    passive_jobs: safePassiveSummary(['drop_folder_import', 'llm_export_import', 'health_import', 'imports_snapshot']),
  });
});

routes.post('/api/accounts/imports/refresh', async (c) => {
  // Compatibility endpoint only. Import snapshot recompute is background work
  // owned by scripts/sync.js/nightly.js, never an Accounts-page foreground job.
  recordIntegrationJobHealth(db, 'imports-snapshot', 'queued');
  const freshness = getImportsSnapshotFreshness(db);
  return c.json({
    ok: true,
    status: 'queued',
    message: 'Import refresh is queued for the background worker.',
    freshness: buildImportsEnvelope({ snapshotRows: [], dropFolderRows: [], freshness }).freshness,
    passive_jobs: safePassiveSummary(['imports_snapshot']),
  }, 202);
});

routes.get('/api/accounts/llm-providers', (c) => {
  const mask = (key) => key && key.length > 8 ? key.slice(0, 4) + '****' + key.slice(-4) : key ? '****' : null;

  const providers = [
    {
      name: 'Anthropic (Claude)',
      env: 'ANTHROPIC_API_KEY',
      models: [MODELS.opus, MODELS.sonnet, MODELS.haiku],
      key: config.anthropicKey,
    },
    {
      name: 'Google (Gemini)',
      env: 'GOOGLE_AI_API_KEY',
      models: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'],
      key: config.googleAiKey,
    },
    {
      name: 'OpenAI',
      env: 'OPENAI_API_KEY',
      models: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
      key: config.openaiKey,
    },
    {
      name: 'xAI',
      env: 'XAI_API_KEY',
      models: ['grok-4.20-0309-non-reasoning', 'grok-4.3', 'grok-4.20-0309-reasoning'],
      key: config.xaiKey,
    },
    {
      name: 'Ollama (local)',
      env: 'OLLAMA_HOST',
      models: ['llama3.2', 'qwen2.5-coder', 'mistral'],
      key: config.ollamaHost,  // Not a secret — just a host URL
    },
  ].map(p => ({
    name: p.name,
    env: p.env,
    models: p.models,
    active: !!p.key,
    // Ollama host is a plain URL, not a masked secret
    credential: p.name === 'Ollama (local)' ? p.key : (mask(p.key) || '—'),
    mtdSpend: 0,
    subscription: '',
  }));

  return c.json(providers);
});

routes.get('/api/accounts/secrets-status', (c) => {
  // Query all accounts that use Keychain-stored API keys
  const rows = listAccountsWithKeychainKey(db);

  const secrets = Object.fromEntries(
    [...ACCOUNT_SECRET_ALLOWLIST.keys()].map((key) => [key, secretStatus(key)])
  );
  for (const row of rows) {
    const val = readProviderKey(row.vendor, row.keychain_key, { cached: true });
    const present = val !== null && val !== '';
    // When multiple rows share a vendor (shouldn't happen, but guard anyway),
    // mark present=true if ANY row for that vendor has the key
    if (!secrets[row.vendor] || present) {
      secrets[row.vendor] = {
        display_name: row.display_name,
        label: row.display_name,
        keychain_key: row.keychain_key,
        configured: present,
        present,
      };
    }
  }

  return c.json({
    secrets,
    vendorSecrets: {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      speechify: 'SPEECHIFY_API_KEY',
      google: 'GOOGLE_AI_API_KEY',
      google_ai: 'GOOGLE_AI_API_KEY',
      xai: 'XAI_API_KEY',
      ollama: 'OLLAMA_HOST',
    },
  });
});
export default routes;
