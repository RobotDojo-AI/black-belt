/**
 * Configuration — keychain secrets + environment overrides.
 * macOS Keychain is source of truth. Env vars override for CI/testing.
 */
// INTELLIGENCE_TIER: orchestration — MODELS references here are model-lane
// config resolution (keychain/env), not an LLM call.
export const INTELLIGENCE_TIER = 'orchestration';

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { PRICING } from './pricing.js';
import { MODELS } from './compute-tier.js';
import { readKeychainSecret } from './keychain.js';
import { PREFERRED_IDS, isStableChatId, flatPreferred } from './model-allowlists.js';

// ── Dynamic model resolution ──────────────────────────────────────────────

const _REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
// ROBOTDOJO_MODELS_JSON overrides the catalog path (tests point config at a temp
// file). Optional, safe default — never required for the app to boot.
const _MODELS_JSON = process.env.ROBOTDOJO_MODELS_JSON
  ? resolvePath(process.env.ROBOTDOJO_MODELS_JSON)
  : resolvePath(_REPO_ROOT, 'config', 'models.json');
const _PRIVATE_JSON = resolvePath(_REPO_ROOT, 'config', 'private.json');
const CONFIG_DIR = process.env.ROBOTDOJO_CONFIG || resolvePath(homedir(), '.robotdojo');

const _MODEL_DEFAULTS = {
  anthropic: { best: MODELS.opus, balanced: MODELS.sonnet, fast: MODELS.haiku },
  openai:    { best: 'o3-mini', balanced: 'gpt-4o', fast: 'gpt-4o-mini' },
  google:    { best: 'gemini-2.5-pro', balanced: 'gemini-2.5-flash', fast: 'gemini-2.5-flash-lite' },
  xai:       { best: 'grok-4.20-0309-reasoning', balanced: 'grok-4.3', fast: 'grok-4.20-0309-non-reasoning' },
  mistral:   { best: 'mistral-large-latest', balanced: 'mistral-small-latest',  fast: 'mistral-small-latest' },
};

// ── Reload mechanism (df_a00a336b AC2) — throttled mtime revalidation ─────────
//
// WHY reader-side, not event-at-source: update-models.js rewrites models.json
// from a spawned grandchild of the separate maintenance-worker process, two
// process boundaries from the server. A reloadModels() call there can never
// reach THIS process's cache. So the reader itself must notice the file moved.
//
// WHY throttled (Chat-Speed P0): getModel sits on the chat TTFT path. A naive
// stat-on-every-read adds a syscall to every request. Instead we cache the
// parsed catalog plus its mtime and the wall-clock of the last stat, and do at
// most one statSync per STAT_THROTTLE_MS window across ALL requests; between
// stats it is a pure in-memory return (zero syscalls). A warm-inode stat is
// single-digit microseconds against a multi-hundred-ms TTFT budget, and it is
// amortized to well under one stat per request under load. A lane edit lands
// within <=STAT_THROTTLE_MS with no restart — the file changes ~daily, so 5s is
// ample. Tests set the throttle to 0 to force per-call revalidation.
const _DEFAULT_STAT_THROTTLE_MS = 5000;
function _statThrottleMs() {
  const raw = process.env.ROBOTDOJO_MODELS_STAT_THROTTLE_MS;
  if (raw === undefined || raw === '') return _DEFAULT_STAT_THROTTLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : _DEFAULT_STAT_THROTTLE_MS;
}

// The whole parsed catalog: { providers, available }. `available` is the layer-1
// per-provider callable-ID index (df_a00a336b Decision C); absent on a
// pre-refresh file, which reads as an empty index → fail-open (never worse than
// today). Keep-last-known on read/parse error: we never fall back to defaults
// once a good catalog is in hand, so a torn read mid-write is invisible.
let _loadedCatalog = null;   // { providers, available }
let _loadedMtimeMs = 0;      // mtime the current catalog was loaded from
let _lastStatMs = 0;         // wall-clock of the last statSync

function _normalizeCatalog(parsed) {
  return {
    providers: (parsed && parsed.providers) || _MODEL_DEFAULTS,
    available: (parsed && parsed.available) || {},
  };
}

