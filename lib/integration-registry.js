/**
 * integration-registry.js — the single declaration every integration surface
 * derives from (st_fd14cdd4 AC2).
 *
 * One descriptor per integration. The seven previously hand-wired surfaces are
 * now READERS of this registry:
 *
 *   1. accounts rows ............ lib/integration-reconciler.js (boot + 15-min cadence)
 *   2. PROVIDER_JOBS ............ lib/oauth-sync-queue.js  → buildProviderJobs()
 *   3. passive sync plan ........ lib/passive-sync-orchestrator.js → syncJobEntries()
 *   4. doc counts ............... lib/integrations-queries.js → docCountFor()
 *   5. health probes ............ lib/integration-health.js → registryProbeNames()
 *   6. seed migration ........... RETIRED for new integrations — the consumed-once
 *                                 `seed-api-key-integrations` migration in lib/db.js
 *                                 stays for history; the reconciler derives rows
 *                                 from descriptors instead (research §5b trap).
 *   7. card metadata ............ lib/launch-integrations.js → registryCard()
 *
 * Adding an integration = one descriptor here + one sync module. The contract
 * check (scripts/check-performance-memory-polish.js) asserts the registry ↔
 * surface derivation bidirectionally and fails the commit when a descriptor
 * has no surface or a surface entry has no descriptor.
 *
 * PURITY CONTRACT: this module imports nothing heavier than node builtins and
 * lib/apple-store-paths.js (also pure). NO lib/db.js, NO lib/config.js. All
 * database and secret access is injected by the reader (`docCount(db, email)`,
 * `condition(ctx)`), so the pre-commit contract check can import this module
 * without opening the live database.
 *
 * Descriptor schema (the contract Katagami built against — see 02-plan.md):
 *   id            unique registry id
 *   vendor        accounts.vendor value
 *   provider      accounts.provider value ('api_key' for key-only rows)
 *   displayName   human name (drives reconciler display_name)
 *   accountShape  { types: string[], idScheme: 'slug'|'uuid'|'none' }
 *                 slug rows have deterministic ids `${vendor}:${type}`
 *   credentials   { keychainKeys: string[], kind: 'oauth'|'app_credentials'|'api_key'|'local'|'none' }
 *                 keychainKeys are secret() names (Keychain service is `robotdojo-${key}`)
 *   jobs          [{ jobType, kind, name?, priority, timeoutMs, perAccount,
 *                    accountType?, connectProvider?, condition?, payload? }]
 *                 perAccount jobs enumerate active accounts rows by vendor(+accountType)
 *                 and are named `${kind}:${email}`; fixed jobs use `name`.
 *                 connectProvider groups kinds into PROVIDER_JOBS for queueOAuthSync.
 *   connectJobs   kinds queued on connect, in the historical PROVIDER_JOBS order
 *   healthNames   (email?) => string[] in the `{job}` / `{job}:{email}` namespace
 *   probeNames    fixed integration-health probe names this descriptor owns
 *                 (lib/integration-health.js maps each to a probe function)
 *   docCounts     { [healthNamePrefix]: (db, email?) => number|null }
 *   card          account-integration card contract object, or null. Family
 *                 descriptors may share one card object (deduped by card.id).
 *   peopleSeeding { interchange: InterchangeKind|InterchangeKind[], reason }
 *                 reason is REQUIRED when interchange is 'none' (AC5/AC6) —
 *                 the contract check rejects a bare 'none'.
 */
import {
  appleCalendarStorePath,
  appleCallStorePath,
  appleMailEnvelopePath,
  appleNotesStorePath,
} from './apple-store-paths.js';

export const CREDENTIAL_KINDS = Object.freeze(['oauth', 'app_credentials', 'api_key', 'local', 'none']);
export const ID_SCHEMES = Object.freeze(['slug', 'uuid', 'none']);

// ── Keychain classification constants (df_355651ca AC3) ─────────────────────
// The reconciler's keychain-discovery pass classifies every enumerated
// robotdojo-* service as 'integration' (surfaces on the accounts page and in
// every agent session) or 'excluded' (plumbing: OAuth token material, the
// product's own auth secrets, identifier/companion halves of credential sets).
// These lists were derived from the live 60-service keychain census in the
// sealed plan (02-plan.md), NOT from memory — every live service is classified
// explicitly and the census is pinned as a test fixture in
// tests/integration-reconciler.test.js. Rule order lives in
// lib/integration-reconciler.js#classifyKeychainService; a registry api_key
// claim always wins, so a future integration whose name matches an exclusion
// pattern joins via one descriptor (the standing escape hatch).

// OAuth token material (per-email access/refresh/expiry triplets) — always
// excluded; OAuth accounts are represented by their own accounts rows.
export const KEYCHAIN_OAUTH_PREFIX = 'robotdojo-oauth-';

// The product's own auth/device/relay material (bare name, after the
// `robotdojo-` service prefix is stripped) — never an integration.
export const KEYCHAIN_INTERNAL_PREFIXES = Object.freeze(['ROBOTDOJO_']);

// Structural suffixes of identifiers and companion secrets — the non-token
// halves of credential sets (e.g. STRIPE_WEBHOOK_SECRET beside the
// STRIPE_SECRET_KEY integration, CLOUDFLARE_ZONE_ID beside
// CLOUDFLARE_API_TOKEN).
export const KEYCHAIN_EXCLUDED_SUFFIXES = Object.freeze([
  '_ID', '_SECRET', '_PUBLISHABLE_KEY', '_SLUG', '_EMAIL', '_URL', '_BUCKET', '_WALLET',
]);

