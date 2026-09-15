/**
 * Data queries for routes/accounts.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */
import { PAGE_CATALOG_ALLOWLIST } from './launch-integrations.js';

/**
 * Returns the keychain_integrations row for a provider (keychain_key + display_name).
 * @param {import('better-sqlite3').Database} db
 * @param {string} provider
 */
export function getKeychainIntegrationByProvider(db, provider) {
  return db.prepare('SELECT keychain_key, display_name FROM keychain_integrations WHERE provider=?').get(provider);
}

/**
 * Inserts a user-defined integration into keychain_integrations (idempotent).
 * @param {import('better-sqlite3').Database} db
 * @param {string} provider
 * @param {string} displayName
 * @param {string} keychainKey
 */
export function insertUserIntegration(db, provider, displayName, keychainKey) {
  return db.prepare(
    "INSERT OR IGNORE INTO keychain_integrations (provider, display_name, keychain_key, section, source) VALUES (?, ?, ?, 'productivity', 'user')"
  ).run(provider, displayName, keychainKey);
}

/**
 * Returns only the keychain_key for a provider.
 * @param {import('better-sqlite3').Database} db
 * @param {string} provider
 */
export function getKeychainKeyByProvider(db, provider) {
  return db.prepare('SELECT keychain_key FROM keychain_integrations WHERE provider=?').get(provider);
}

/**
 * Returns all integration_health rows used by the Accounts integrations view.
 * @param {import('better-sqlite3').Database} db
 */
export function listIntegrationHealth(db) {
  return db.prepare('SELECT name, status, last_check, last_sync, consecutive_failures, last_error, verified_at FROM integration_health').all();
}

/**
 * Returns the launch-allowlisted keychain_integrations rows for a given section.
 *
 * df_ac0dd301 Fix A (render-layer guard): the page catalog loops render exactly
 * what this returns, so filtering to PAGE_CATALOG_ALLOWLIST here keeps the page
 * showing only the launch short-list REGARDLESS of when the reconciler prune
 * runs. This closes the boot window: the integration-cards primer warms the
 * cache at ~30s but the reconciler prune runs at ~180s, so between them the
 * catalog still holds the dozen dropped rows — without this filter the page
 * would show them for ~3 minutes after every restart. Belt-and-suspenders with
 * the reconciler prune (which keeps the table itself clean in steady state).
 * mistral stays in the allowlist (its row is returned; the open-weight runnable
 * gate handles its visibility); asana_secondary stays returned (the productivity loop
 * skips it — it rides under the Asana card). The `test_catalog_auto_%`
 * exclusion is preserved.
 * @param {import('better-sqlite3').Database} db
 * @param {string} section e.g. 'foundation_models' | 'productivity'
 */
