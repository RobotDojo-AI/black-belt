/**
 * integration-reconciler.js — boot-time + cadence registration repair
 * (st_fd14cdd4 AC1/AC3).
 *
 * Replaces the consumed-once seed-migration pattern: registration is an
 * idempotent derivation from lib/integration-registry.js, re-run at every
 * server boot and on the integration-monitor 15-minute cadence, instead of
 * one-shot history that silently no-ops on DBs that already ran it
 * (research §5b — "adding rows to a consumed migration does nothing").
 *
 * What one pass does, per registry descriptor:
 *
 *   api_key (slug rows)   INSERT OR IGNORE the deterministic `vendor:type`
 *                         accounts row. When the credential is present and the
 *                         row was just repaired, queue the provider's
 *                         background jobs so the integration starts syncing
 *                         without a manual step (AC1).
 *
 *   microsoft             Tenant credentials are tenant-level; mailbox UPNs
 *   (app_credentials)     are NOT derivable from them (plan Key decision 3).
 *                         (a) Emails found in the legacy Keychain registry but
 *                             missing typed rows → upsert typed rows +
 *                             queueOAuthSync + health (the silent-dark repair).
 *                         (b) Tenant secrets present but zero typed rows AND
 *                             zero registry entries → write a visible
 *                             integration_health error named 'microsoft' —
 *                             never silence. The connect route remains the
 *                             single supported action that names the mailbox.
 *                         (c) Typed rows present → clear a previously-written
 *                             no-mailbox error so the page stops alarming.
 *
 *   oauth / local / none  No repair possible or needed: Google rows are
 *                         written by the OAuth callback (tokens are per-email,
 *                         row exists iff callback ran); local readers carry no
 *                         accounts rows; imports rows register at data arrival.
 *
 * df_355651ca — the keychain is the truth driver (store-is-the-registry).
 * Three additional level-triggered passes converge the registries to it:
 *
 *   catalog derivation    Every api_key-kind descriptor gets a
 *                         keychain_integrations page-catalog row when missing,
 *                         so session-only vendors render as page cards.
 *
 *   keychain discovery    Attributes-only enumeration of robotdojo-* services;
 *                         classifyKeychainService (ordered rules, census-
 *                         derived) decides integration vs plumbing; every
 *                         integration service gets an accounts row + catalog
 *                         row when missing — a token added straight to the
 *                         keychain surfaces on both surfaces with no
 *                         registration step.
 *
 *   presence verification Every api_key accounts row whose keychain_key is
 *                         absent from the enumeration flips to
 *                         'needs_credential' (dropped from /api/accounts,
 *                         flagged on the page); present-and-flagged rows flip
 *                         back to 'active'. OAuth rows are never touched.
 *                         Failsafe: zero services enumerated while api_key
 *                         rows exist = enumeration failure — both keychain
 *                         passes skip and a visible 'keychain-discovery'
 *                         health error is written (a broken dump-keychain
 *                         parse must not mass-flag every token).
 *
 * Failures land in integration_health (visible on the integrations page);
 * the pass itself never throws — a reconciler crash must not take down boot.
 */
import db from './db.js';
import { secret as configSecret } from './config.js';
import {
  INTEGRATIONS,
  KEYCHAIN_OAUTH_PREFIX,
  KEYCHAIN_INTERNAL_PREFIXES,
  KEYCHAIN_EXCLUDED_SUFFIXES,
  KEYCHAIN_EXCLUDED_SERVICES,
  RESERVED_ACCOUNT_VENDORS,
  CREDENTIAL_SUFFIXES,
} from './integration-registry.js';
import { listKeychainServices } from './keychain.js';
import { upsertDiscoveredIntegration, setAccountCredentialStatus, pruneKeychainIntegrationsToAllowlist } from './accounts-queries.js';
import { PAGE_CATALOG_ALLOWLIST } from './launch-integrations.js';
import { queueIntegrationJobs, queueOAuthSync, recordIntegrationJobHealth } from './oauth-sync-queue.js';
import { upsertMicrosoftAccounts } from './oauth-queries.js';
import { listConnectedMicrosoftAccounts } from './microsoft-oauth.js';

// The visible no-mailbox message (plan Key decision 3). Matched on clear so a
// later pass with typed rows only clears OUR error, not a sync failure.
export const MICROSOFT_NO_MAILBOX_ERROR =
  'credentials present, no mailbox registered — add the mailbox in Accounts';