// Explicit remainder — plumbing names no structural rule catches:
//   AWS_SECRET_ACCESS_KEY  companion of the `_ID`-excluded AWS pair
//   LOCAL_DB_KEY           the local database encryption key
//   GOOGLE_API_KEY         alias of the same Gemini credential as
//                          GOOGLE_AI_API_KEY (represented by that surface)
//   MIYAGI_TOKEN           defensive-only — NOT in the live keychain; the
//                          integration-context hook reads it as an auth-token
//                          fallback, so if it ever appears it is app auth
//                          material, never an integration
export const KEYCHAIN_EXCLUDED_SERVICES = Object.freeze([
  'AWS_SECRET_ACCESS_KEY', 'LOCAL_DB_KEY', 'GOOGLE_API_KEY', 'MIYAGI_TOKEN',
  'EIGHT_SLEEP_SESSION',
]);

// Vendors a discovered slug may never land on — each owns a non-api_key
// account surface, and a colliding api_key row would leak into its queries
// (e.g. getGoogleAccountEmails would return a null-email account).
export const RESERVED_ACCOUNT_VENDORS = Object.freeze([
  'google', 'microsoft', 'apple', 'imports', 'robotdojo',
]);

// Common credential suffixes stripped when deriving a vendor slug from a
// discovered service name (ALCHEMY_API_KEY → alchemy). Checked
// longest-match-first by the discovery pass so `_api_key` wins over `_key`.
export const CREDENTIAL_SUFFIXES = Object.freeze([
  '_api_key', '_api_token', '_bot_token', '_token', '_key', '_pat',
]);
// Extension point (plan §schema): new interchange kinds (e.g. 'note_mentions')
// are added here without touching any derived surface.
export const INTERCHANGE_KINDS = Object.freeze([
  'email_participants',
  'calendar_attendees',
  'transcript_attendees',
  'phone',
  'none',
]);

// ── Doc-count helpers ────────────────────────────────────────────────────────
// SQL moved from lib/integrations-queries.js (st_d499b891) so the count logic
// lives with the integration that owns it. Each fn returns number|null; null
// means "no count available" (missing account row / table absent — callers
// already treat null as blank).

function googleAccountId(db, type, email) {
  return db.prepare(`SELECT id FROM accounts WHERE vendor='google' AND type=? AND email=?`).get(type, email)?.id ?? null;
}

const GOOGLE_DOC_COUNTS = {
  gmail: (db, email) => {
    const id = googleAccountId(db, 'email', email);
    if (!id) return null;
    return db.prepare(`SELECT COUNT(*) AS c FROM emails WHERE account_id=?`).get(id)?.c ?? null;
  },
  calendar: (db, email) => db.prepare(`
    SELECT COUNT(*) AS c
      FROM calendar_events
     WHERE account_id IN (
       SELECT id FROM accounts
        WHERE vendor='google'
          AND email=?
          AND type IN ('calendar', 'email')
     )
  `).get(email)?.c ?? null,
  drive: (db, email) => {
    const id = googleAccountId(db, 'drive', email);
    if (!id) return null;
    return db.prepare(`SELECT COUNT(*) AS c FROM drive_files WHERE account_id=?`).get(id)?.c ?? null;
  },
  contacts: (db, email) => db.prepare(`SELECT COUNT(*) AS c FROM google_contacts WHERE account_id=?`).get(email)?.c ?? null,
  photos: (db, email) => {
    const id = googleAccountId(db, 'email', email);
    if (!id) return null;
    return db.prepare(`SELECT COUNT(*) AS c FROM photos WHERE account_id=?`).get(id)?.c ?? null;
  },
};

function microsoftEmailCount(db, email) {
  return db.prepare(`SELECT COUNT(*) AS c FROM emails WHERE account_id IN (SELECT id FROM accounts WHERE vendor='microsoft' AND email=?)`).get(email)?.c ?? null;
}

const MICROSOFT_DOC_COUNTS = {
  // WHY both prefixes: integration_health rows are named `microsoft-mail:{email}`
  // but the pre-registry getDocCount only knew `microsoft-email:` — so the live
  // health endpoint returned doc_count null for every Microsoft mail row (the
  // exact silent-blank class this story kills). Both names now resolve.
  'microsoft-mail': microsoftEmailCount,
  'microsoft-email': microsoftEmailCount,
  'microsoft-calendar': (db, email) => {
    const acct = db.prepare(`SELECT id FROM accounts WHERE vendor='microsoft' AND type='calendar' AND email=?`).get(email);
    if (!acct) return null;
    return db.prepare(`SELECT COUNT(*) AS c FROM calendar_events WHERE source='graph' AND account_id=?`).get(acct.id)?.c ?? null;
  },
};

// ── Shared card objects ──────────────────────────────────────────────────────
// Copied verbatim from the pre-registry lib/launch-integrations.js contracts so
// the derived ACCOUNT_INTEGRATION_CONTRACTS array is byte-identical for the UI.

const APPLE_LOCAL_CARD = Object.freeze({
  id: 'apple-local',
  provider: 'apple',
  name: 'Apple local data',
  section: 'workspace',
  substrate_type: 'local',
  required: true,
  products: ['imessage', 'contacts', 'calendar', 'photos_metadata', 'calls', 'notes', 'mail', 'files'],
  recovery: 'Grant Full Disk Access so Robot Dojo can read iMessage, Contacts, Calendar, Photos metadata, Call history, Notes, and local Mail.',
});

// Shared by the asana and asana_secondary descriptors (df_355651ca Key decision 1) —
// the same family-card pattern as APPLE_LOCAL_CARD. registryCards() dedupes by
// card.id, so both tokens render as sub-accounts of one Asana card and the
// ACCOUNT_INTEGRATION_CONTRACTS count is unchanged.
const ASANA_CARD = Object.freeze({
  id: 'asana',
  provider: 'asana',
  name: 'Asana',
  section: 'productivity',
  substrate_type: 'api_key',
  required: true,
  recovery: 'Paste an Asana personal access token so tasks and projects can enter memory.',
});

// ── Descriptors ──────────────────────────────────────────────────────────────