export function listKeychainIntegrationsBySection(db, section) {
  const allow = [...PAGE_CATALOG_ALLOWLIST];
  const placeholders = allow.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM keychain_integrations
      WHERE section=?
        AND provider NOT LIKE 'test_catalog_auto_%'
        AND provider IN (${placeholders})
      ORDER BY display_name`
  ).all(section, ...allow);
}

/**
 * Returns distinct Google account emails.
 * @param {import('better-sqlite3').Database} db
 */
export function getGoogleAccountEmails(db) {
  return db.prepare(`SELECT DISTINCT email FROM accounts WHERE vendor='google'`).all();
}

/**
 * Returns all normalized Google account product rows for one email.
 * @param {import('better-sqlite3').Database} db
 * @param {string} email
 */
export function getGoogleAccountRows(db, email) {
  try {
    return db.prepare(`
      SELECT id, type, status, last_error, synced_at, metadata
        FROM accounts
       WHERE vendor='google' AND email=?
    `).all(email);
  } catch {
    return [];
  }
}

/**
 * Returns distinct Microsoft account emails.
 * @param {import('better-sqlite3').Database} db
 */
export function getMicrosoftAccountEmails(db) {
  return db.prepare(`
    SELECT DISTINCT email
      FROM accounts
     WHERE vendor='microsoft'
       AND status IN ('active', 'connected')
  `).all();
}

/**
 * Returns the strongest (most-degraded) account status for an email across
 * every account row that vendor has for that email. Used by the accounts
 * surface to render a Reconnect CTA on `needs_reauth` and a connected
 * indicator on `active`. Status precedence (worst first):
 *   needs_reauth > error > active/connected
 * Story st_d142f701 AC2.
 * @param {import('better-sqlite3').Database} db
 * @param {string} vendor - 'google' | 'microsoft'
 * @param {string} email
 * @returns {string} status — 'needs_reauth' | 'error' | 'active' | 'unknown'
 */
export function getAccountStatusByEmail(db, vendor, email) {
  try {
    const rows = db.prepare(
      `SELECT status FROM accounts WHERE vendor=? AND email=?`
    ).all(vendor, email);
    if (!rows.length) return 'unknown';
    const statuses = new Set(rows.map(r => r.status));
    if (statuses.has('needs_reauth')) return 'needs_reauth';
    if (statuses.has('error')) return 'error';
    if (statuses.has('active')) return 'active';
    if (statuses.has('connected')) return 'active';
    return rows[0].status || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Returns the email count for a Google email account.
 * @param {import('better-sqlite3').Database} db
 * @param {string} email
 * @returns {number}
 */
export function getGoogleEmailCount(db, email) {
  try {
    const acct = db.prepare(`SELECT id FROM accounts WHERE vendor='google' AND type='email' AND email=?`).get(email);
    return acct ? db.prepare(`SELECT COUNT(*) AS c FROM emails WHERE account_id=?`).get(acct.id)?.c || 0 : 0;
  } catch { return 0; }
}

/**
 * Returns the calendar event count for a Google calendar account.
 * @param {import('better-sqlite3').Database} db
 * @param {string} email
 * @returns {number}
 */
export function getGoogleCalendarCount(db, email) {
  try {
    return db.prepare(`
      SELECT COUNT(*) AS c
        FROM calendar_events
       WHERE account_id IN (
         SELECT id FROM accounts
          WHERE vendor='google'
            AND email=?
            AND type IN ('calendar', 'email')
       )
    `).get(email)?.c || 0;
  } catch { return 0; }
}

/**
 * Returns the drive file count for a Google drive account.
 * @param {import('better-sqlite3').Database} db
 * @param {string} email
 * @returns {number}
 */
export function getGoogleDriveCount(db, email) {
  try {
    const acct = db.prepare(`SELECT id FROM accounts WHERE vendor='google' AND type='drive' AND email=?`).get(email);
    return acct ? db.prepare(`SELECT COUNT(*) AS c FROM drive_files WHERE account_id=?`).get(acct.id)?.c || 0 : 0;
  } catch { return 0; }
}

/**
 * Returns the Google Photos metadata count for an account email.
 * @param {import('better-sqlite3').Database} db
 * @param {string} email
 * @returns {number}
 */
export function getGooglePhotosCount(db, email) {
  try {
    const acct = db.prepare(`SELECT id FROM accounts WHERE vendor='google' AND type='email' AND email=?`).get(email);
    return acct ? db.prepare(`SELECT COUNT(*) AS c FROM photos WHERE account_id=?`).get(acct.id)?.c || 0 : 0;
  } catch { return 0; }
}

/**
 * Returns the Google contacts count for an email (account_id = email in this schema).
 * @param {import('better-sqlite3').Database} db
 * @param {string} email
 * @returns {number}
 */
export function getGoogleContactsCount(db, email) {
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM google_contacts WHERE account_id=?`).get(email)?.c || 0;
  } catch { return 0; }
}

/**
 * Returns the Microsoft email count for an account email.
 * @param {import('better-sqlite3').Database} db
 * @param {string} email
 * @returns {number}
 */