// Return the live catalog, revalidating against the file's mtime at most once
// per throttle window. Cold load populates the cache; thereafter a pure
// in-memory return until the window elapses. On any stat/read/parse failure the
// last-known catalog is kept (graceful degradation).
function _catalog() {
  const now = Date.now();
  if (_loadedCatalog === null) {
    try {
      if (existsSync(_MODELS_JSON)) {
        _loadedMtimeMs = statSync(_MODELS_JSON).mtimeMs;
        _loadedCatalog = _normalizeCatalog(JSON.parse(readFileSync(_MODELS_JSON, 'utf8')));
      } else {
        _loadedCatalog = _normalizeCatalog(null);
        _loadedMtimeMs = 0;
      }
    } catch {
      _loadedCatalog = _normalizeCatalog(null);
      _loadedMtimeMs = 0;
    }
    _lastStatMs = now;
    return _loadedCatalog;
  }
  if (now - _lastStatMs < _statThrottleMs()) return _loadedCatalog;
  _lastStatMs = now;
  let mtimeMs;
  try {
    mtimeMs = statSync(_MODELS_JSON).mtimeMs;
  } catch {
    return _loadedCatalog; // file vanished mid-write — keep last-known
  }
  if (mtimeMs !== _loadedMtimeMs) {
    try {
      const next = _normalizeCatalog(JSON.parse(readFileSync(_MODELS_JSON, 'utf8')));
      _loadedCatalog = next;
      _loadedMtimeMs = mtimeMs;
    } catch {
      // Torn read (caught update-models.js mid-write) — keep the last-known
      // catalog and DO NOT advance the mtime, so the next window retries.
    }
  }
  return _loadedCatalog;
}

function _loadModels() {
  return _catalog().providers;
}

// availabilitySet memo — rebuilt only when the underlying `available` object
// reference changes (i.e. on an actual reload), so the hot path never rebuilds
// a Set. Keyed by the object reference _normalizeCatalog minted on load.
let _availSetCache = null;   // Map<provider, Set<string>>
let _availSetSource = null;  // the `available` object the cache was built from

/**
 * The live callable-ID Set for a provider (df_a00a336b layer 1). Empty Set when
 * the catalog carries no availability index for that provider (pre-refresh /
 * fresh install / a provider whose fetch keeps failing) — callers treat an empty
 * set as "no data yet → fail open".
 */
export function availabilitySet(provider) {
  const available = _catalog().available || {};
  if (_availSetSource !== available) {
    _availSetCache = new Map();
    _availSetSource = available;
  }
  if (_availSetCache.has(provider)) return _availSetCache.get(provider);
  const list = available[provider];
  const set = new Set(Array.isArray(list) ? list : []);
  _availSetCache.set(provider, set);
  return set;
}

/**
 * Resolve a pinned model id to one that is actually callable right now
 * (df_a00a336b AC3). If `pinnedId` is present in the provider's live
 * availability set it is returned unchanged (the common O(1) case). If it has
 * been retired, walk an ordered fallback chain — the current config lanes then
 * the flattened preferred allowlist — and return the first entry that is both
 * present AND a stable chat id. Fail open: when there is no availability data,
 * or nothing present qualifies, return `pinnedId` so the call fails loudly at
 * the provider rather than silently emitting null.
 *
 * RECURSION GUARD (load-bearing): getModel routes its lane id THROUGH this
 * function, so this function must NEVER call getModel. It reads lane ids and the
 * availability set DIRECTLY from the raw in-memory catalog (`_catalog()` /
 * `availabilitySet`), one level below the getModel wrap. Sourcing the fallback
 * lanes via getModel would recurse resolveAvailableId → getModel →
 * resolveAvailableId forever on a retired id — exactly when the fallback fires.
 */
export function resolveAvailableId(provider, pinnedId) {
  if (!pinnedId) return pinnedId;                 // getModel may legitimately yield null
  const avail = availabilitySet(provider);
  if (avail.size === 0) return pinnedId;          // no index yet → never worse than today
  if (avail.has(pinnedId)) return pinnedId;       // present → the common case, O(1)

  // Retired: build the ordered fallback chain from the RAW catalog (not getModel).
  const lanes = _catalog().providers?.[provider] || _MODEL_DEFAULTS[provider] || {};
  const chain = [];
  for (const tier of ['best', 'balanced', 'fast']) {
    if (lanes[tier]) chain.push(lanes[tier]);
  }
  for (const id of flatPreferred(provider)) chain.push(id);

  const seen = new Set();
  for (const id of chain) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (avail.has(id) && isStableChatId(id)) {
      if (id !== pinnedId) {
        console.warn(`[models] fallback ${provider} pinned ${pinnedId}→present ${id}`);
      }
      return id;
    }
  }
  return pinnedId;                                 // nothing present — fail loud, not null
}