const INTEGRATIONS_LIST = [
  // 1. Google Workspace — interactive OAuth; rows written by the callback.
  {
    id: 'google',
    vendor: 'google',
    provider: 'google',
    displayName: 'Google',
    accountShape: { types: ['email', 'calendar', 'drive'], idScheme: 'uuid' },
    credentials: { keychainKeys: [], kind: 'oauth' },
    jobs: [
      // Plan order preserved from the pre-registry planPassiveSyncJobs loop.
      { jobType: 'oauth_sync', kind: 'gmail', priority: 70, timeoutMs: 180_000, perAccount: true, accountType: null, connectProvider: 'google' },
      { jobType: 'oauth_sync', kind: 'calendar', priority: 70, timeoutMs: 180_000, perAccount: true, accountType: null, connectProvider: 'google' },
      { jobType: 'oauth_sync', kind: 'contacts', priority: 70, timeoutMs: 120_000, perAccount: true, accountType: null, connectProvider: 'google' },
      { jobType: 'oauth_sync', kind: 'photos', priority: 70, timeoutMs: 120_000, perAccount: true, accountType: null, connectProvider: 'google' },
      { jobType: 'oauth_sync', kind: 'drive', priority: 70, timeoutMs: 180_000, perAccount: true, accountType: null, connectProvider: 'google' },
    ],
    // Historical PROVIDER_JOBS order (differs from plan order; queue order is
    // not semantic — preserved to keep the derived constant byte-equal).
    connectJobs: ['gmail', 'calendar', 'drive', 'contacts', 'photos'],
    // st_fd14cdd4 P6 — declared history backfill: the supervisor probe
    // (lib/passive-supervisor.js) enqueues one email_history_backfill job per
    // active `vendor:accountType` account. Declared here (not hardcoded in the
    // supervisor) so a future provider-side history walk (e.g. Outlook) is a
    // descriptor field + handler, never a supervisor edit. Only Google
    // declares it today: the handler walks Gmail history
    // (scripts/backfill-email-history.js).
    historyBackfill: {
      jobType: 'email_history_backfill',
      accountType: 'email',
      priority: 25,
      timeoutMs: 5 * 60_000,
      payload: { chunk: 3000 },
    },
    // st_fd14cdd4 reopen — provider-history sweep: imported (drop-folder)
    // emails lost their To/Cc when the source files were deleted, but the
    // headers still exist provider-side. One keyed participants_backfill job
    // per active Google mailbox pages the mailbox (metadata format, no
    // bodies), matches stored dropfolder rows by Message-ID, and writes
    // participants + seeding. Declared HERE so connecting a mailbox later
    // (e.g. the source account behind an old imported archive) auto-seeds its
    // sweep — no code change, the supervisor derives it.
    historySweep: {
      jobType: 'participants_backfill',
      source: 'providersweep',
      accountType: 'email',
      priority: 20,
      timeoutMs: 300_000,
    },
    healthNames: (email) => ['gmail', 'calendar', 'drive', 'contacts', 'photos'].map((j) => `${j}:${email}`),
    probeNames: [],
    docCounts: GOOGLE_DOC_COUNTS,
    card: Object.freeze({
      id: 'google-workspace',
      provider: 'google',
      name: 'Google Workspace',
      section: 'workspace',
      substrate_type: 'oauth',
      required: true,
      products: ['gmail', 'calendar', 'contacts', 'drive', 'docs', 'sheets', 'slides', 'photos', 'search_console'],
      recovery: 'Connect Google and click through the private-beta consent warning.',
    }),
    peopleSeeding: { interchange: ['email_participants', 'calendar_attendees'], reason: 'gmail-sync + calendar-sync seed at sync time (live since st_87a0d072)' },
  },

  // 2. Microsoft Graph — app-only client credentials; mailbox rows added via
  // POST /api/integrations/microsoft/connect (the single supported action) or
  // repaired from the legacy Keychain registry by the reconciler.
  {
    id: 'microsoft',
    vendor: 'microsoft',
    provider: 'microsoft',
    displayName: 'Microsoft',
    accountShape: { types: ['email', 'calendar'], idScheme: 'uuid' },
    credentials: { keychainKeys: ['MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'], kind: 'app_credentials' },
    jobs: [
      { jobType: 'oauth_sync', kind: 'microsoft-mail', priority: 70, timeoutMs: 180_000, perAccount: true, accountType: 'email', connectProvider: 'microsoft' },
      { jobType: 'oauth_sync', kind: 'microsoft-calendar', priority: 70, timeoutMs: 180_000, perAccount: true, accountType: 'calendar', connectProvider: 'microsoft' },
    ],
    connectJobs: ['microsoft-mail', 'microsoft-calendar'],
    // st_fd14cdd4 reopen, directive 2 — full mailbox history: the live sync
    // only captures the post-registration window; this sweep walks backward
    // (receivedDateTime lt watermark) until the mailbox floor, storing rows +
    // participants + seeding through the live-sync path
    // (scripts/backfill-participants.js --source mshistory).
    historySweep: {
      jobType: 'participants_backfill',
      source: 'mshistory',
      accountType: 'email',
      priority: 20,
      timeoutMs: 300_000,
    },
    healthNames: (email) => [`microsoft-mail:${email}`, `microsoft-calendar:${email}`],
    probeNames: [],
    docCounts: MICROSOFT_DOC_COUNTS,
    card: Object.freeze({
      id: 'microsoft',
      provider: 'microsoft',
      name: 'Microsoft Outlook',
      section: 'workspace',
      substrate_type: 'app_credentials',
      required: true,
      products: ['mail', 'calendar'],
      recovery: 'Microsoft uses tenant-admin Graph application permissions. Store tenant/client/secret, grant admin consent, then add mailbox email. Do not use the delegated approval prompt.',
    }),
    peopleSeeding: { interchange: ['email_participants', 'calendar_attendees'], reason: 'outlook-sync participants + graph-calendar-sync attendee seeding (st_fd14cdd4)' },
  },

  // 3-9. Apple local family — one card, per-store descriptors.
  {
    id: 'imessage',
    vendor: 'apple',
    provider: 'apple',
    displayName: 'iMessage',
    accountShape: { types: [], idScheme: 'none' },
    credentials: { keychainKeys: [], kind: 'local' },
    jobs: [
      { jobType: 'local_sync', kind: 'imessage', name: 'imessage', priority: 55, timeoutMs: 70_000, perAccount: false, payload: { limit: 500 } },
    ],
    connectJobs: [],
    healthNames: () => ['imessage'],
    probeNames: ['imessage'],
    docCounts: {
      imessage: (db) => db.prepare(`SELECT COUNT(*) AS c FROM imessages`).get()?.c ?? null,
    },
    card: APPLE_LOCAL_CARD,
    peopleSeeding: { interchange: 'phone', reason: 'handles resolve create-or-link via resolvePerson (st_fd14cdd4 upgraded from link-only)' },
  },
  {
    id: 'apple-photos',
    vendor: 'apple',
    provider: 'apple',
    displayName: 'Apple Photos',
    accountShape: { types: [], idScheme: 'none' },
    credentials: { keychainKeys: [], kind: 'local' },
    jobs: [
      { jobType: 'local_sync', kind: 'apple-photos', name: 'apple-photos', priority: 45, timeoutMs: 70_000, perAccount: false, payload: { limit: 1000 } },
    ],
    connectJobs: [],
    healthNames: () => ['apple-photos'],
    probeNames: ['apple-photos'],
    docCounts: {
      'apple-photos': (db) => db.prepare(`SELECT COUNT(*) AS c FROM photos WHERE account_id LIKE 'apple%' OR account_id='local'`).get()?.c ?? null,
    },
    card: APPLE_LOCAL_CARD,
    peopleSeeding: { interchange: 'none', reason: 'metadata only — no people identifiers captured today; face detection is OOS 1 (own story)' },
  },
  {
    id: 'apple-addressbook',
    vendor: 'apple',
    provider: 'apple',
    displayName: 'Apple Contacts',
    accountShape: { types: [], idScheme: 'none' },
    credentials: { keychainKeys: [], kind: 'local' },
    // Read at onboard/rebuild by lib/contacts-extractor.js — creates people
    // directly (rank-1 source). Not in the passive plan: contact identity has
    // no freshness pressure between onboards; re-read joins a future story if
    // continuous contact refresh is wanted.
    jobs: [],
    connectJobs: [],
    healthNames: () => [],
    probeNames: [],
    docCounts: {},
    card: APPLE_LOCAL_CARD,
    peopleSeeding: { interchange: 'none', reason: 'creates people directly via contacts-extractor resolvePerson (rank-1) — no intermediate interchange table' },
  },
  {
    id: 'apple-calendar',
    vendor: 'apple',
    provider: 'apple',
    displayName: 'Apple Calendar',
    accountShape: { types: [], idScheme: 'none' },
    credentials: { keychainKeys: [], kind: 'local' },
    jobs: [
      // st_fd14cdd4 Phase 2: local readers join the passive plan as low-priority
      // local_sync kinds so they refresh continuously after onboarding, not only
      // at onboard. Condition: only planned when the store exists on this
      // machine (the reader would error-loop on absent stores otherwise).
      { jobType: 'local_sync', kind: 'apple-calendar', name: 'apple-calendar', priority: 25, timeoutMs: 70_000, perAccount: false, condition: () => !!appleCalendarStorePath() },
    ],
    connectJobs: [],
    healthNames: () => ['apple-calendar'],
    probeNames: [],
    docCounts: {
      'apple-calendar': (db) => db.prepare(`SELECT COUNT(*) AS c FROM calendar_events WHERE source='apple-local'`).get()?.c ?? null,
    },
    card: APPLE_LOCAL_CARD,
    // AC6 verdict (plan): retired from people seeding BY NAME — the reader
    // upserts attendees='[]' and organizer='' by construction (live: 16,020
    // apple-local events, zero with attendees). Participant capture from the
    // local store's participant tables is net-new detection, its own story.
    peopleSeeding: { interchange: 'none', reason: 'retired by name (AC6) — reader writes attendees=[] by construction; local participant-table capture is its own story' },
  },
  {
    id: 'apple-mail',
    vendor: 'apple',
    provider: 'apple',
    displayName: 'Apple Mail',
    accountShape: { types: [], idScheme: 'none' },
    credentials: { keychainKeys: [], kind: 'local' },
    jobs: [
      { jobType: 'local_sync', kind: 'apple-mail', name: 'apple-mail', priority: 25, timeoutMs: 70_000, perAccount: false, condition: () => !!appleMailEnvelopePath() },
    ],
    connectJobs: [],
    healthNames: () => ['apple-mail'],
    probeNames: [],
    docCounts: {
      'apple-mail': (db) => db.prepare(`SELECT COUNT(*) AS c FROM emails WHERE id LIKE 'apple-mail:%'`).get()?.c ?? null,
    },
    card: APPLE_LOCAL_CARD,
    peopleSeeding: { interchange: 'email_participants', reason: 'sender email+name → participants + seeding at read (st_fd14cdd4)' },
  },
  {
    id: 'apple-calls',
    vendor: 'apple',
    provider: 'apple',
    displayName: 'Apple Calls',
    accountShape: { types: [], idScheme: 'none' },
    credentials: { keychainKeys: [], kind: 'local' },
    jobs: [
      { jobType: 'local_sync', kind: 'apple-calls', name: 'apple-calls', priority: 25, timeoutMs: 70_000, perAccount: false, condition: () => !!appleCallStorePath() },
    ],
    connectJobs: [],
    healthNames: () => ['apple-calls'],
    probeNames: [],
    docCounts: {
      'apple-calls': (db) => db.prepare(`SELECT COUNT(*) AS c FROM calls`).get()?.c ?? null,
    },
    card: APPLE_LOCAL_CARD,
    peopleSeeding: { interchange: 'phone', reason: 'phone+name → seeding + person_interactions channel call at read (st_fd14cdd4)' },
  },
  {
    id: 'apple-notes',
    vendor: 'apple',
    provider: 'apple',
    displayName: 'Apple Notes',
    accountShape: { types: [], idScheme: 'none' },
    credentials: { keychainKeys: [], kind: 'local' },
    jobs: [
      { jobType: 'local_sync', kind: 'apple-notes', name: 'apple-notes', priority: 25, timeoutMs: 70_000, perAccount: false, condition: () => !!appleNotesStorePath() },
    ],
    connectJobs: [],
    healthNames: () => ['apple-notes'],
    probeNames: [],
    docCounts: {
      'apple-notes': (db) => db.prepare(`SELECT COUNT(*) AS c FROM notes`).get()?.c ?? null,
    },
    card: APPLE_LOCAL_CARD,
    peopleSeeding: { interchange: 'none', reason: 'extracting names from note text is OOS 1 by name; notes carry no structured person identifiers' },
  },

  // 10. Granola meeting transcripts.
  {
    id: 'granola',
    vendor: 'granola',
    provider: 'granola',
    displayName: 'Granola',
    accountShape: { types: [], idScheme: 'none' },
    credentials: { keychainKeys: ['GRANOLA_TOKEN'], kind: 'local' },
    jobs: [
      { jobType: 'granola_sync', kind: 'granola', name: 'granola', priority: 50, timeoutMs: 120_000, perAccount: false },
    ],
    connectJobs: [],
    healthNames: () => ['granola'],
    probeNames: ['granola'],
    docCounts: {
      granola: (db) => db.prepare(`SELECT COUNT(*) AS c FROM transcripts WHERE source='granola'`).get()?.c ?? null,
    },
    card: Object.freeze({
      id: 'granola',
      provider: 'granola',
      name: 'Granola',
      section: 'productivity',
      substrate_type: 'local',
      required: true,
      recovery: 'Install Granola and sign in. Robot Dojo reads local meeting transcripts.',
    }),
    peopleSeeding: { interchange: 'transcript_attendees', reason: 'attendee emails (payload or calendar-join fallback) seed + person_interactions channel meeting (st_fd14cdd4)' },
  },

  // 11. Oura — api-key + sync.
  {
    id: 'oura',
    vendor: 'oura',
    provider: 'api_key',
    displayName: 'Oura',
    accountShape: { types: ['health'], idScheme: 'slug' },
    credentials: { keychainKeys: ['OURA_PAT'], kind: 'api_key' },
    jobs: [
      { jobType: 'oura_sync', kind: 'oura', name: 'oura', priority: 50, timeoutMs: 120_000, perAccount: false, connectProvider: 'oura', condition: (ctx) => !!(ctx.secret('OURA_PAT') || ctx.secret('OURA_CLIENT_SECRET') || ctx.hasActiveAccount('oura')) },
    ],
    connectJobs: ['oura'],
    healthNames: () => ['oura'],
    probeNames: ['oura'],
    docCounts: {
      oura: (db) => db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM health_notes WHERE source='oura')
          + (SELECT COUNT(*) FROM health_data_points WHERE source IN ('oura_sync', 'oura-json')) AS c
      `).get()?.c ?? null,
    },
    card: Object.freeze({
      id: 'oura',
      provider: 'oura',
      name: 'Oura',
      section: 'health',
      substrate_type: 'api_key',
      required: true,
      recovery: 'Paste an Oura token or import health files manually.',
    }),
    peopleSeeding: { interchange: 'none', reason: 'health metrics carry no people identifiers (inventory n/a)' },
  },

  // 11c. Eight Sleep — password-grant + nightly sleep trends.
  {
    id: 'eightsleep',
    vendor: 'eightsleep',
    provider: 'eightsleep',
    displayName: 'Eight Sleep',
    accountShape: { types: ['health'], idScheme: 'slug' },
    credentials: { keychainKeys: ['EIGHT_SLEEP_PASSWORD'], kind: 'local' },
    jobs: [
      {
        jobType: 'eight_sleep_sync',
        kind: 'eightsleep',
        name: 'eightsleep',
        priority: 50,
        timeoutMs: 120_000,
        perAccount: false,
        connectProvider: 'eightsleep',
        condition: (ctx) => !!(ctx.secret('EIGHT_SLEEP_PASSWORD') && ctx.secret('EIGHT_SLEEP_EMAIL')),
      },
    ],
    connectJobs: ['eightsleep'],
    healthNames: () => ['eightsleep'],
    probeNames: ['eightsleep'],
    docCounts: {
      eightsleep: (db) => db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM health_notes WHERE source='eightsleep')
          + (SELECT COUNT(*) FROM health_data_points WHERE source='eight_sleep_sync') AS c
      `).get()?.c ?? null,
    },
    card: Object.freeze({
      id: 'eightsleep',
      provider: 'eightsleep',
      name: 'Eight Sleep',
      section: 'health',
      substrate_type: 'local',
      required: false,
      recovery: 'Store the Eight Sleep login in Keychain as EIGHT_SLEEP_EMAIL and EIGHT_SLEEP_PASSWORD.',
    }),
    peopleSeeding: { interchange: 'none', reason: 'health metrics carry no people identifiers (inventory n/a)' },
  },

  // 11b. Monarch — household ledger copy. Local session, weekly replace.
  {
    id: 'monarch',
    vendor: 'monarch',
    provider: 'monarch',
    displayName: 'Monarch',
    accountShape: { types: ['finances'], idScheme: 'slug' },
    credentials: { keychainKeys: ['MONARCH_SESSION', 'MONARCH_OP_SA_TOKEN'], kind: 'local' },
    jobs: [
      { jobType: 'monarch_sync', kind: 'monarch', name: 'monarch', priority: 40, timeoutMs: 600_000, perAccount: false },
    ],
    connectJobs: [],
    healthNames: () => ['monarch'],
    probeNames: ['monarch'],
    docCounts: {},
    card: Object.freeze({
      id: 'monarch',
      provider: 'monarch',
      name: 'Monarch',
      section: 'finances',
      substrate_type: 'local',
      required: false,
      recovery: 'Put the Monarch login in the Robot Dojo vault. Use a 1Password service account limited to that vault. Turn off Settings → Developer → Integrate with 1Password CLI so agents cannot see other vaults.',
    }),
    peopleSeeding: { interchange: 'none', reason: 'household ledger copy; no people identifiers' },
  },

  // 12. Asana — api-key + sync (the primary personal token).
  {
    id: 'asana',
    vendor: 'asana',
    provider: 'api_key',
    displayName: 'Asana',
    accountShape: { types: ['task'], idScheme: 'slug' },
    credentials: { keychainKeys: ['ASANA_PAT'], kind: 'api_key' },
    jobs: [
      { jobType: 'asana_sync', kind: 'asana', name: 'asana', priority: 45, timeoutMs: 120_000, perAccount: false, connectProvider: 'asana', payload: { provider: 'asana' }, condition: (ctx) => !!ctx.secret('ASANA_PAT') },
    ],
    connectJobs: ['asana'],
    healthNames: () => ['asana'],
    probeNames: ['asana'],
    docCounts: {},
    card: ASANA_CARD,
    peopleSeeding: { interchange: 'none', reason: 'sync writes topic-context chunks only (asana-context-sync.js); assignee/collaborator identifier capture is net-new extraction, own story' },
  },

  // 12b. Asana Secondary — second token, own descriptor (df_355651ca Key decision 1).
  // WHY a second descriptor and not a registry shape change: the reconciler
  // derives exactly one `vendor:type` accounts row per descriptor
  // (keychainKeys[0]) — a credential alias on the asana descriptor can never
  // become an accounts row, which is exactly how the secondary token stayed
  // invisible to /api/accounts and every agent session. Vendor `asana_secondary` is
  // distinct from `asana`, so chunk counting and WHERE vendor='asana' queries
  // keep their meaning; the shared ASANA_CARD keeps secondary a sub-account of the
  // single Asana card on the page.
  {
    id: 'asana_secondary',
    vendor: 'asana_secondary',
    provider: 'api_key',
    // Generic second-Asana-account label — a user-added secondary Asana
    // workspace, not any specific employer.
    //
    // THIS DESCRIPTOR IS THE SOURCE OF TRUTH FOR THE IDENTIFIER, which is what
    // made st_dd0e19d8 AC20's rename cheap. The `accounts`, `keychain_integrations`
    // and `integration_health` rows are DERIVED: the reconciler rebuilds them
    // from here at boot and on the 15-minute cadence, so renaming the identifier
    // here renames them without a data migration to keep in step. Migration 146
    // only clears the three stale rows and re-prefixes the existing chunks so the
    // rebuild has nothing to collide with.
    displayName: 'Asana (Secondary)',
    accountShape: { types: ['task'], idScheme: 'slug' },
    credentials: { keychainKeys: ['ASANA_PAT_SECONDARY'], kind: 'api_key' },
    jobs: [
      { jobType: 'asana_sync', kind: 'asana', name: 'asana_secondary', priority: 45, timeoutMs: 120_000, perAccount: false, connectProvider: 'asana_secondary', payload: { provider: 'asana_secondary' }, condition: (ctx) => !!ctx.secret('ASANA_PAT_SECONDARY') },
    ],
    connectJobs: ['asana_secondary'],
    healthNames: () => ['asana_secondary'],
    // st_bf4978b0 QA-fix — the secondary token now gets its own live cadence probe
    // (probeAsanaSecondary in lib/integration-health.js), so its verified_at advances
    // and its card is truthfully Healthy instead of a permanent false Issue.
    probeNames: ['asana_secondary'],
    docCounts: {},
    card: ASANA_CARD,
    peopleSeeding: { interchange: 'none', reason: 'sync writes topic-context chunks only (asana-context-sync.js); assignee/collaborator identifier capture is net-new extraction, own story' },
  },

  // 13. Notion — api-key; outbound topic push only.
  {
    id: 'notion',
    vendor: 'notion',
    provider: 'api_key',
    displayName: 'Notion',
    accountShape: { types: ['other'], idScheme: 'slug' },
    credentials: { keychainKeys: ['NOTION_TOKEN'], kind: 'api_key' },
    jobs: [
      { jobType: 'notion_sync', kind: 'notion', name: 'notion', priority: 35, timeoutMs: 180_000, perAccount: false, payload: { maxTopics: 25 }, condition: (ctx) => !!(ctx.secret('NOTION_TOKEN') || ctx.hasActiveAccount('notion')) },
    ],
    connectJobs: [],
    healthNames: () => ['notion'],
    probeNames: ['notion'],
    docCounts: {},
    card: Object.freeze({
      id: 'notion',
      provider: 'notion',
      name: 'Notion',
      section: 'productivity',
      substrate_type: 'api_key',
      required: true,
      recovery: 'Paste a Notion integration token or import a Notion export zip.',
    }),
    peopleSeeding: { interchange: 'none', reason: 'no inbound data — outbound topic push only' },
  },

  // 14. Drop-folder email imports — registers accounts rows at data arrival.
  {
    id: 'imports',
    vendor: 'imports',
    provider: 'imports',
    displayName: 'Email imports',
    accountShape: { types: ['email'], idScheme: 'slug' },
    credentials: { keychainKeys: [], kind: 'none' },
    jobs: [
      { jobType: 'imports_snapshot', kind: 'imports-snapshot', name: 'imports-snapshot', priority: 30, timeoutMs: 60_000, perAccount: false },
    ],
    connectJobs: [],
    healthNames: () => ['imports-snapshot'],
    probeNames: [],
    docCounts: {},
    card: null,
    peopleSeeding: { interchange: 'email_participants', reason: 'sender+to/cc parsed from import headers → participants + seeding at import (st_fd14cdd4)' },
  },

  // 15. LinkedIn — enrichment overlay only (OOS 2): extraction deliberately
  // removed (scripts/ingest/01-extract.js); stays removed.
  {
    id: 'linkedin',
    vendor: 'linkedin',
    provider: 'linkedin',
    displayName: 'LinkedIn',
    accountShape: { types: [], idScheme: 'none' },
    credentials: { keychainKeys: [], kind: 'none' },
    jobs: [],
    connectJobs: [],
    healthNames: () => [],
    probeNames: [],
    docCounts: {},
    card: null,
    enrichmentOnly: true,
    peopleSeeding: { interchange: 'none', reason: 'enrichment overlay only — extraction deliberately removed (OOS 2); never creates entities' },
  },

  // 15b. Lulu Print API — app-only client credentials (key + secret), no
  // inbound data sync. The book engine (st_64d7e5ff) uses these to cost and
  // preview print-on-demand orders against Lulu's sandbox. Mirrors the
  // Microsoft app_credentials shape; jobs:[] because nothing syncs inbound.
  {
    id: 'lulu',
    vendor: 'lulu',
    provider: 'api_key',
    displayName: 'Lulu',
    accountShape: { types: ['print'], idScheme: 'slug' },
    credentials: { keychainKeys: ['LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET'], kind: 'app_credentials' },
    jobs: [],
    connectJobs: [],
    healthNames: () => [],
    probeNames: [],
    docCounts: {},
    card: Object.freeze({
      id: 'lulu',
      provider: 'lulu',
      name: 'Lulu Print',
      section: 'productivity',
      substrate_type: 'app_credentials',
      required: false,
      recovery: 'Paste a Lulu sandbox client key + secret to cost and preview print-on-demand book orders.',
    }),
    peopleSeeding: { interchange: 'none', reason: 'print-service credentials carry no people identifiers' },
  },

  // 16-24. API-key-only service credentials — no inbound data sync. Rows exist
  // so /api/accounts can show key state; the reconciler derives them (the
  // consumed-once seed migration no longer gates visibility).
  ...[
    ['stripe', 'payments', 'Stripe', 'STRIPE_SECRET_KEY'],
    ['telegram', 'other', 'Telegram', 'TELEGRAM_BOT_TOKEN'],
    ['elevenlabs', 'voice', 'ElevenLabs', 'ELEVENLABS_API_KEY'],
    ['speechify', 'voice', 'Speechify', 'SPEECHIFY_API_KEY'],
    ['figma', 'other', 'Figma', 'FIGMA_PAT'],
    ['brave', 'other', 'Brave Search', 'BRAVE_API_KEY'],
    ['godaddy', 'domains', 'GoDaddy', 'GODADDY_API_KEY'],
    ['slab', 'other', 'Slab', 'SLAB_API_TOKEN'],
    ['iproyal', 'proxy', 'iProyal', 'IPROYAL_PROXY'],
    ['openai', 'other', 'OpenAI', 'OPENAI_API_KEY'],
  ].map(([vendor, type, displayName, keychainKey]) => ({
    id: vendor,
    vendor,
    provider: 'api_key',
    displayName,
    accountShape: { types: [type], idScheme: 'slug' },
    credentials: { keychainKeys: [keychainKey], kind: 'api_key' },
    jobs: [],
    connectJobs: [],
    healthNames: () => [],
    probeNames: vendor === 'openai' ? ['openai'] : [],
    docCounts: {},
    card: vendor === 'openai'
      ? Object.freeze({
        id: 'openai',
        provider: 'openai',
        name: 'OpenAI / ChatGPT',
        section: 'foundation_models',
        substrate_type: 'api_key',
        required: true,
        recovery: 'Paste an OpenAI API key or import a ChatGPT export through the imports folder.',
      })
      : null,
    peopleSeeding: { interchange: 'none', reason: 'no inbound data — service credentials only, no data sync' },
  })),
];