export function getMicrosoftEmailCount(db, email) {
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM emails WHERE account_id IN (SELECT id FROM accounts WHERE vendor='microsoft' AND email=?)`).get(email)?.c || 0;
  } catch { return 0; }
}

/**
 * Returns the Microsoft calendar event count for an account email.
 * @param {import('better-sqlite3').Database} db
 * @param {string} email
 * @returns {number}
 */
export function getMicrosoftCalendarCount(db, email) {
  try {
    const acct = db.prepare(`SELECT id FROM accounts WHERE vendor='microsoft' AND type='calendar' AND email=?`).get(email);
    return acct ? db.prepare(`SELECT COUNT(*) AS c FROM calendar_events WHERE source='graph' AND account_id=?`).get(acct.id)?.c || 0 : 0;
  } catch { return 0; }
}

/**
 * Returns the iMessage count.
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getImessageCount(db) {
  try { return db.prepare(`SELECT COUNT(*) AS c FROM imessages`).get()?.c || 0; } catch { return 0; }
}

/**
 * Returns the google_contacts total count.
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getGoogleContactsTotal(db) {
  try { return db.prepare(`SELECT COUNT(*) AS c FROM google_contacts`).get()?.c || 0; } catch { return 0; }
}

/**
 * Returns the contacts table count (fallback for non-Google contacts).
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getContactsCount(db) {
  // Apple Contacts are resolved into people (primary_source='contacts').
  // There is no standalone contacts table on this product path — counting
  // that missing table painted 0 on the Apple card while thousands of
  // AddressBook people were already in memory.
  try {
    return db.prepare(`
      SELECT COUNT(*) AS c FROM people WHERE primary_source = 'contacts'
    `).get()?.c || 0;
  } catch {
    try { return db.prepare(`SELECT COUNT(*) AS c FROM contacts`).get()?.c || 0; } catch { return 0; }
  }
}

/**
 * Returns locally imported Apple Photos metadata rows.
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getApplePhotosCount(db) {
  try { return db.prepare(`SELECT COUNT(*) AS c FROM photos WHERE account_id LIKE 'apple%' OR account_id='local'`).get()?.c || 0; } catch { return 0; }
}

/**
 * Returns locally imported Apple Calendar rows when present.
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getAppleCalendarCount(db) {
  try {
    return db.prepare(`
      SELECT COUNT(*) AS c FROM calendar_events
       WHERE source IN ('apple-local', 'apple', 'local')
    `).get()?.c || 0;
  } catch { return 0; }
}

/**
 * Returns locally imported Apple Mail envelopes.
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getAppleMailCount(db) {
  try { return db.prepare(`SELECT COUNT(*) AS c FROM emails WHERE id LIKE 'apple-mail:%'`).get()?.c || 0; } catch { return 0; }
}

/**
 * Returns locally imported Apple call-history rows.
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getAppleCallsCount(db) {
  try { return db.prepare(`SELECT COUNT(*) AS c FROM calls`).get()?.c || 0; } catch { return 0; }
}

/**
 * Returns locally imported Apple Notes rows.
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getAppleNotesCount(db) {
  try { return db.prepare(`SELECT COUNT(*) AS c FROM notes`).get()?.c || 0; } catch { return 0; }
}

/**
 * Returns the Granola transcript count.
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getGranolaCount(db) {
  try { return db.prepare(`SELECT COUNT(*) AS c FROM transcripts WHERE source='granola'`).get()?.c || 0; } catch { return 0; }
}

/**
 * Returns the Notion chunk count.
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getNotionChunkCount(db) {
  try { return db.prepare(`SELECT COUNT(*) AS c FROM chunks WHERE source_type='notion'`).get()?.c || 0; } catch { return 0; }
}

/**
 * Returns Asana task/project chunks that are available to RAG.
 * Provider-aware counts keep separate user tokens (for example Primary vs Secondary)
 * from flattening into one misleading total on the Accounts page.
 * @param {import('better-sqlite3').Database} db
 * @param {'asana'|'asana_secondary'|null} [provider]
 * @returns {number}
 */
export function getAsanaChunkCount(db, provider = null) {
  const normalizedProvider = provider === 'asana_secondary' ? 'asana_secondary' : provider === 'asana' ? 'asana' : null;
  try {
    if (!normalizedProvider) {
      return db.prepare(`
        SELECT COUNT(*) AS c
          FROM (
            SELECT source_id,
                   CASE
                     WHEN metadata IS NOT NULL AND json_valid(metadata)
                     THEN json_extract(metadata, '$.provider')
                     ELSE NULL
                   END AS metadata_provider
              FROM chunks
             WHERE source_type='asana'
          )
         WHERE COALESCE(metadata_provider, CASE WHEN source_id LIKE 'asana_secondary:%' THEN 'asana_secondary' ELSE 'asana' END)
               IN ('asana', 'asana_secondary')
      `).get()?.c || 0;
    }
    return db.prepare(`
      SELECT COUNT(*) AS c
        FROM (
          SELECT source_id,
                 CASE
                   WHEN metadata IS NOT NULL AND json_valid(metadata)
                   THEN json_extract(metadata, '$.provider')
                   ELSE NULL
                 END AS metadata_provider
            FROM chunks
           WHERE source_type='asana'
        )
       WHERE metadata_provider = ?
          OR (metadata_provider IS NULL AND source_id LIKE ?)
    `).get(normalizedProvider, `${normalizedProvider}:%`)?.c || 0;
  } catch {
    return 0;
  }
}

/**
 * Returns all accounts ordered by created_at DESC.
 * @param {import('better-sqlite3').Database} db
 */
export function listAllAccounts(db) {
  return db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
}

/**
 * Returns the accounts GET /api/accounts may advertise to consumers
 * (df_355651ca AC4 / Key decision 3).
 *
 * WHY the filter: the integration-context hook renders every api_key row
 * unconditionally into agent sessions, so a row whose keychain credential is
 * missing (status 'needs_credential', flipped by the reconciler's presence
 * verification) would advertise a phantom "at the ready" token. OAuth rows
 * are structurally unfilterable here — a failing Google/Microsoft account
 * must stay visible (never-hide, annotate health).
 * @param {import('better-sqlite3').Database} db
 */
export function listAdvertisableAccounts(db) {
  return db.prepare(`
    SELECT * FROM accounts
     WHERE NOT (provider = 'api_key' AND status = 'needs_credential')
     ORDER BY created_at DESC
  `).all();
}

// Shared worst-first status aggregation — same precedence as
// getAccountStatusByEmail (needs_reauth > error > active/connected).
function worstAccountStatus(statuses) {
  if (!statuses.length) return 'unknown';
  const set = new Set(statuses);
  if (set.has('needs_reauth')) return 'needs_reauth';
  if (set.has('error')) return 'error';
  if (set.has('active') || set.has('connected')) return 'active';
  return statuses[0] || 'unknown';
}

function listVendorAccountSummaries(db, sql) {
  try {
    const byEmail = new Map();
    for (const row of db.prepare(sql).all()) {
      const email = String(row.email).trim().toLowerCase();
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(row.status);
    }
    return [...byEmail.entries()].map(([email, statuses]) => ({
      email,
      account_status: worstAccountStatus(statuses),
    }));
  } catch {
    return [];
  }
}

/**
 * Cheap per-email Google account summaries for the integration-cards
 * FALLBACK payload (df_355651ca Key decision 5). No status filter — a
 * needs_reauth account stays visible and annotated (AC5, never-hide). No
 * COUNT(*) against big tables — the accounts table is ≤50 rows.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{ email: string, account_status: string }>}
 */
export function listGoogleAccountSummaries(db) {
  return listVendorAccountSummaries(db, `
    SELECT email, status FROM accounts
     WHERE vendor='google' AND email IS NOT NULL AND email != ''
  `);
}

/**
 * Cheap per-email Microsoft account summaries — same contract as
 * listGoogleAccountSummaries. Typed rows only (email/calendar), no status
 * filter (never-hide).
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{ email: string, account_status: string }>}
 */
export function listMicrosoftAccountSummaries(db) {
  return listVendorAccountSummaries(db, `
    SELECT email, status FROM accounts
     WHERE vendor='microsoft' AND type IN ('email','calendar')
       AND email IS NOT NULL AND email != ''
  `);
}

/**
 * Inserts a page-catalog row for a keychain-discovered or registry-derived
 * integration (df_355651ca AC3). Idempotent: skips when any catalog row
 * already carries this keychain_key (a second provider name for the same
 * credential would render a duplicate card — e.g. GOOGLE_AI_API_KEY is
 * already catalogued under provider 'google') or when the provider row
 * exists; provider is the table PRIMARY KEY as the final guard.
 * @param {import('better-sqlite3').Database} db
 * @param {string} provider
 * @param {string} displayName
 * @param {string} keychainKey full prefixed service name (robotdojo-*)
 * @param {{ section?: string, source?: string }} [opts]
 * @returns {{ created: boolean }}
 */
export function upsertDiscoveredIntegration(db, provider, displayName, keychainKey, { section = 'productivity', source = 'keychain' } = {}) {
  try {
    const existing = db.prepare(
      'SELECT provider FROM keychain_integrations WHERE keychain_key=? OR provider=?'
    ).get(keychainKey, provider);
    if (existing) return { created: false };
    const result = db.prepare(`
      INSERT OR IGNORE INTO keychain_integrations (provider, display_name, keychain_key, section, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(provider, displayName, keychainKey, section, source);
    return { created: result.changes > 0 };
  } catch {
    return { created: false };
  }
}