function listTypedMicrosoftEmails(database) {
  try {
    return database.prepare(`
      SELECT DISTINCT email FROM accounts
       WHERE vendor='microsoft' AND status IN ('active', 'connected') AND type IN ('email','calendar')
         AND email IS NOT NULL AND email != ''
    `).all().map((r) => String(r.email).trim().toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

function reconcileApiKeyRows(database, secret, summary) {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO accounts
      (id, provider, vendor, type, display_name, keychain_key, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', '{}', datetime('now'), datetime('now'))
  `);

  for (const d of INTEGRATIONS) {
    if (d.credentials.kind !== 'api_key') continue;
    const type = d.accountShape.types[0];
    if (!type || d.accountShape.idScheme !== 'slug') continue;
    const id = `${d.vendor}:${type}`;
    const keychainKey = d.credentials.keychainKeys[0] ? `robotdojo-${d.credentials.keychainKeys[0]}` : null;
    const result = insert.run(id, d.provider, d.vendor, type, d.displayName, keychainKey);
    if (result.changes > 0) {
      summary.createdAccounts.push(id);
      // Row was missing (new integration, or someone deleted it). If the
      // credential already exists, the user expects syncing to resume on its
      // own — queue the provider jobs exactly like a fresh key save would.
      const hasCredential = d.credentials.keychainKeys.some((key) => !!secret(key));
      if (hasCredential && d.connectJobs?.length) {
        for (const job of d.jobs || []) {
          if (!job.connectProvider) continue;
          queueIntegrationJobs(database, job.connectProvider);
          summary.queuedProviders.push(job.connectProvider);
        }
      }
    }
  }
}

// ── Keychain classification (df_355651ca AC3) ───────────────────────────────

const KEYCHAIN_SERVICE_PREFIX = 'robotdojo-';

function bareServiceName(service) {
  const s = String(service || '');
  return s.startsWith(KEYCHAIN_SERVICE_PREFIX) ? s.slice(KEYCHAIN_SERVICE_PREFIX.length) : s;
}

/**
 * Classify an enumerated keychain service as 'integration' (surfaces on the
 * accounts page and in every agent session) or 'excluded' (plumbing).
 *
 * Rules apply IN ORDER — the order is the contract (sealed plan, census-
 * derived; the frozen census is a pinned fixture in
 * tests/integration-reconciler.test.js):
 *   1. claimed by an api_key-kind registry descriptor → integration
 *      (registry claim is the escape hatch: a future vendor whose only
 *      credential matches an exclusion pattern joins via one descriptor)
 *   2. robotdojo-oauth-* prefix → excluded (OAuth token material)
 *   3. claimed by a non-api_key registry descriptor → excluded (represented
 *      by that integration's own surface — Microsoft tenant trio, Granola)
 *   4. internal ROBOTDOJO_ prefix → excluded (the product's own auth material)
 *   5. structural exclusion suffix → excluded (identifier/companion halves)
 *   6. explicit remainder list → excluded (incl. MIYAGI_TOKEN, defensive)
 *   7. everything else → integration
 *
 * @param {string} service full keychain service name (robotdojo-*)
 * @returns {'integration'|'excluded'}
 */
export function classifyKeychainService(service) {
  const raw = String(service || '');
  const bare = bareServiceName(raw);
  for (const d of INTEGRATIONS) {
    if (d.credentials.kind === 'api_key' && d.credentials.keychainKeys.includes(bare)) return 'integration';
  }
  if (raw.startsWith(KEYCHAIN_OAUTH_PREFIX)) return 'excluded';
  for (const d of INTEGRATIONS) {
    if (d.credentials.kind !== 'api_key' && d.credentials.keychainKeys.includes(bare)) return 'excluded';
  }
  if (KEYCHAIN_INTERNAL_PREFIXES.some((prefix) => bare.startsWith(prefix))) return 'excluded';
  if (KEYCHAIN_EXCLUDED_SUFFIXES.some((suffix) => bare.endsWith(suffix))) return 'excluded';
  if (KEYCHAIN_EXCLUDED_SERVICES.includes(bare)) return 'excluded';
  return 'integration';
}

function slugFromService(bare, { stripSuffix = true } = {}) {
  let slug = String(bare).toLowerCase();
  if (stripSuffix) {
    // Longest-match-first so `_api_key` wins over `_key` (ALCHEMY_API_KEY →
    // alchemy, never alchemy_api).
    const suffixes = [...CREDENTIAL_SUFFIXES].sort((a, b) => b.length - a.length);
    for (const suffix of suffixes) {
      if (slug.length > suffix.length && slug.endsWith(suffix)) {
        slug = slug.slice(0, -suffix.length);
        break;
      }
    }
  }
  return slug;
}

function titleCaseSlug(slug) {
  return String(slug)
    .split('_')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

function catalogRowForKeychainKey(database, keychainKey) {
  try {
    return database.prepare(
      'SELECT provider, display_name FROM keychain_integrations WHERE keychain_key=?'
    ).get(keychainKey) || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the accounts vendor for a discovered service. Candidates in order:
 * the page-catalog provider claiming this keychain_key, the suffix-stripped
 * slug, the full lowercased name. The reserved set is RESERVED_ACCOUNT_VENDORS
 * plus every non-api_key registry vendor — a discovered api_key row may never
 * land on a vendor whose queries assume another provider shape (e.g.
 * GOOGLE_AI_API_KEY, catalog-claimed by 'google', lands on 'google_ai' so
 * getGoogleAccountEmails can never pick up an api_key row).
 */
function resolveDiscoveredVendor(database, service) {
  const bare = bareServiceName(service);
  const catalogRow = catalogRowForKeychainKey(database, service);
  const reserved = new Set([
    ...RESERVED_ACCOUNT_VENDORS,
    ...INTEGRATIONS.filter((d) => d.provider !== 'api_key').map((d) => d.vendor),
  ]);
  const candidates = [];
  if (catalogRow?.provider) {
    candidates.push({ vendor: String(catalogRow.provider), displayName: catalogRow.display_name || null });
  }
  const stripped = slugFromService(bare, { stripSuffix: true });
  const full = slugFromService(bare, { stripSuffix: false });
  candidates.push({ vendor: stripped, displayName: null });
  if (full !== stripped) candidates.push({ vendor: full, displayName: null });

  const picked = candidates.find((c) => c.vendor && !reserved.has(c.vendor));
  if (!picked) return null;
  return {
    vendor: picked.vendor,
    displayName: picked.displayName || catalogRow?.display_name || titleCaseSlug(picked.vendor),
  };
}

// ── Level-triggered keychain passes (df_355651ca) ────────────────────────────

// Catalog derivation (BP3/AC3): every api_key-kind descriptor gets a page-
// catalog row when missing, so session-only vendors become page cards. Not
// gated by the enumeration failsafe — it derives from the registry, not the
// keychain.
function reconcileCatalogRows(database, summary) {
  for (const d of INTEGRATIONS) {
    if (d.credentials.kind !== 'api_key') continue;
    // df_ac0dd301 Fix A: the page catalog is the launch short-list. A non-
    // launch api_key vendor keeps its sessions row (reconcileApiKeyRows, above)
    // but never gets a page-catalog card. Without this the ADD pass re-creates
    // the dropped rows within one cadence.
    if (!PAGE_CATALOG_ALLOWLIST.has(d.vendor)) continue;
    const key = d.credentials.keychainKeys[0];
    if (!key) continue;
    const result = upsertDiscoveredIntegration(
      database,
      d.vendor,
      d.displayName,
      `${KEYCHAIN_SERVICE_PREFIX}${key}`,
      { section: d.card?.section || 'productivity', source: 'registry' },
    );
    if (result.created) summary.keychain.catalogCreated.push(d.vendor);
  }
}

// Discovery (AC3): every enumerated integration-class service not already
// represented gets an accounts row (`vendor:other`) and a page-catalog row.
// Registry-claimed services are skipped — reconcileApiKeyRows and
// reconcileCatalogRows already derive their rows deterministically.
function reconcileKeychainDiscovery(database, services, summary) {
  const registryClaimed = new Set();
  for (const d of INTEGRATIONS) {
    if (d.credentials.kind !== 'api_key') continue;
    for (const key of d.credentials.keychainKeys) registryClaimed.add(`${KEYCHAIN_SERVICE_PREFIX}${key}`);
  }
  const insert = database.prepare(`
    INSERT OR IGNORE INTO accounts
      (id, provider, vendor, type, display_name, keychain_key, status, metadata, created_at, updated_at)
    VALUES (?, 'api_key', ?, 'other', ?, ?, 'active', '{}', datetime('now'), datetime('now'))
  `);
  const accountExists = database.prepare('SELECT id FROM accounts WHERE keychain_key=?');

  for (const service of services) {
    if (registryClaimed.has(service)) continue;
    if (classifyKeychainService(service) !== 'integration') continue;
    const resolved = resolveDiscoveredVendor(database, service);
    if (!resolved) continue; // every candidate collided with a reserved vendor — defensive, cannot happen in the census

    if (!accountExists.get(service)) {
      const result = insert.run(`${resolved.vendor}:other`, resolved.vendor, resolved.displayName, service);
      if (result.changes > 0) summary.keychain.discoveredAccounts.push(`${resolved.vendor}:other`);
    }
    // df_ac0dd301 Fix A: the accounts INSERT above stays UNGATED (sessions see
    // every discovered token). Only the PAGE-catalog row is gated to the launch
    // short-list — a keychain-discovered non-launch token (alchemy, cloudflare,
    // resend, …) is usable in sessions but never shows a page card.
    if (PAGE_CATALOG_ALLOWLIST.has(resolved.vendor)) {
      const catalog = upsertDiscoveredIntegration(
        database,
        resolved.vendor,
        resolved.displayName,
        service,
        { section: 'productivity', source: 'keychain' },
      );
      if (catalog.created) summary.keychain.catalogCreated.push(resolved.vendor);
    }
  }
}

// Presence verification (AC4): api_key rows whose credential is missing from
// the enumeration flip to 'needs_credential' (dropped from /api/accounts,
// flagged on the page); present-and-flagged rows flip back. OAuth rows
// (provider != 'api_key') are structurally out of reach — never-hide holds.
function reconcileCredentialPresence(database, services, summary) {
  const present = new Set(services);
  const rows = database.prepare(`
    SELECT id, keychain_key, status FROM accounts
     WHERE provider='api_key' AND keychain_key IS NOT NULL
  `).all();
  for (const row of rows) {
    if (!present.has(row.keychain_key)) {
      if (row.status !== 'needs_credential') {
        setAccountCredentialStatus(database, row.keychain_key, 'needs_credential');
        summary.keychain.flaggedMissing.push(row.id);
      }
    } else if (row.status === 'needs_credential') {
      setAccountCredentialStatus(database, row.keychain_key, 'active');
      summary.keychain.restored.push(row.id);
    }
  }
}

export const KEYCHAIN_DISCOVERY_HEALTH_NAME = 'keychain-discovery';
const KEYCHAIN_ENUMERATION_FAILED_ERROR =
  'keychain enumeration returned zero services — discovery and presence verification skipped';

function reconcileKeychain(database, listServices, summary) {
  let services = [];
  try {
    services = listServices(KEYCHAIN_SERVICE_PREFIX) || [];
  } catch {
    services = [];
  }
  summary.keychain.enumerated = services.length;

  if (services.length === 0) {
    let apiKeyRows = 0;
    try {
      apiKeyRows = database.prepare(
        `SELECT COUNT(*) AS c FROM accounts WHERE provider='api_key' AND keychain_key IS NOT NULL`
      ).get().c;
    } catch {
      apiKeyRows = 0;
    }
    if (apiKeyRows > 0) {
      // Failsafe: rows say credentials exist, enumeration says the keychain is
      // empty — the enumeration is broken, not the tokens. Surface, skip.
      recordIntegrationJobHealth(database, KEYCHAIN_DISCOVERY_HEALTH_NAME, 'error', {
        error: KEYCHAIN_ENUMERATION_FAILED_ERROR,
        mirrorLedger: false,
      });
      summary.keychain.skipped = true;
    }
    return;
  }

  reconcileKeychainDiscovery(database, services, summary);
  reconcileCredentialPresence(database, services, summary);

  // Level-triggered clear: a recovered enumeration removes OUR failsafe alarm
  // (only ours — mirror of the MICROSOFT_NO_MAILBOX_ERROR pattern).
  try {
    const row = database.prepare('SELECT last_error FROM integration_health WHERE name=?')
      .get(KEYCHAIN_DISCOVERY_HEALTH_NAME);
    if (row?.last_error === KEYCHAIN_ENUMERATION_FAILED_ERROR) {
      recordIntegrationJobHealth(database, KEYCHAIN_DISCOVERY_HEALTH_NAME, 'ok', { mirrorLedger: false });
    }
  } catch { /* integration_health may not exist on first boot — fine */ }
}

// Page-catalog prune (df_ac0dd301 Fix A). Level-triggered, mirroring the ADD
// passes: every converge deletes any keychain_integrations row outside the
// launch allowlist, so the dozen non-launch rows df_355651ca auto-populated go
// and cannot drift back (a stray seed, a future discovery, brave/speechify's
// seed rows). The accounts (sessions) table is untouched — session visibility
// stays broad. Chosen over a one-shot migration because the gate already stops
// re-adds; a prune pass self-heals any stray row instead of relying on a single
// historical DELETE the ADD passes would silently undo.
function reconcilePagesCatalogPrune(database, summary) {
  summary.keychain.pruned = pruneKeychainIntegrationsToAllowlist(database, PAGE_CATALOG_ALLOWLIST);
}

function reconcileMicrosoft(database, secret, summary) {
  const descriptor = INTEGRATIONS.find((d) => d.id === 'microsoft');
  if (!descriptor) return;
  const secretsPresent = descriptor.credentials.keychainKeys.every((key) => !!secret(key));
  summary.microsoft.credentials_present = secretsPresent;
  if (!secretsPresent) return;

  const typed = listTypedMicrosoftEmails(database);
  // Untyped listing merges the legacy Keychain registry
  // (robotdojo-oauth-microsoft-accounts); registry-only = untyped minus typed.
  const untyped = listConnectedMicrosoftAccounts();
  const registryOnly = untyped.filter((email) => !typed.includes(email));

  for (const email of registryOnly) {
    try {
      // Both types: the legacy registry carries no per-product grants. The
      // typed sync paths surface a missing Calendars.Read as a visible
      // integration_health error rather than this pass probing Graph (the
      // reconciler runs every 15 minutes — no network calls here).
      upsertMicrosoftAccounts(database, email, email, ['email', 'calendar']);
      queueOAuthSync(database, 'microsoft', email);
      summary.microsoft.repaired.push(email);
    } catch (err) {
      recordIntegrationJobHealth(database, 'microsoft', 'error', { error: `legacy-registry repair failed for ${email}: ${err.message}` });
      summary.microsoft.errors.push(`${email}: ${err.message}`);
    }
  }

  const typedAfter = listTypedMicrosoftEmails(database);
  if (typedAfter.length === 0) {
    // Tenant secrets but no mailbox anywhere — visible error, never silence.
    recordIntegrationJobHealth(database, 'microsoft', 'error', { error: MICROSOFT_NO_MAILBOX_ERROR });
    summary.microsoft.no_mailbox_error = true;
    return;
  }

  // Mailboxes exist — clear a previously-written no-mailbox alarm (only ours).
  try {
    const row = database.prepare(`SELECT last_error FROM integration_health WHERE name='microsoft'`).get();
    if (row?.last_error === MICROSOFT_NO_MAILBOX_ERROR) {
      recordIntegrationJobHealth(database, 'microsoft', 'ok');
      summary.microsoft.cleared_no_mailbox_error = true;
    }
  } catch { /* integration_health may not exist on first boot — fine */ }
}

/**
 * Run one reconciliation pass. Idempotent — INSERT OR IGNORE on deterministic
 * ids, status flips level-triggered; a second pass on a healthy DB is a no-op.
 *
 * @param {{
 *   database?: import('better-sqlite3').Database,
 *   secret?: (name: string) => string|null,
 *   listServices?: (prefix: string) => string[],
 * }} deps — listServices is injectable so tests never touch the live keychain.
 * @returns {{ checked: number, createdAccounts: string[], queuedProviders: string[], microsoft: object, keychain: object, error?: string }}
 */
export function reconcileIntegrations({ database = db, secret = configSecret, listServices = listKeychainServices } = {}) {
  const summary = {
    checked: INTEGRATIONS.length,
    createdAccounts: [],
    queuedProviders: [],
    microsoft: { credentials_present: false, repaired: [], errors: [], no_mailbox_error: false, cleared_no_mailbox_error: false },
    keychain: { enumerated: 0, skipped: false, discoveredAccounts: [], catalogCreated: [], flaggedMissing: [], restored: [], pruned: 0 },
  };
  try {
    reconcileApiKeyRows(database, secret, summary);
    reconcileMicrosoft(database, secret, summary);
    reconcileCatalogRows(database, summary);
    reconcileKeychain(database, listServices, summary);
    // AFTER the ADD passes: prune the page catalog to the launch short-list so a
    // converge always leaves it level-triggered-clean (df_ac0dd301 Fix A).
    reconcilePagesCatalogPrune(database, summary);
  } catch (err) {
    // Never take down boot or the monitor — record and surface.
    summary.error = err.message;
    try {
      // The integration reconciler is a cadence pass owned by
      // scripts/integration-monitor.js, not a drainable passive job type. Keep
      // the visible integration_health row, but do not mirror it into
      // passive_jobs where it would become an orphan queue row with no handler.
      recordIntegrationJobHealth(database, 'reconciler', 'error', { error: err.message, mirrorLedger: false });
    } catch { /* health table unavailable — nothing left to write to */ }
  }
  return summary;
}
