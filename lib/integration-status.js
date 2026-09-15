/**
 * lib/integration-status.js — the single Node-side source of truth for
 * integration status classification and the live-verification write.
 *
 * INTELLIGENCE_TIER: extraction — deterministic, no LLM. Reads structured
 * health rows and writes a single structured timestamp; no model call ever
 * touches connectivity state (connectivity honors the LLM write-boundary).
 * COMPUTE TIER: Tier 0 — pure local logic + one indexed UPDATE.
 *
 * WHY this module exists: an integration is "Healthy" only when a live
 * connection was VERIFIED working inside a per-class freshness window — never
 * because a key or token merely exists. `verified_at` is the honest signal:
 * it advances only on a real live verification (a successful handshake, a
 * successful OAuth refresh, or a successful real API call), written here and
 * nowhere else.
 *
 * The frontend renderer (`apps/account/app.js` `_integrationBucket`) mirrors
 * `wouldRenderHealthy` / `staleWindowForName` exactly — it cannot import this
 * module (raw browser script, no bundler), so the two copies MUST stay in
 * lockstep. `scripts/check-integration-truth.js` imports THIS module so the
 * guard and the backend never diverge; the guard's static scan asserts the
 * frontend routes both renderers through the shared `_integrationBucket`.
 */

export const INTELLIGENCE_TIER = 'extraction';

const MIN = 60 * 1000;

function envMs(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Per-class staleness SLA (owner-pinned, item 6). Generous enough that an
// idle-but-working connection never false-alarms, because real usage AND the
// 15-minute cadence handshake both refresh `verified_at` well inside these
// windows. Env-overridable so a deployment can tune without a code change.
export const INTEGRATION_STALE_WINDOW_MS = Object.freeze({
  model_key: envMs('ROBOTDOJO_STALE_WINDOW_MODEL_KEY_MS', 60 * MIN),   // anthropic, openai, google(-ai), xai
  oauth:     envMs('ROBOTDOJO_STALE_WINDOW_OAUTH_MS', 180 * MIN),      // gmail, calendar, drive, outlook, microsoft
  other_key: envMs('ROBOTDOJO_STALE_WINDOW_OTHER_KEY_MS', 120 * MIN),  // notion, oura, asana, slab, hunter, …
  local:     envMs('ROBOTDOJO_STALE_WINDOW_LOCAL_MS', 120 * MIN),      // imessage, apple-health (2× cadence; fallback 120m)
  default:   envMs('ROBOTDOJO_STALE_WINDOW_DEFAULT_MS', 120 * MIN),
});

// Bare model-provider health names are API keys (the Google AI card reads the
// bare 'google' row; OAuth Google accounts use 'gmail:…'/'calendar:…' names,
// never bare 'google', so there is no window collision).
const MODEL_KEY_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'google-ai', 'xai']);
const OAUTH_PREFIXES = new Set(['gmail', 'calendar', 'drive', 'contacts', 'photos', 'microsoft', 'microsoft-mail', 'microsoft-calendar', 'outlook']);
const OTHER_KEY_PROVIDERS = new Set(['notion', 'oura', 'asana', 'asana_secondary', 'slab', 'hunter', 'brave', 'github', 'elevenlabs']);
const LOCAL_PREFIXES = new Set(['imessage', 'apple', 'apple-photos', 'apple-health', 'local']);

/**
 * Select the staleness window for an integration health name. Per-account
 * OAuth/local rows carry a `prefix:scope` name and classify by prefix; bare
 * names classify by provider.
 * @param {string} name integration_health.name
 * @returns {number} window in ms
 */
export function staleWindowForName(name) {
  const raw = String(name || '').toLowerCase();
  const base = raw.split(':')[0];
  if (raw.includes(':')) {
    if (OAUTH_PREFIXES.has(base)) return INTEGRATION_STALE_WINDOW_MS.oauth;
    if (LOCAL_PREFIXES.has(base)) return INTEGRATION_STALE_WINDOW_MS.local;
  }
  if (MODEL_KEY_PROVIDERS.has(base)) return INTEGRATION_STALE_WINDOW_MS.model_key;
  if (OAUTH_PREFIXES.has(base)) return INTEGRATION_STALE_WINDOW_MS.oauth;
  if (OTHER_KEY_PROVIDERS.has(base)) return INTEGRATION_STALE_WINDOW_MS.other_key;
  if (LOCAL_PREFIXES.has(base)) return INTEGRATION_STALE_WINDOW_MS.local;
  return INTEGRATION_STALE_WINDOW_MS.default;
}

// A failed status renders Issue the MOMENT it is written — no grace window. A
// real break is never a false alarm.
const FAILED_STATUSES = new Set([
  'failed', 'error', 'invalid_key', 'quota_exceeded', 'provider_error',
  'needs_reauth', 'needs_permission', 'permission_denied',
]);