/**
 * Deletes every keychain_integrations (page-catalog) row whose provider is not
 * in the launch allowlist, returning the deleted count (df_ac0dd301 Fix A).
 *
 * WHY level-triggered, not a one-shot migration: the reconciler ADD passes run
 * on every converge (boot + 15-min cadence), so a bare DELETE is re-added within
 * one cadence. This prune runs on the same cadence as the ADD passes, so the
 * catalog is always exactly the launch set — "present = on the integrations
 * page." It touches ONLY the page catalog; the accounts (sessions) table is
 * never pruned, so agent-session visibility stays broad.
 * @param {import('better-sqlite3').Database} db
 * @param {Set<string>|Iterable<string>} allowlist provider values to keep
 * @returns {number} rows deleted
 */
export function pruneKeychainIntegrationsToAllowlist(db, allowlist) {
  const providers = [...allowlist];
  if (providers.length === 0) return 0;
  const placeholders = providers.map(() => '?').join(',');
  try {
    const result = db.prepare(
      `DELETE FROM keychain_integrations WHERE provider NOT IN (${placeholders})`
    ).run(...providers);
    return result.changes || 0;
  } catch {
    return 0;
  }
}

/**
 * Returns the installed Ollama model names captured by the background health
 * probe (df_ac0dd301 Fix C). The kv_store 'ollama:installed_models' entry is a
 * JSON array of model names, refreshed on the 15-min health cadence — the page
 * reads this cached signal instead of probing Ollama while rendering.
 * @param {import('better-sqlite3').Database} db
 * @returns {string[]} model names, or [] when unset/unparseable
 */
