/**
 * Google Contacts sync — pulls from the People API and stores into google_contacts.
 * Runs on every sync cycle; uses sync tokens for incremental updates.
 */
import crypto from 'node:crypto';
import db, { migrate } from './db.js';
import { getValidAccessToken, listConnectedGoogleAccounts } from './google-oauth.js';
import config from './config.js';

migrate('kv_store_shared_sync_state', () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
});

migrate('027_google_contacts', () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_contacts (
      id            TEXT PRIMARY KEY,
      account_id    TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      display_name  TEXT,
      emails        TEXT DEFAULT '[]',
      phones        TEXT DEFAULT '[]',
      organizations TEXT DEFAULT '[]',
      raw           TEXT,
      synced_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, resource_name)
    );
    CREATE INDEX IF NOT EXISTS idx_google_contacts_account ON google_contacts(account_id);
  `);
});

const PEOPLE_API = 'https://people.googleapis.com/v1/people/me/connections';
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations';

const upsert = db.prepare(`
  INSERT INTO google_contacts (id, account_id, resource_name, display_name, emails, phones, organizations, raw, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(account_id, resource_name) DO UPDATE SET
    display_name  = excluded.display_name,
    emails        = excluded.emails,
    phones        = excluded.phones,
    organizations = excluded.organizations,
    raw           = excluded.raw,
    synced_at     = excluded.synced_at
`);

const getSyncToken = (email) =>
  db.prepare(`SELECT value FROM kv_store WHERE key=?`).get(`contacts:sync_token:${email}`)?.value || null;

const setSyncToken = db.prepare(`
  INSERT INTO kv_store (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function contactId(email, resourceName) {
  return crypto.createHash('sha256').update(`${email}:${resourceName}`).digest('hex').slice(0, 24);
}

export async function syncContactsAccount(email, opts = {}) {
  let token;
  try {
    token = await getValidAccessToken(email);
  } catch (err) {
    console.error(`[contacts] cannot get token for ${email}:`, err.message);
    return { synced: 0, error: err.message };
  }

  const syncToken = opts.full ? null : getSyncToken(email);
  let synced = 0;
  let pageToken = null;
  let nextSyncToken = null;

  try {
    do {
      const params = new URLSearchParams({
        personFields: PERSON_FIELDS,
        pageSize: '1000',
      });
      if (syncToken) params.set('syncToken', syncToken);
      if (pageToken) params.set('pageToken', pageToken);

      const res = await fetch(`${PEOPLE_API}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(config.timeouts.api),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 410 = sync token expired, retry full
        if (res.status === 410 && syncToken) {
          console.info(`[contacts] sync token expired for ${email}, doing full sync`);
          return syncContactsAccount(email, { ...opts, full: true });
        }
        throw new Error(`People API ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = await res.json();
      nextSyncToken = data.nextSyncToken || null;
      pageToken = data.nextPageToken || null;

      const connections = data.connections || [];
      db.transaction(() => {
        for (const person of connections) {
          const name = person.names?.[0]?.displayName || null;
          const emails = (person.emailAddresses || []).map(e => e.value).filter(Boolean);
          const phones = (person.phoneNumbers || []).map(p => p.value).filter(Boolean);
          const orgs = (person.organizations || []).map(o => o.name).filter(Boolean);
          upsert.run(
            contactId(email, person.resourceName),
            email,
            person.resourceName,
            name,
            JSON.stringify(emails),
            JSON.stringify(phones),
            JSON.stringify(orgs),
            JSON.stringify(person),
          );
          synced++;
        }
      })();
    } while (pageToken);

    if (nextSyncToken) {
      setSyncToken.run(`contacts:sync_token:${email}`, nextSyncToken);
    }

    console.info(`[contacts] ${email}: synced=${synced}`);
    return { synced };
  } catch (err) {
    console.error(`[contacts] ${email} failed:`, err.message);
    return { synced, error: err.message };
  }
}

export async function syncAllContactsAccounts(opts = {}) {
  const accounts = listConnectedGoogleAccounts();
  if (!accounts.length) return { synced: 0, accounts: 0 };

  let total = 0;
  const errors = [];
  for (const email of accounts) {
    const r = await syncContactsAccount(email, opts);
    total += r.synced || 0;
    if (r.error) errors.push(`${email}: ${r.error}`);
  }

  return { synced: total, accounts: accounts.length, ...(errors.length ? { errors } : {}) };
}