/** Normalize a raw status string to a lowercase key. */
export function normStatus(status) {
  return String(status || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** True when the status is a hard failure that must render Issue immediately. */
export function isFailedStatus(status) {
  return FAILED_STATUSES.has(normStatus(status));
}

const SUCCESS_STATUS_RE = /^(ok|done|connected|active|partial|healthy)$/;

// Internal platform / infrastructure rows that render as diagnostics, NOT as
// user integration cards. They legitimately carry no live-verification signal
// (a backup heartbeat, the reconciler's own status, an imports snapshot, the
// end-to-end probe, the `microsoft` OAuth group parent, the tunnel heartbeat,
// keychain discovery), so they are exempt from BOTH the earned-green and the
// no-false-red guards. Everything not in this set is a user-facing integration
// whose success status MUST be backed by a live verification. (st_bf4978b0.)
export const INTERNAL_HEALTH_NAMES = new Set([
  'backup', 'reconciler', 'imports-snapshot', 'granola_e2e_probe',
  'microsoft', 'remote-access', 'keychain-discovery',
]);

/** True when a health row is internal infra, not a user-facing integration card. */
export function isInternalHealthName(name) {
  return INTERNAL_HEALTH_NAMES.has(String(name || '').toLowerCase());
}

/**
 * The Healthy predicate — the single rule both the guard and the backend obey.
 * Healthy iff: success status AND non-null verified_at AND now − verified_at is
 * inside the per-class window. A failed status is never Healthy (checked first,
 * no grace); a never-verified row (verified_at NULL) is never Healthy.
 * @param {{name:string,status:string,verified_at?:string|null}} row
 * @param {{now?:number}} [opts]
 * @returns {boolean}
 */
export function wouldRenderHealthy(row = {}, { now = Date.now() } = {}) {
  const status = normStatus(row.status);
  if (isFailedStatus(status)) return false;
  if (!SUCCESS_STATUS_RE.test(status)) return false;
  if (!row.verified_at) return false;
  const v = Date.parse(row.verified_at);
  if (!Number.isFinite(v)) return false;
  return (now - v) < staleWindowForName(row.name);
}

/**
 * The mirror of unearned-green: a FALSE-RED. A user-facing integration whose
 * probe reports it working (a success status) yet renders Issue SOLELY because
 * `verified_at` is NULL — it never recorded a live verification even though
 * nothing is actually wrong. This is the exact hole that let a wall of
 * false-Issue pass every machine check: the earned-green guard only asserts
 * "nothing green is unverified", so a working integration that simply forgot to
 * stamp its verification rendered a permanent, undetected false Issue.
 *
 * Staleness (verified_at present but older than the window) is NOT a false-red —
 * that is the intended degradation. A genuine failure status is NOT a false-red
 * either — that Issue is honest. Only success-status + NULL verified_at on a
 * user-facing row qualifies.
 * @param {{name:string,status:string,verified_at?:string|null}} row
 * @returns {boolean}
 */
export function isFalseRed(row = {}) {
  if (!row || isInternalHealthName(row.name)) return false;
  const status = normStatus(row.status);
  if (isFailedStatus(status)) return false;          // a real failure is an honest Issue
  if (!SUCCESS_STATUS_RE.test(status)) return false; // running/queued/etc. — not a working claim
  return !row.verified_at;                           // working claim + no live verification = false-red
}

// ── Card-level truth (st_bf4978b0 QA round 3) ───────────────────────────────
// The row-level predicates above (wouldRenderHealthy / isFalseRed) judge one
// integration_health ROW. But the Accounts page renders CARDS assembled in
// routes/accounts.js, and a card can lie in a way no DB row shows:
//   • an aggregate/group parent card (Google, Microsoft, Asana) whose own
//     `verified_at` is NULL even though its child accounts are verified & healthy
//     — the parent renders a FALSE Issue because it never inherited the child's
//     verification;
//   • a first-party Robot Dojo surface (the Chat card) that renders Issue for
//     lack of an external probe — but a first-party surface is healthy BY
//     DEFINITION whenever the server is serving (the payload being assembled at
//     all proves liveness).
// These mirror the frontend `_integrationBucket` (apps/account/app.js) at the
// CARD level so the guard's `card-truth` check catches a false-red born in card
// assembly that the DB-row guard is structurally blind to.

// A first-party Robot Dojo surface (the Chat card): its liveness IS the running
// server. Never depends on an external probe.
export function isFirstPartyCard(card = {}) {
  const sub = String(card.substrate_type || card.auth || '').toLowerCase();
  const provider = String(card.provider || '').toLowerCase();
  return sub === 'first-party' || sub === 'first_party' || provider.startsWith('robotdojo');
}

// A one-time import (Imported bucket) — nothing live to verify, never an Issue.
// Mirrors the frontend `oneTimeImport` branch of `_integrationBucket`.
export function isImportedCard(card = {}) {
  const status = cardStatusKey(card);
  return !!card.one_time_import
    || String(card.health_color || '').toLowerCase() === 'grey'
    || card.provider === 'imports'
    || card.provider === 'apple-health'
    || card.provider === 'health-labs'
    || status === 'one_time_import';
}

// The card's effective status key — mirrors the status derivation at the top of
// the frontend `_integrationBucket`.
function cardStatusKey(card = {}) {
  const raw = card.health_state || card.state || card.connection_status
    || card.launch_state || card.status
    || (card.connected ? 'connected' : 'ready');
  return normStatus(raw);
}

// Card-level staleness window — mirrors the frontend `_integStaleWindowMs`,
// which is substrate-aware (an OAuth group parent named 'google' must NOT get
// the 60-min model-key window that `staleWindowForName('google')` would return;
// its substrate_type 'oauth' pins the 180-min window). This is why card truth
// cannot reuse `staleWindowForName` alone.
export function staleWindowForCard(card = {}) {
  const name = String(card.provider || card.name || '').toLowerCase();
  const base = name.split(':')[0];
  const substrate = String(card.substrate_type || card.auth || '').toLowerCase();
  if (name.includes(':')) {
    if (OAUTH_PREFIXES.has(base)) return INTEGRATION_STALE_WINDOW_MS.oauth;
    if (LOCAL_PREFIXES.has(base)) return INTEGRATION_STALE_WINDOW_MS.local;
  }
  if (substrate === 'oauth') return INTEGRATION_STALE_WINDOW_MS.oauth;
  if (substrate === 'local' || LOCAL_PREFIXES.has(base)) return INTEGRATION_STALE_WINDOW_MS.local;
  if (MODEL_KEY_PROVIDERS.has(base)) return INTEGRATION_STALE_WINDOW_MS.model_key;
  if (OAUTH_PREFIXES.has(base)) return INTEGRATION_STALE_WINDOW_MS.oauth;
  if (OTHER_KEY_PROVIDERS.has(base)) return INTEGRATION_STALE_WINDOW_MS.other_key;
  return INTEGRATION_STALE_WINDOW_MS.default;
}

// A child sub-row of an aggregate card (a Google/Microsoft account, an Asana
// workspace) is HEALTHY iff: non-failed status, a real verified_at, and that
// verification is fresh within the child's window. This is the ONLY thing an
// aggregate parent may inherit Healthy from — never a fabricated timestamp.
function childHealthy(child, parentCard, now) {
  if (!child || !child.verified_at) return false;
  const status = normStatus(child.account_status || child.sync_state || child.status
    || (child.connected ? 'connected' : ''));
  if (isFailedStatus(status)) return false;
  if (!SUCCESS_STATUS_RE.test(status) && !child.connected) return false;
  const v = Date.parse(child.verified_at);
  if (!Number.isFinite(v)) return false;
  const win = staleWindowForCard({
    provider: child.provider || parentCard?.provider,
    substrate_type: child.substrate_type || parentCard?.substrate_type,
  });
  return (now - v) < win;
}

/**
 * The freshest `verified_at` among an aggregate card's HEALTHY children, or null
 * when no child is genuinely verified. This is how an aggregate/group parent
 * card earns Healthy: it inherits the newest live verification from a child that
 * actually has one. Returns null (honest not-Healthy) when every child is
 * failing, unconfigured, stale, or never-verified — so it can NEVER manufacture
 * a false-green.
 * @param {{accounts?:Array, provider?:string, substrate_type?:string}} parentCard
 * @param {{now?:number}} [opts]
 * @returns {string|null} ISO timestamp or null
 */
export function freshestHealthyChildVerifiedAt(parentCard = {}, { now = Date.now() } = {}) {
  const children = Array.isArray(parentCard.accounts) ? parentCard.accounts : [];
  let best = null;
  let bestMs = -Infinity;
  for (const child of children) {
    if (!childHealthy(child, parentCard, now)) continue;
    const ms = Date.parse(child.verified_at);
    if (ms > bestMs) { bestMs = ms; best = child.verified_at; }
  }
  return best;
}

const UNCONFIGURED_STATUS_RE = /^(needs_key|no_key|needs_oauth|needs_sign_in|not_configured|disconnected|missing)$/;

// The generic card bucket — what the frontend `_integrationBucket` paints for
// non-first-party cards. First-party Chat is Healthy in the browser whenever
// the page is served; `cardBucket` is the intended bucket including that rule.
function genericCardBucket(card = {}, { now = Date.now() } = {}) {
  if (isImportedCard(card)) return 'imported';
  const status = cardStatusKey(card);
  if (isFailedStatus(status)) return 'issue';
  if (UNCONFIGURED_STATUS_RE.test(status)) return 'issue';
  const successStatus = SUCCESS_STATUS_RE.test(status) || !!card.connected;
  const v = card.verified_at ? Date.parse(card.verified_at) : NaN;
  const fresh = Number.isFinite(v) && (now - v) < staleWindowForCard(card);
  return (successStatus && fresh) ? 'healthy' : 'issue';
}

/**
 * The three-bucket classifier for a whole assembled CARD — the frontend
 * `_integrationBucket` result PLUS the two card-only rules the row classifier
 * cannot express:
 *   • first-party → Healthy whenever the server is serving (serverLive);
 *   • window is substrate-aware via `staleWindowForCard`.
 * This is the INTENDED bucket (what the card should render once assembly is
 * honest); `genericCardBucket` is what the browser paints today.
 * @param {object} card assembled integration card
 * @param {{now?:number, serverLive?:boolean}} [opts]
 * @returns {'healthy'|'imported'|'issue'}
 */
export function cardBucket(card = {}, { now = Date.now(), serverLive = true } = {}) {
  if (isFirstPartyCard(card)) return serverLive ? 'healthy' : 'issue';
  return genericCardBucket(card, { now });
}

/**
 * A FALSE-RED card: one the FRONTEND paints Issue that is genuinely WORKING and
 * should be Healthy — the exact lie born in card assembly that `isFalseRed`
 * (row-level) cannot see. Three working shapes:
 *   • first-party: must be Healthy whenever served; painted Issue ⇒ false-red;
 *   • aggregate: EVERY child is healthy yet the parent is painted Issue (it
 *     never inherited the child verification). If any child genuinely fails or
 *     is unconfigured, the parent Issue is honest and NOT flagged.
 *   • leaf: a success/connected card painted Issue with NO verified_at at all
 *     (staleness — verified_at present but old — is honest degradation, never a
 *     false-red).
 * @param {object} card
 * @param {{now?:number, serverLive?:boolean}} [opts]
 * @returns {boolean}
 */
export function isCardFalseRed(card = {}, { now = Date.now(), serverLive = true } = {}) {
  if (isImportedCard(card)) return false;                     // Imported, never an Issue
  if (genericCardBucket(card, { now }) !== 'issue') return false; // the frontend does not paint it red
  // First-party: SHOULD be Healthy whenever served — so a painted Issue is false.
  if (isFirstPartyCard(card)) return serverLive;
  const status = cardStatusKey(card);
  if (isFailedStatus(status)) return false;                   // honest failure
  if (UNCONFIGURED_STATUS_RE.test(status)) return false;      // honestly unconfigured
  const children = Array.isArray(card.accounts) ? card.accounts : [];
  if (children.length) {
    // Aggregate: a false-red only when EVERY child is healthy yet the parent is
    // Issue. Any failing/unconfigured child makes the parent Issue honest.
    return children.every((ch) => childHealthy(ch, card, now));
  }
  // Leaf working card painted Issue: false-red iff it never verified at all
  // (a present-but-stale verified_at is the intended degradation).
  const successStatus = SUCCESS_STATUS_RE.test(status) || !!card.connected;
  if (!successStatus) return false;
  return !card.verified_at;
}

/**
 * recordLiveVerification — deterministic (no LLM) write of a live-verification
 * event. Called only on a genuine success: a `/v1/models` handshake HTTP 200,
 * a successful OAuth refresh, or a real successful API call. Sets status='ok'
 * (the connection just worked), clears the error, zeroes the failure counter,
 * and advances `verified_at`. Preserves `last_sync` (content-arrival time) and
 * `last_check` (probe-run time) by omission — those are distinct signals.
 * @param {import('better-sqlite3').Database} db
 * @param {string} name integration_health.name the card reads (see the
 *   google vs google-ai name seam — write the SAME name the card reads)
 * @returns {string|null} the ISO verification timestamp, or null on no-op
 */
export function recordLiveVerification(db, name) {
  if (!db || !name) return null;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO integration_health
      (name, status, last_check, last_sync, consecutive_failures, last_error, verified_at, updated_at)
    VALUES (?, 'ok', datetime('now'), NULL, 0, NULL, ?, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      status               = 'ok',
      consecutive_failures = 0,
      last_error           = NULL,
      verified_at          = excluded.verified_at,
      updated_at           = excluded.updated_at
  `).run(name, now);
  return now;
}