export const INTEGRATIONS = Object.freeze(INTEGRATIONS_LIST.map((d) => Object.freeze(d)));

// ── Readers ──────────────────────────────────────────────────────────────────

export function listIntegrations() {
  return [...INTEGRATIONS];
}

export function getIntegration(id) {
  return INTEGRATIONS.find((d) => d.id === id) || null;
}

/** Flat [{ descriptor, job }] for every declared sync job, in plan order. */
export function syncJobEntries() {
  const entries = [];
  for (const descriptor of INTEGRATIONS) {
    for (const job of descriptor.jobs || []) {
      entries.push({ descriptor, job });
    }
  }
  return entries;
}

/**
 * Derive PROVIDER_JOBS for lib/oauth-sync-queue.js: connect-provider key →
 * job-name list, in each descriptor's historical connectJobs order.
 */
export function buildProviderJobs() {
  const map = {};
  for (const descriptor of INTEGRATIONS) {
    const byProvider = new Map();
    for (const job of descriptor.jobs || []) {
      if (!job.connectProvider) continue;
      const name = job.name || job.kind;
      if (!byProvider.has(job.connectProvider)) byProvider.set(job.connectProvider, []);
      byProvider.get(job.connectProvider).push(name);
    }
    for (const [provider, names] of byProvider) {
      const ordered = descriptor.connectJobs?.length && names.every((n) => descriptor.connectJobs.includes(n))
        ? descriptor.connectJobs.filter((n) => names.includes(n))
        : names;
      map[provider] = [...(map[provider] || []), ...ordered];
    }
  }
  return map;
}

