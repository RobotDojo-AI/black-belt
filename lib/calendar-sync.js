/**
 * Calendar sync pipeline — fetches events from all user's Google Calendars,
 * stores in calendar_events, resolves attendees into the people graph.
 *
 * Upserts on event id — re-syncs are safe and pick up edits automatically.
 * Window: complete history → 2 years forward for onboarding/full sync;
 * incremental runs use the caller's `since` window.
 */

import db from './db.js';
import { getValidAccessToken, listConnectedGoogleAccounts } from './google-oauth.js';
import { resolvePerson } from './entity-resolve.js';

const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';

async function gcalGet(accessToken, path) {
  const res = await fetch(`${GCAL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

const upsertEvent = db.prepare(`
  INSERT INTO calendar_events
    (id, calendar_id, summary, description, location, start_time, end_time,
     all_day, attendees, organizer, status, html_link, account_id, ical_uid, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api')
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
    source      = 'api',
    synced_at   = datetime('now')
`);

export async function syncCalendarAccount(email, opts = {}) {
  const { fullSync = false, since, yearsFuture = 2 } = opts;
  const stats = { synced: 0, skipped: 0, errors: 0 };

  let accessToken;
  try {
    accessToken = await getValidAccessToken(email);
  } catch (err) {
    console.error(`[calendar-sync] auth failed for ${email}: ${err.message}`);
    db.prepare(`UPDATE accounts SET last_error=? WHERE vendor='google' AND type='calendar' AND email=?`)
      .run(err.message.slice(0, 500), email);
    return { ...stats, error: err.message };
  }
  if (!accessToken) {
    console.warn(`[calendar-sync] no valid token for ${email}`);
    db.prepare(`UPDATE accounts SET last_error='no_token' WHERE vendor='google' AND type='calendar' AND email=?`)
      .run(email);
    return { ...stats, error: 'no_token' };
  }

  const accountRow = db.prepare(
    `SELECT id FROM accounts WHERE vendor = 'google' AND type = 'calendar' AND email = ? LIMIT 1`
  ).get(email);
  const accountId = accountRow?.id || null;

  const timeMin = (!fullSync && since)
    ? since.toISOString()
    : new Date(0).toISOString();
  const timeMax = new Date(Date.now() + yearsFuture * 365 * 24 * 60 * 60 * 1000).toISOString();

  let calendarIds;
  try {
    const list = await gcalGet(accessToken, '/users/me/calendarList?maxResults=250');
    calendarIds = (list.items || [])
      .filter(c => c.accessRole !== 'freeBusyReader')
      .map(c => c.id);
    if (!calendarIds.length) calendarIds = ['primary'];
  } catch (err) {
    console.warn(`[calendar-sync] calendarList failed for ${email}, falling back to primary: ${err.message}`);
    calendarIds = ['primary'];
  }

  for (const calId of calendarIds) {
    let pageToken = null;
    do {
      const qs = new URLSearchParams({
        singleEvents: 'true',
        orderBy:      'startTime',
        maxResults:   '2500',
        timeMin,
        timeMax,
      });
      if (pageToken) qs.set('pageToken', pageToken);

      let page;
      try {
        page = await gcalGet(accessToken, `/calendars/${encodeURIComponent(calId)}/events?${qs}`);
      } catch (err) {
        console.warn(`[calendar-sync] events.list failed for calendar ${calId}: ${err.message}`);
        stats.errors++;
        break;
      }

      for (const event of page.items || []) {
        const startTime = event.start?.dateTime || event.start?.date || '';
        const endTime   = event.end?.dateTime   || event.end?.date   || '';
        const allDay    = !event.start?.dateTime ? 1 : 0;
        const organizer = event.organizer?.email || '';

        const attendees = JSON.stringify(
          (event.attendees || []).map(a => ({
            email:  a.email,
            name:   a.displayName || '',
            status: a.responseStatus || '',
            self:   a.self || false,
          }))
        );

        upsertEvent.run(
          event.id, calId, event.summary || '', event.description || '',
          event.location || '', startTime, endTime, allDay,
          attendees, organizer, event.status || 'confirmed',
          event.htmlLink || '', accountId,
          // iCalUID is the cross-provider stable key (st_8a841c68) — the bridge
          // that lets a Granola transcript's embedded Google event match this
          // row even when the calendar later syncs via another provider.
          event.iCalUID || null,
        );
        stats.synced++;

        for (const a of event.attendees || []) {
          if (a.self || !a.email) continue;
          try {
            resolvePerson({ name: a.displayName || '', email: a.email, source: 'calendar' });
          } catch (err) {
            console.warn(`[calendar-sync] resolve failed for ${a.email}: ${err.message}`);
          }
        }
      }

      pageToken = page.nextPageToken || null;
    } while (pageToken);
  }

  console.info(`[calendar-sync] ${email}: synced=${stats.synced} errors=${stats.errors} calendars=${calendarIds.length}`);
  db.prepare(`UPDATE accounts SET synced_at=datetime('now'), last_error=NULL WHERE vendor='google' AND type='calendar' AND email=?`)
    .run(email);
  return stats;
}

export async function syncAllCalendarAccounts(opts = {}) {
  const emails = listConnectedGoogleAccounts();
  if (!emails.length) return { synced: 0, accounts: 0 };

  const fullSyncEmails = new Set((opts.fullSyncEmails || []).map((email) => String(email).toLowerCase()));
  let total = 0;
  const errors = [];
  for (const email of emails) {
    const shouldFullSync = opts.fullSync || fullSyncEmails.has(String(email).toLowerCase());
    const result = await syncCalendarAccount(email, {
      ...opts,
      fullSync: shouldFullSync,
      since: shouldFullSync ? null : opts.since,
    });
    total += result.synced;
    if (result.error) errors.push(`${email}: ${result.error}`);
  }

  return { synced: total, accounts: emails.length, ...(errors.length ? { errors } : {}) };
}