export function getOllamaInstalledModels(db) {
  try {
    const row = db.prepare("SELECT value FROM kv_store WHERE key='ollama:installed_models'").get();
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((m) => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

// Open-weight model families that run locally through Ollama (df_ac0dd301 Fix
// C). Mirrors the Ollama chat bucket in routes/accounts.js; today only 'mistral'
// is a catalog row, but llama/qwen join the runnable-gate for free.
export const OPEN_WEIGHT_MODEL_FAMILIES = new Set(['mistral', 'llama', 'qwen']);

/**
 * True iff an open-weight model is actually runnable right now: Ollama is
 * reachable AND a matching model family is in the cached installed-model list
 * (df_ac0dd301 Fix C / AC5). Reachability is CO-REQUIRED so a stale model list
 * can never show a green card while Ollama is down (the false-green AC5 forbids).
 * @param {import('better-sqlite3').Database} db
 * @param {string} provider open-weight provider/family (e.g. 'mistral')
 * @param {boolean} ollamaReachable whether the Ollama host probed ok this cycle
 * @returns {boolean}
 */
export function isOpenWeightModelRunnable(db, provider, ollamaReachable) {
  if (!ollamaReachable) return false;
  const family = String(provider || '').toLowerCase();
  if (!family) return false;
  return getOllamaInstalledModels(db).some((m) => String(m).toLowerCase().includes(family));
}

/**
 * Flips credential-presence status on api_key accounts rows for one keychain
 * service (df_355651ca AC4). Used by the reconciler's presence verification
 * (15-min backstop) and inline by the key save/delete routes (immediacy).
 *
 * WHY the asymmetry: 'active' only restores rows currently flagged
 * 'needs_credential' — a probe-written 'error' status is real health signal
 * the presence pass must not clobber. 'needs_credential' applies to every
 * api_key row on the key regardless of prior status — the credential is gone,
 * any other status is stale.
 * @param {import('better-sqlite3').Database} db
 * @param {string} keychainKey full prefixed service name (robotdojo-*)
 * @param {'active'|'needs_credential'} status
 * @returns {{ changes: number }}
 */
export function setAccountCredentialStatus(db, keychainKey, status) {
  try {
    if (status === 'active') {
      return db.prepare(`
        UPDATE accounts SET status='active', updated_at=datetime('now')
         WHERE provider='api_key' AND keychain_key=? AND status='needs_credential'
      `).run(keychainKey);
    }
    return db.prepare(`
      UPDATE accounts SET status=?, updated_at=datetime('now')
       WHERE provider='api_key' AND keychain_key=?
    `).run(status, keychainKey);
  } catch {
    return { changes: 0 };
  }
}

/**
 * Returns every users.id — the integration-cards boot primer seeds one cache
 * entry per user key (df_355651ca Key decision 4b). Single-operator today
 * (one row); if the cards payload ever becomes per-user, the primer is the
 * one function to revisit.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<number|string>}
 */
export function listUserIds(db) {
  try {
    return db.prepare('SELECT id FROM users').all().map((row) => row.id);
  } catch {
    return [];
  }
}

/**
 * Returns the latest computed_at timestamp from imports_snapshot.
 * @param {import('better-sqlite3').Database} db
 */
export function getImportsSnapshotFreshness(db) {
  return db.prepare('SELECT MAX(computed_at) as latest FROM imports_snapshot').get();
}

/**
 * Returns all rows from imports_snapshot ordered by import_type + account_key.
 * @param {import('better-sqlite3').Database} db
 */
export function listImportsSnapshot(db) {
  return db.prepare('SELECT * FROM imports_snapshot ORDER BY import_type, account_key').all();
}

function importedEmailSnapshotByAccount(snapshotRows = []) {
  const byAccount = new Map();
  for (const row of snapshotRows || []) {
    if (row.import_type !== 'email' || row.vendor !== 'imports') continue;
    const keys = [row.account_id, row.account_key].filter(Boolean);
    for (const key of keys) byAccount.set(key, row);
  }
  return byAccount;
}

function importedEmailSnapshotStats(snapshot) {
  if (!snapshot) return null;
  return {
    email_count: Number(snapshot.item_count) || 0,
    earliest_at: snapshot.earliest_at || null,
    latest_at: snapshot.latest_at || null,
    last_sync: snapshot.computed_at || snapshot.latest_at || null,
  };
}

function liveImportedEmailStats(row = {}) {
  return {
    email_count: Number(row.email_count) || 0,
    earliest_at: row.earliest_at || null,
    latest_at: row.latest_at || null,
    last_sync: row.last_sync || row.latest_at || null,
  };
}

function mergeImportedEmailStats(snapshot, liveRow) {
  const snapshotStats = importedEmailSnapshotStats(snapshot);
  const liveStats = liveImportedEmailStats(liveRow);
  if (!snapshotStats) return liveStats;
  if (liveStats.email_count > snapshotStats.email_count) {
    return {
      ...liveStats,
      last_sync: liveStats.last_sync || snapshotStats.last_sync,
    };
  }
  return snapshotStats;
}

/**
 * Returns recent drop-folder rows for the imports history surface.
 * @param {import('better-sqlite3').Database} db
 */
export function listDropFolderImportRows(db) {
  return db.prepare(`
    SELECT path, original_name, status, topic_t1, topic_t2, doc_type,
           size_bytes, processed_at, error_message
    FROM drop_folder_files
    ORDER BY processed_at DESC
    LIMIT 200
  `).all();
}

/**
 * Returns accounts that have a keychain_key set (for secrets-status endpoint).
 * @param {import('better-sqlite3').Database} db
 */
export function listAccountsWithKeychainKey(db) {
  return db.prepare('SELECT vendor, keychain_key, display_name FROM accounts WHERE keychain_key IS NOT NULL').all();
}

/**
 * Returns doc count from integration_health entry name + actual data tables.
 * Used by the healthDocCount helper in integration-cards.
 * @param {import('better-sqlite3').Database} db
 * @param {string} name - integration name (e.g. "gmail:email@domain")
 * @param {string} [email] - already-split email portion
 * @returns {number}
 */
export function getHealthDocCount(db, name, email) {
  try {
    const [type] = name.split(/:(.+)/);
    if (type === 'gmail') {
      const acct = db.prepare(`SELECT id FROM accounts WHERE vendor='google' AND type='email' AND email=?`).get(email);
      if (acct) return db.prepare(`SELECT COUNT(*) AS c FROM emails WHERE account_id=?`).get(acct.id)?.c || 0;
    } else if (type === 'calendar') {
      return getGoogleCalendarCount(db, email);
    } else if (type === 'drive') {
      const acct = db.prepare(`SELECT id FROM accounts WHERE vendor='google' AND type='drive' AND email=?`).get(email);
      if (acct) return db.prepare(`SELECT COUNT(*) AS c FROM drive_files WHERE account_id=?`).get(acct.id)?.c || 0;
    } else if (type === 'contacts') {
      return db.prepare(`SELECT COUNT(*) AS c FROM google_contacts WHERE account_id=?`).get(email)?.c || 0;
    } else if (type === 'microsoft-email') {
      return db.prepare(`SELECT COUNT(*) AS c FROM emails WHERE account_id IN (SELECT id FROM accounts WHERE vendor='microsoft' AND email=?)`).get(email)?.c || 0;
    } else if (type === 'microsoft-calendar') {
      return getMicrosoftCalendarCount(db, email);
    }
  } catch { /* table may not exist */ }
  return 0;
}

/**
 * Returns a Map<provider, usd_spend> aggregating token_usage cost_cents
 * over the trailing 30 days, bucketed by foundation-model prefix.
 * Story st_d9fc573b — AC 14.
 *
 * Model-prefix → provider mapping:
 *   claude-*    → anthropic
 *   gpt-*, o1-*, o3-* → openai
 *   gemini-*    → google
 *   grok-*      → xai
 *   mistral-*   → mistral
 *
 * Anything else falls into 'other' and is not surfaced on integration cards
 * (foundation-model rows only carry numeric spend; other rows stay null).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Map<string, number>} provider → USD (e.g. 'anthropic' → 12.45)
 */
export function getSpend30dByProvider(db) {
  try {
    const rows = db.prepare(`
      SELECT model, SUM(cost_cents) AS cents
      FROM token_usage
      WHERE created_at > datetime('now', '-30 days')
      GROUP BY model
    `).all();
    const byProvider = new Map();
    for (const r of rows) {
      const model = String(r.model || '').toLowerCase();
      let provider = null;
      if (model.startsWith('claude')) provider = 'anthropic';
      else if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) provider = 'openai';
      else if (model.startsWith('gemini')) provider = 'google';
      else if (model.startsWith('grok')) provider = 'xai';
      else if (model.startsWith('mistral')) provider = 'mistral';
      if (!provider) continue;
      const usd = (Number(r.cents) || 0) / 100;
      byProvider.set(provider, (byProvider.get(provider) || 0) + usd);
    }
    return byProvider;
  } catch {
    return new Map();
  }
}

/**
 * Returns source-labeled email archive accounts created by the local Imports provider.
 * These rows are user-owned archive sources, not OAuth mailboxes.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Array}
 */
function fastImportedEmailStats(db, accountId) {
  const runCount = (sql, params = []) => {
    try { return Number(db.prepare(sql).get(...params)?.c) || 0; } catch { return 0; }
  };
  const runOne = (sql, params = []) => {
    try { return db.prepare(sql).get(...params) || {}; } catch { return {}; }
  };
  const direct = runOne(`
    SELECT COUNT(*) AS c, MIN(received_at) AS earliest_at, MAX(received_at) AS latest_at, MAX(synced_at) AS last_sync
      FROM emails INDEXED BY idx_emails_account_received
     WHERE account_id = ?
  `, [accountId]);
  const linkedCount = runCount(`
    SELECT COUNT(*) AS c
      FROM email_import_sources INDEXED BY idx_email_import_sources_account_id
     WHERE account_id = ?
  `, [accountId]);
  return {
    email_count: Math.max(Number(direct.c) || 0, linkedCount),
    earliest_at: direct.earliest_at || null,
    latest_at: direct.latest_at || null,
    last_sync: direct.last_sync || null,
  };
}

export function listImportedEmailAccounts(db, options = {}) {
  try {
    const snapshotRows = Array.isArray(options.snapshotRows) ? options.snapshotRows : null;
    const live = options.live !== false;
    const liveFallback = Boolean(options.liveFallback || options.allowLiveFallback);
    const snapshotByAccount = importedEmailSnapshotByAccount(snapshotRows || (live ? listImportsSnapshot(db) : []));
    const accounts = db.prepare(`
      SELECT
        id,
        email AS account_key,
        COALESCE(NULLIF(display_name, ''), email, 'Imported Email') AS display_name
      FROM accounts
      WHERE vendor = 'imports'
        AND type = 'email'
      ORDER BY display_name COLLATE NOCASE
    `).all();

    if (!live) {
      return accounts.map((account) => {
        const snapshot = snapshotByAccount.get(account.id) || snapshotByAccount.get(account.account_key);
        if (snapshot) {
          return {
            ...account,
            email_count: Number(snapshot.item_count) || 0,
            earliest_at: snapshot.earliest_at || null,
            latest_at: snapshot.latest_at || null,
            last_sync: snapshot.computed_at || snapshot.latest_at || null,
          };
        }
        const liveStats = liveFallback
          ? fastImportedEmailStats(db, account.id)
          : { email_count: 0, earliest_at: null, latest_at: null, last_sync: null };
        return {
          ...account,
          ...liveStats,
        };
      });
    }

    const stats = db.prepare(`
      SELECT
        COUNT(DISTINCT email_id) AS email_count,
        MIN(received_at) AS earliest_at,
        MAX(received_at) AS latest_at,
        MAX(synced_at) AS last_sync
      FROM (
        SELECT id AS email_id, received_at, synced_at
        FROM emails INDEXED BY idx_emails_account_received
        WHERE account_id = ?
        UNION ALL
        SELECT e.id AS email_id, e.received_at, e.synced_at
        FROM email_import_sources s INDEXED BY idx_email_import_sources_account_id
        JOIN emails e ON e.id = s.email_id
        WHERE s.account_id = ?
      )
    `);

    return accounts.map((account) => {
      const snapshot = snapshotByAccount.get(account.id) || snapshotByAccount.get(account.account_key);
      const liveStats = stats.get(account.id, account.id);
      return {
        ...account,
        ...mergeImportedEmailStats(snapshot, liveStats),
      };
    });
  } catch {
    return [];
  }
}

function safeCount(db, sql, params = []) {
  try { return db.prepare(sql).get(...params)?.c || 0; } catch { return 0; }
}

export function getEmbeddingPipelineSnapshot(db) {
  const total = safeCount(db, `SELECT COUNT(*) AS c FROM chunks`);
  const embedded = safeCount(db, `SELECT COUNT(*) AS c FROM chunks WHERE embedded = 1`);
  const pending = safeCount(db, `
    SELECT COUNT(*) AS c
      FROM chunks
     WHERE embedded = 0
       AND skip_embed = 0
  `);
  const skipped = safeCount(db, `SELECT COUNT(*) AS c FROM chunks WHERE skip_embed = 1`);
  let latestEmbeddedAt = null;
  try {
    latestEmbeddedAt = db.prepare(`
      SELECT MAX(embedded_at) AS ts
        FROM chunks
       WHERE embedded = 1
         AND embedded_at IS NOT NULL
    `).get()?.ts || null;
  } catch {
    latestEmbeddedAt = null;
  }
  return {
    total,
    embedded,
    pending,
    skipped,
    latestEmbeddedAt,
    state: pending > 0 ? 'partial' : 'ready',
  };
}

export function getRobotDojoCountSnapshot(db) {
  const conversations = safeCount(db, `SELECT COUNT(*) AS c FROM conversations WHERE deleted_at IS NULL`);
  const transcripts = safeCount(db, `SELECT COUNT(*) AS c FROM transcripts`);
  const workbenchItems = safeCount(db, `SELECT COUNT(*) AS c FROM workbench_items`);
  const contextChunks = safeCount(db, `SELECT COUNT(*) AS c FROM chunks WHERE source_type IN ('context','topic_context','identity','workbench')`);
  const generatedArtifacts = safeCount(db, `SELECT COUNT(*) AS c FROM chunks WHERE source_type IN ('conversation','artifact','report','app_output')`);
  const chat = conversations + transcripts;
  const other = workbenchItems + contextChunks + generatedArtifacts;
  return {
    updatedAt: new Date().toISOString(),
    rows: [
      {
        provider: 'robotdojo-chat',
        label: 'Chat',
        type: 'First-party app',
        counts: { chat, email: 0, calendar: 0, sms: 0, other },
        details: { conversations, transcripts, workbenchItems, contextChunks, generatedArtifacts },
        state: 'ready',
      },
    ],
  };
}

/**
 * Upserts the integration_health row for a named integration. status 'ok'
 * refreshes last_sync and zeroes the failure counter; any other status keeps
 * the prior last_sync and marks a single failure. Callers wrap in try/catch for
 * graceful degradation.
 * @param {import('better-sqlite3').Database} db
 * @param {string} name
 * @param {string} status
 * @param {string|null} error
 */
export function upsertIntegrationHealth(db, name, status, error = null) {
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT INTO integration_health
      (name, status, last_check, last_sync, consecutive_failures, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      status = excluded.status,
      last_check = excluded.last_check,
      last_sync = CASE WHEN excluded.status = 'ok' THEN excluded.last_sync ELSE integration_health.last_sync END,
      consecutive_failures = excluded.consecutive_failures,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run(name, status, now, status === 'ok' ? now : null, status === 'ok' ? 0 : 1, error, now);
}

/**
 * Counts non-excluded health data points across the given source list.
 * An empty sources array yields an invalid `IN ()` clause; callers wrap in
 * try/catch and treat the throw as a zero count.
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} sources
 * @returns {number}
 */
export function countHealthDataPoints(db, sources) {
  const placeholders = sources.map(() => '?').join(',');
  return db.prepare(`
    SELECT COUNT(*) AS c
      FROM health_data_points
     WHERE excluded = 0
       AND source IN (${placeholders})
  `).get(...sources)?.c || 0;
}

/**
 * Counts health notes for a single source.
 * @param {import('better-sqlite3').Database} db
 * @param {string} source
 * @returns {number}
 */
export function countHealthNotes(db, source) {
  return db.prepare(`SELECT COUNT(*) AS c FROM health_notes WHERE source=?`).get(source)?.c || 0;
}

/**
 * Returns the most recent created_at across non-excluded health data points for
 * the given sources, or null.
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} sources
 * @returns {string|null}
 */
export function latestHealthDataPointTimestamp(db, sources) {
  const placeholders = sources.map(() => '?').join(',');
  return db.prepare(`
    SELECT MAX(created_at) AS ts
      FROM health_data_points
     WHERE excluded = 0
       AND source IN (${placeholders})
  `).get(...sources)?.ts || null;
}

/**
 * Counts distinct ingested document paths in health_ingestion_log for the given
 * sources (excluding null/empty file paths).
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} sources
 * @returns {number}
 */
export function countDistinctHealthIngestionDocs(db, sources) {
  const placeholders = sources.map(() => '?').join(',');
  return db.prepare(`
    SELECT COUNT(DISTINCT file_path) AS c
      FROM health_ingestion_log
     WHERE source IN (${placeholders})
       AND file_path IS NOT NULL
       AND file_path != ''
  `).get(...sources)?.c || 0;
}

/**
 * Returns the most recent created_at across health_ingestion_log for the given
 * sources, or null.
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} sources
 * @returns {string|null}
 */
export function maxHealthIngestionTimestamp(db, sources) {
  const placeholders = sources.map(() => '?').join(',');
  return db.prepare(`
    SELECT MAX(created_at) AS ts
      FROM health_ingestion_log
     WHERE source IN (${placeholders})
  `).get(...sources)?.ts || null;
}
