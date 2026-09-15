/**
 * Microsoft Graph calendar sync.
 * Stores into the same `calendar_events` table as Google Calendar sync.
 * Uses INSERT OR REPLACE — Graph events mutate in place (same id).
 */
import db, { migrate } from './db.js';
import { getValidMicrosoftAccessToken, listConnectedMicrosoftAccounts } from './microsoft-oauth.js';
import { seedCalendarAttendees } from './people-seed.js';
import config from './config.js';

const GRAPH_USERS = 'https://graph.microsoft.com/v1.0/users';

// Ensure calendar_events exists — mirrors the migration in the old dojo calendar module.
// Safe no-op on existing installs where the table was created by import-from-dojo.
migrate('calendar_001_create_events', (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id          TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL DEFAULT 'primary',
      summary     TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      location    TEXT NOT NULL DEFAULT '',
      start_time  TEXT NOT NULL,
      end_time    TEXT NOT NULL,
      all_day     INTEGER NOT NULL DEFAULT 0,
      attendees   TEXT NOT NULL DEFAULT '[]',
      organizer   TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'confirmed',
      html_link   TEXT NOT NULL DEFAULT '',
      synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events(start_time)');
});

migrate('calendar_002_account_id', (db) => {
  const cols = db.prepare('PRAGMA table_info(calendar_events)').all().map(c => c.name);
  if (!cols.includes('account_id')) {
    db.exec('ALTER TABLE calendar_events ADD COLUMN account_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_calendar_account ON calendar_events(account_id)');
  }
});

migrate('calendar_003_source', (db) => {
  const cols = db.prepare('PRAGMA table_info(calendar_events)').all().map(c => c.name);
  if (!cols.includes('source')) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN source TEXT NOT NULL DEFAULT 'api'");
  }
});

const upsertEvent = db.prepare(`
  INSERT INTO calendar_events
    (id, calendar_id, summary, description, location, start_time, end_time,
     all_day, attendees, organizer, status, html_link, account_id, ical_uid, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    summary     = excluded.summary,
    description = excluded.description,
    location    = excluded.location,
    start_time  = excluded.start_time,
    end_time    = excluded.end_time,
    all_day     = excluded.all_day,
    attendees   = excluded.attendees,
    organizer   = excluded.organizer,
    status      = excluded.status,
    html_link   = excluded.html_link,
    account_id  = COALESCE(excluded.account_id, account_id),
    ical_uid    = COALESCE(excluded.ical_uid, ical_uid),
    source      = excluded.source,
    synced_at   = datetime('now')
`);

// ── Graph helpers ─────────────────────────────────────────────────────────────

async function graphFetch(url, accessToken) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(config.timeouts.api),
  });

  if (res.status === 401) throw new Error('401 Unauthorized — token may be expired');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph API error ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

function parseDateTime(dt) {
  if (!dt) return null;
  // Graph dateTime is in the calendar's local time — normalize to ISO UTC
  if (dt.dateTime) return new Date(dt.dateTime + (dt.timeZone && dt.timeZone !== 'UTC' ? '' : 'Z')).toISOString();
  if (dt.date) return `${dt.date}T00:00:00.000Z`;
  return null;
}

function parseAttendees(attendees) {
  if (!Array.isArray(attendees)) return [];
  return attendees.map(a => ({
    email: a.emailAddress?.address?.toLowerCase() || '',
    name: a.emailAddress?.name || '',
    status: a.status?.response || 'none',
  })).filter(a => a.email);
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export async function syncGraphCalendarAccount(email, opts = {}) {
  const { maxEvents = 1000 } = opts;

  const acctRow = db.prepare(`SELECT id FROM accounts WHERE vendor='microsoft' AND type='calendar' AND email=?`).get(email);
  const accountId = acctRow?.id || email;

  let accessToken;
  try {
    accessToken = await getValidMicrosoftAccessToken(email);
  } catch (err) {
    console.error(`[graph-calendar] cannot get token for ${email}:`, err.message);
    db.prepare(`UPDATE accounts SET last_error=? WHERE vendor='microsoft' AND type='calendar' AND email=?`)
      .run(err.message.slice(0, 500), email);
    return { synced: 0, error: err.message };
  }

  let synced = 0;

  const params = new URLSearchParams({
    '$select': 'id,iCalUId,subject,start,end,attendees,organizer,location,body,showAs,isCancelled,webLink',
    '$top': '100',
    '$orderby': 'start/dateTime desc',
  });

  let url = `${GRAPH_USERS}/${encodeURIComponent(email)}/events?${params}`;

  try {
    while (url && synced < maxEvents) {
      const data = await graphFetch(url, accessToken);
      if (!data.value?.length) break;

      const tx = db.transaction((events) => {
        for (const event of events) {
          const startTime = parseDateTime(event.start);
          const endTime = parseDateTime(event.end);
          if (!startTime || !endTime) continue;

          const allDay = !event.start?.dateTime ? 1 : 0;
          const status = event.isCancelled ? 'cancelled' : (event.showAs === 'free' ? 'tentative' : 'confirmed');
          const organizer = event.organizer?.emailAddress?.address?.toLowerCase() || '';
          const location = event.location?.displayName || '';

          let description = '';
          if (event.body?.contentType === 'text') {
            description = event.body.content || '';
          } else if (event.body?.contentType === 'html') {
            description = stripHtml(event.body.content || '');
          }
          if (description.length > 4000) description = description.slice(0, 4000);

          const attendees = parseAttendees(event.attendees);
          upsertEvent.run(
            event.id,
            'primary',
            event.subject || '',
            description,
            location,
            startTime,
            endTime,
            allDay,
            JSON.stringify(attendees),
            organizer,
            status,
            event.webLink || '',
            accountId,
            // Graph names the cross-provider key iCalUId (st_8a841c68).
            event.iCalUId || null,
            'graph',
          );

          // st_fd14cdd4 AC6: sync-time attendee seeding — parity with the
          // Google path (lib/calendar-sync.js:135). Before this, Graph
          // attendees reached the entity graph only via the overnight batch
          // (up-to-a-day latency, quarantine-fragile). Graph attendees carry
          // no `self` flag, so the synced mailbox is excluded by address.
          try {
            seedCalendarAttendees(db, attendees, { source: 'calendar', selfEmail: email });
          } catch (err) {
            console.warn(`[graph-calendar] attendee seeding failed for ${event.id}: ${err.message}`);
          }

          synced++;
        }
      });

      tx(data.value);
      url = data['@odata.nextLink'] || null;
    }
  } catch (err) {
    console.error(`[graph-calendar] sync failed for ${email}:`, err.message);
    return { synced, error: err.message };
  }

  if (synced > 0) console.info(`[graph-calendar] synced ${synced} events for ${email}`);
  db.prepare(`UPDATE accounts SET synced_at=datetime('now'), last_error=NULL WHERE vendor='microsoft' AND type='calendar' AND email=?`)
    .run(email);
  return { synced };
}

export async function syncAllGraphCalendarAccounts(opts = {}) {
  const accounts = listConnectedMicrosoftAccounts('calendar');
  if (!accounts.length) return { synced: 0, accounts: 0 };

  let total = 0;
  const errors = [];

  for (const email of accounts) {
    const result = await syncGraphCalendarAccount(email, opts);
    total += result.synced;
    if (result.error) errors.push(`${email}: ${result.error}`);
  }

  return {
    synced: total,
    accounts: accounts.length,
    ...(errors.length ? { errors } : {}),
  };
}