let _loadedPrivateConfig = null;
function privateSetting(key) {
  if (!_loadedPrivateConfig) {
    try {
      _loadedPrivateConfig = existsSync(_PRIVATE_JSON)
        ? JSON.parse(readFileSync(_PRIVATE_JSON, 'utf8'))
        : {};
    } catch {
      _loadedPrivateConfig = {};
    }
  }
  return key.split('.').reduce((obj, part) => obj?.[part], _loadedPrivateConfig) || '';
}

/**
 * Get the current model ID for a provider+tier pair, resolved to a currently-
 * callable id (df_a00a336b AC3). The raw lane id is looked up from the catalog
 * (falling back to the static defaults), then routed through resolveAvailableId
 * so a retired lane never reaches a provider.
 */
function activeSpendProvider() {
  try {
    const parsed = JSON.parse(readFileSync(resolvePath(_REPO_ROOT, 'config', 'tier-policy.json'), 'utf8'));
    return parsed.provider || 'xai';
  } catch {
    return 'xai';
  }
}

export function getModel(provider, tier) {
  const providers = _loadModels();
  const laneId = providers[provider]?.[tier] ?? _MODEL_DEFAULTS[provider]?.[tier] ?? null;
  return resolveAvailableId(provider, laneId);
}

/**
 * Force an immediate reload of config/models.json. Used as a test/primitive
 * hook; normal freshness comes from the throttled mtime revalidation in
 * _catalog(). Nulling _loadedCatalog makes the next _catalog() cold-load.
 */
export function reloadModels() {
  _loadedCatalog = null;
  _loadedMtimeMs = 0;
  _lastStatMs = 0;
  return _loadModels();
}

const cache = new Map();

/**
 * Read a secret from macOS Keychain (service: robotdojo-{name}).
 * Falls back to legacy miyagi-{name} entries for back-compat on existing
 * installs, then env var. Never logs the value.
 */
export function secret(name) {
  if (cache.has(name)) return cache.get(name);
  // Env override first (for CI, containers)
  const envKey = name.replace(/-/g, '_').toUpperCase();
  if (process.env[envKey]) {
    cache.set(name, process.env[envKey]);
    return process.env[envKey];
  }
  try {
    const val = readKeychainSecret(name);
    if (val) {
      cache.set(name, val);
      return val;
    }
  } catch {
    return null;
  }
  return null;
}

export function overrideSecret(name, value) {
  const normalized = String(name || '').replace(/-/g, '_').toUpperCase();
  if (!normalized) return;
  if (value == null || value === '') {
    cache.delete(normalized);
    delete process.env[normalized];
    return;
  }
  process.env[normalized] = String(value);
  cache.set(normalized, String(value));
}