/** health-name prefix → { descriptor, jobType } for every declared job. */
export function healthNamePrefixes() {
  const map = new Map();
  for (const { descriptor, job } of syncJobEntries()) {
    const prefix = job.perAccount ? job.kind : (job.name || job.kind);
    if (!map.has(prefix)) map.set(prefix, { descriptor, jobType: job.jobType });
  }
  return map;
}

/**
 * Doc count for an integration_health row name (`prefix` or `prefix:email`).
 * Replaces the hand-wired dispatch in lib/integrations-queries.js.
 */
export function docCountFor(db, integrationName) {
  const [prefix, email] = String(integrationName || '').split(/:(.+)/);
  for (const descriptor of INTEGRATIONS) {
    const fn = descriptor.docCounts?.[prefix];
    if (fn) return fn(db, email);
  }
  return null;
}

/** Fixed probe names every descriptor owns — drives buildProbes enumeration. */
export function registryProbeNames() {
  const names = [];
  for (const descriptor of INTEGRATIONS) {
    for (const name of descriptor.probeNames || []) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** Unique card contracts declared by descriptors (family cards deduped by id). */
export function registryCards() {
  const seen = new Set();
  const cards = [];
  for (const descriptor of INTEGRATIONS) {
    const card = descriptor.card;
    if (!card || seen.has(card.id)) continue;
    seen.add(card.id);
    cards.push(card);
  }
  return cards;
}

/** Card contract by card id (e.g. 'apple-local' is shared by 7 descriptors). */
export function registryCard(cardId) {
  return registryCards().find((card) => card.id === cardId) || null;
}

/**
 * Integrations declaring a provider-side history backfill — [{ descriptor,
 * spec }]. The supervisor probe enumerates active accounts per entry and
 * seeds one keyed passive job per account (st_fd14cdd4).
 */
export function historyBackfillEntries() {
  return INTEGRATIONS
    .filter((d) => d.historyBackfill)
    .map((d) => ({ descriptor: d, spec: d.historyBackfill }));
}

/**
 * Integrations declaring a provider-history sweep — [{ descriptor, spec }].
 * The supervisor probe seeds one keyed `spec.jobType` job per active
 * `vendor:accountType` account with payload { source: spec.source, account }
 * (st_fd14cdd4 reopen). The contract check asserts every declared source has
 * a runner in scripts/backfill-participants.js — a sweep declared without an
 * executor is red at commit time.
 */
export function historySweepEntries() {
  return INTEGRATIONS
    .filter((d) => d.historySweep)
    .map((d) => ({ descriptor: d, spec: d.historySweep }));
}

/** Descriptors whose accounts rows are deterministic `vendor:type` slugs. */
export function slugAccountDescriptors() {
  return INTEGRATIONS.filter((d) => d.accountShape.idScheme === 'slug');
}

/**
 * Validate every descriptor against the schema. Returns a string[] of
 * problems (empty = valid). Used by the pre-commit contract check so a
 * malformed descriptor cannot ship.
 */
export function validateRegistry() {
  const problems = [];
  const ids = new Set();
  for (const d of INTEGRATIONS) {
    const tag = `descriptor ${d.id || '(missing id)'}`;
    if (!d.id) problems.push(`${tag}: missing id`);
    if (ids.has(d.id)) problems.push(`${tag}: duplicate id`);
    ids.add(d.id);
    if (!d.vendor) problems.push(`${tag}: missing vendor`);
    if (!d.provider) problems.push(`${tag}: missing provider`);
    if (!d.displayName) problems.push(`${tag}: missing displayName`);
    if (!d.accountShape || !Array.isArray(d.accountShape.types) || !ID_SCHEMES.includes(d.accountShape.idScheme)) {
      problems.push(`${tag}: invalid accountShape`);
    }
    if (!d.credentials || !CREDENTIAL_KINDS.includes(d.credentials.kind) || !Array.isArray(d.credentials.keychainKeys)) {
      problems.push(`${tag}: invalid credentials`);
    }
    if (!Array.isArray(d.jobs)) problems.push(`${tag}: jobs must be an array`);
    for (const job of d.jobs || []) {
      if (!job.jobType || !job.kind) problems.push(`${tag}: job missing jobType/kind`);
      if (!job.perAccount && !(job.name || job.kind)) problems.push(`${tag}: fixed job missing name`);
      if (typeof job.priority !== 'number' || typeof job.timeoutMs !== 'number') {
        problems.push(`${tag}: job ${job.kind} missing priority/timeoutMs`);
      }
    }
    if (typeof d.healthNames !== 'function') problems.push(`${tag}: healthNames must be a function`);
    if (d.historyBackfill) {
      const hb = d.historyBackfill;
      if (!hb.jobType || !hb.accountType || typeof hb.priority !== 'number' || typeof hb.timeoutMs !== 'number') {
        problems.push(`${tag}: historyBackfill needs jobType, accountType, priority, timeoutMs`);
      }
    }
    if (d.historySweep) {
      const hs = d.historySweep;
      if (!hs.jobType || !hs.source || !hs.accountType || typeof hs.priority !== 'number' || typeof hs.timeoutMs !== 'number') {
        problems.push(`${tag}: historySweep needs jobType, source, accountType, priority, timeoutMs`);
      }
    }
    if (!d.docCounts || typeof d.docCounts !== 'object') problems.push(`${tag}: docCounts must be an object`);
    const seeding = d.peopleSeeding;
    const interchanges = Array.isArray(seeding?.interchange) ? seeding.interchange : [seeding?.interchange];
    if (!seeding || interchanges.some((i) => !INTERCHANGE_KINDS.includes(i))) {
      problems.push(`${tag}: invalid peopleSeeding.interchange`);
    }
    if (interchanges.includes('none') && !String(seeding?.reason || '').trim()) {
      problems.push(`${tag}: peopleSeeding 'none' requires a reason (AC5/AC6)`);
    }
  }
  return problems;
}