const config = {
  configDir: CONFIG_DIR,

  // Two ports: public marketing site + authenticated app
  ports: {
    site: parseInt(process.env.PORT_SITE || '4336', 10),
    app:  parseInt(process.env.PORT_APP  || '4338', 10),
  },
  port: parseInt(process.env.PORT || '4338', 10), // legacy single-port fallback
  env: process.env.NODE_ENV || 'production',
  get isDev() { return this.env === 'development'; },

  // API keys (lazy from keychain)
  get anthropicKey() { return secret('ANTHROPIC_API_KEY'); },
  get googleAiKey() { return secret('GOOGLE_AI_API_KEY') || secret('GOOGLE_API_KEY'); },
  get openaiKey()  { return secret('OPENAI_API_KEY'); },
  get speechifyApiKey() { return secret('SPEECHIFY_API_KEY'); },
  get xaiKey()     { return secret('XAI_API_KEY') || secret('GROK_API_KEY'); },
  get grokKey()    { return this.xaiKey; },
  // ollamaHost is not a secret — falls back to env or localhost
  get ollamaHost() { return secret('OLLAMA_HOST') || process.env.OLLAMA_HOST || 'http://localhost:11434'; },

  // Auth
  get authToken() { return secret('ROBOTDOJO_AUTH_TOKEN') || secret('MIYAGI_AUTH_TOKEN'); },
  get sessionSecret() { return secret('SESSION_SECRET'); },
  // resendApiKey removed in st_5a63545d — magic-code email flow retired in
  // favor of token-paste login (POST /api/auth/token). The Keychain entry
  // (if present from a prior install) is no longer consulted by any code path.
  get appBaseUrl() { return process.env.APP_BASE_URL || secret('APP_BASE_URL') || 'https://robotdojo.ai'; },

  // Billing — USDC rail
  get usdcWallet() { return secret('USDC_RECEIVING_WALLET'); },
  get alchemyApiKey() { return secret('ALCHEMY_API_KEY') || secret('ALCHEMY_BASE_API_KEY'); },

  // Billing — Stripe rail (see docs/integrations/stripe.md)
  get stripeSecretKey()       { return secret('STRIPE_SECRET_KEY'); },
  get stripeWebhookSecret()   { return secret('STRIPE_WEBHOOK_SECRET'); },
  get stripePriceId()         { return secret('STRIPE_PRICE_ID'); },        // price_... for Black Belt (see PRICING.black.display)
  get stripePublishableKey()  { return secret('STRIPE_PUBLISHABLE_KEY') || process.env.STRIPE_PUBLISHABLE_KEY; },

  // Lulu Print API (book engine — st_64d7e5ff). Keychain, not process.env in
  // lib, so no install.sh env check-block is required. Base defaults to the
  // SANDBOX; lib/lulu-client.js refuses a non-sandbox base unless explicitly
  // allowed, so this story never touches production.
  get luluClientKey()    { return secret('LULU_CLIENT_KEY'); },
  get luluClientSecret() { return secret('LULU_CLIENT_SECRET'); },
  get luluApiBase()      { return process.env.LULU_API_BASE || secret('LULU_API_BASE') || 'https://api.sandbox.lulu.com'; },

  // Tunnel gateway (for push-key / revoke-key calls + tunnel-agent WS).
  //
  // Why `relay.robotdojo.ai` (not `gateway.*`): `gateway.robotdojo.ai` got
  // CA-blacklisted after repeated failed ACM validation attempts during the
  // 2026-04-19 infra bring-up. The tunnel host was renamed to `relay.` to
  // avoid the blacklist.  Code defaults follow.
  get gatewayUrl()            { return process.env.GATEWAY_URL || secret('GATEWAY_URL') || 'https://relay.robotdojo.ai'; },
  // Shared secret for /internal/* REST calls from the main app to the relay.
  get gatewayInternalSecret() { return secret('GATEWAY_INTERNAL_SECRET'); },
  // Bootstrap proof for public relay device registration/cert provisioning.
  // Private beta install links can provide this via env or Keychain; without
  // it, local install still works and remote access remains unconfigured.
  get relayBootstrapSecret()  { return secret('ROBOTDOJO_RELAY_BOOTSTRAP_SECRET') || secret('GATEWAY_BOOTSTRAP_SECRET'); },
  // HMAC secret the main app uses to MINT tunnel JWTs for its own agent.
  // The gateway holds the same secret and verifies incoming tokens.
  get tunnelJwtSecret()       { return secret('TUNNEL_JWT_SECRET'); },
  get modulesUrl()            { return process.env.MODULES_URL  || secret('MODULES_URL') || null; },

  // SNI passthrough tunnel — device identity for the new TLS-on-Mac arch.
  // deviceSlug:   the slug for this device (e.g. "laptop"); used as the
  //               subdomain for {slug}.robotdojo.ai TLS cert provisioning.
  // deviceSecret: secret shared with the relay to authenticate this device.
  // tlsCertDir:   directory where device.crt / device.key are stored.
  get deviceSlug()   { return process.env.ROBOTDOJO_DEVICE_SLUG   || secret('ROBOTDOJO_DEVICE_SLUG')   || null; },
  get deviceSecret() { return process.env.ROBOTDOJO_DEVICE_SECRET || secret('ROBOTDOJO_DEVICE_SECRET') || null; },
  // ownerEmail: plaintext owner email, held in Keychain (users.email is an HMAC
  // hash on disk by design, no plaintext PII). st_63b59bda AC-5: LOCAL-ONLY —
  // used to exclude the owner from entity extraction (followup-sweep, scoring).
  // It is never sent to the relay, which authenticates the device by its secret.
  get ownerEmail()   { return process.env.ROBOTDOJO_OWNER_EMAIL   || secret('ROBOTDOJO_OWNER_EMAIL')   || null; },
  // Lulu Print API (sandbox) — client-credentials from Keychain (st_64d7e5ff).
  get luluClientKey()    { return secret('LULU_CLIENT_KEY'); },
  get luluClientSecret() { return secret('LULU_CLIENT_SECRET'); },
  get luluApiBase()      { return process.env.LULU_API_BASE || secret('LULU_API_BASE') || 'https://api.sandbox.lulu.com'; },
  tlsCertDir: resolvePath(CONFIG_DIR, 'tls'),

  // Remote tunnel URL advertised to browser clients. When a user loads
  // robotdojo.ai (or any non-local hostname), the browser routes /api and
  // /auth calls through this URL. Empty default means "same origin" —
  // correct for most installs. Operators with a custom Tailscale/tunnel
  // hostname set ROBOTDOJO_TUNNEL_URL to override.
  tunnel: {
    get url() { return process.env.ROBOTDOJO_TUNNEL_URL || secret('ROBOTDOJO_TUNNEL_URL') || ''; },
  },

  // GCS backup bucket — set GCS_BUCKET env var, Keychain entry, or local private config.
  get gcsBucket() { return process.env.GCS_BUCKET || secret('GCS_BUCKET') || privateSetting('infrastructure.gcs_bucket') || privateSetting('gcs_bucket') || ''; },

  // Bundle master keys. Each key matches the ROBOTDOJO_BUILD_KEY used to
  // encrypt the Black Belt bundle.
  // Belt-specific key takes precedence; falls back to the generic key (backward compat).
  bundleMasterKeyForBelt(belt) {
    const upper = String(belt || 'black').toUpperCase();
    return process.env[`ROBOTDOJO_BUNDLE_MASTER_KEY_${upper}`]
      || secret?.(`ROBOTDOJO_BUNDLE_MASTER_KEY_${upper}`)
      || process.env.ROBOTDOJO_BUNDLE_MASTER_KEY
      || secret?.('ROBOTDOJO_BUNDLE_MASTER_KEY')
      || null;
  },
  // Convenience getter for the Black Belt key (most common call site).
  get bundleMasterKey() { return this.bundleMasterKeyForBelt('black'); },

  // Black Belt pricing (cents). USDC amounts derived from this.
  // Source of truth is lib/pricing.js. Env override exists for CI only.
  get blackBeltPriceCents() {
    const override = process.env.BLACK_BELT_PRICE_CENTS;
    return override ? parseInt(override, 10) : PRICING.black.cents;
  },

  // Models (dynamic — read from config/models.json, fall back to defaults)
  //
  // chat default = balanced (Sonnet-class). Basic web chat is a memory-backed
  // conversation, not trivia: identity + topic context + RAG need a mid-tier
  // model. Fast stays for mechanical/public lanes. Owner override remains
  // user_settings.chat_model; routes/chat.js reads that before this default.
  //
  // st_4312c9c0 AC-2/AC-3 — compile drops to the cheapest lane. The prior
  // comment justified Sonnet by citing topic context_md regen, but the compile
  // lane has exactly two consumers (lib/timeline-compile.js and
  // routes/compiled.js) and topic context is not among them — it holds its own
  // Sonnet call directly. Both consumers render a view read once; nothing on
  // the prompt-assembly path reads the output back, so it is mechanical.
  //
  // AC-3 durability: this asks the lane for 'fast' rather than naming a model
  // string, and scripts/update-models.js rewrites only which model each lane
  // resolves to — never which lane a caller requests. The daily refresh cannot
  // walk this back.
  models: {
    get chat()    { return getModel(activeSpendProvider(), 'balanced'); },
    get compile() { return getModel(activeSpendProvider(), 'fast'); },
    get extract() { return getModel('google',    'fast');     },
    get embed()   { return 'Snowflake/snowflake-arctic-embed-l-v2.0'; },
  },

  // st_4312c9c0 AC-7 — route delay-tolerant bulk enrichment through the
  // Message Batches API, which bills at half the synchronous rate. OFF by
  // default: batch turnaround is asynchronous (minutes to hours), so it is
  // only ever correct where nothing is waiting on the result. Entity
  // enrichment is that shape; nothing user-facing is.
  get batchEnrichment() { return process.env.ROBOTDOJO_BATCH_ENRICHMENT === '1'; },

  // Timeouts (ms)
  timeouts: {
    api: 30000,
    stream: 120000,
    embed: 10000,
    db: { busyTimeout: 30000 },
  },

  // Cost caps
  costs: {
    maxExtractSpend: 2.00,  // $2 cap for Flash extraction
    maxCompileSpend: 5.00,  // $5 cap for Sonnet synthesis
    maxEmbedSpend: 0.00,    // hard $0: embeddings are local-only
  },

  // Service URLs — env-overridable so tests and operators can redirect without
  // patching source files. Keep defaults in sync with install.sh docs.
  fromAddress: process.env.FROM_ADDRESS || 'Miyagi <miyagi@robotdojo.ai>',

  // Rate limits — env-overridable for CI and load testing.
  chatRateLimit: parseInt(process.env.CHAT_RATE_LIMIT || '100', 10),
  chatRateWindowMs: parseInt(process.env.CHAT_RATE_WINDOW_MS || String(15 * 60 * 1000), 10),
  hourlyLinkLimit: parseInt(process.env.HOURLY_LINK_LIMIT || '3', 10),
  dailyPublicChatLimit: parseInt(process.env.DAILY_PUBLIC_CHAT_LIMIT || '50', 10),
};

export default config;
