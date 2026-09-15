/**
 * lib/transcript-roster.js — resolve a transcript's candidate speaker roster
 * from the calendar invite (st_8a841c68 Phase 1).
 *
 * The calendar SELECTS which known people are on a call; it never CREATES an
 * entity. That is why this module imports ONLY the read-only matcher
 * (email guard → conf 1.0; ≥2-token name guard → conf 0.8 sub-threshold) and
 * never the create-on-miss resolver (which would pollute the graph with a junk
 * person for any unmatched attendee). A criterion greps this file to prove the
 * boundary (plan failure manifest #2).
 *
 * Thin-facade: every function takes `db` first.
 *
 * Join path, in order:
 *   1. transcripts.calendar_event_id → calendar_events.id (the Google event id
 *      Granola embeds) — exact, used when it lands.
 *   2. transcripts.ical_uid → calendar_events.ical_uid — same-provider bridge.
 *   3. Calendar-time match (deterministic) — when (1) and (2) miss, the same
 *      meeting exists on a *different* provider's calendar with the real roster
 *      (Google and Microsoft assign different event ids AND different iCalUIDs
 *      to the same cross-invited meeting, so 1+2 cannot bridge them). Prefer an
 *      event interval containing the transcript time, then use title overlap and
 *      attendee-name cues to break ties. Conservative: if several plausible
 *      meetings sit in the window with no title/person signal, refuse rather
 *      than guess a wrong roster (unassigned beats wrong).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchPerson } from './entity-resolve.js';
import { ownerEmails, ownerPersonId } from './identity.js';
import { loadSourceTopicRoutingConfig } from './topic-source-routing.js';
import { loadAsanaRoutingConfig } from './asana-routing-config.js';

// Start-time match window. Calls are recorded a few minutes after the scheduled
// start; ±20 min covers that without colliding with the next slot once title
// disambiguation is applied.
const TIME_WINDOW_SEC = 20 * 60;
const INTERVAL_GRACE_SEC = 10 * 60;
const BROAD_WINDOW_SEC = 6 * 60 * 60;
const TITLE_STOPWORDS = new Set([
  'apr', 'april', 'aug', 'august', 'base', 'call', 'dec', 'december',
  'demo', 'exec', 'feb', 'february', 'jan', 'january', 'jul', 'july',
  'jun', 'june', 'mar', 'march', 'may', 'meeting', 'nov', 'november',
  'oct', 'october', 'open', 'review', 'sep', 'september', 'session',
  'standup', 'sync', 'touch', 'update', 'updates', 'weekly',
]);
const DOMAIN_STOPWORDS = new Set([
  'calendar', 'com', 'co', 'google', 'ics', 'io', 'net', 'org', 'resource',
]);
// topic-slug → [routed domains], inverted from the two deterministic routing
// configs (config/source-topic-routing.json for general content,
// config/asana-routing.json for call routing) — EACH of which merges its
// gitignored owner override at load. The owner's venture/employer/education
// domains therefore live ONLY in those gitignored overrides, never as literals
// here; the tracked configs ship synthetic examples. This is a calendar-match
// tie-break signal only (topicDomainScore), so degrading to an empty map on a
// missing/unparseable config is safe. Cached per process — the configs are
// static per deploy (both loaders cache internally too).
let _topicDomains = null;
function topicDomains() {
  if (_topicDomains) return _topicDomains;
  const map = {};
  const add = (domainMap) => {
    for (const [domain, slug] of Object.entries(domainMap || {})) {
      const key = String(slug || '').toLowerCase();
      if (!key || !domain) continue;
      (map[key] ||= []).push(String(domain).toLowerCase());
    }
  };
  try { add(loadSourceTopicRoutingConfig().domains); } catch { /* degrade to no domain signal */ }
  try { add(loadAsanaRoutingConfig().domains); } catch { /* degrade to no domain signal */ }
  _topicDomains = map;
  return _topicDomains;
}

/** Test-only: force the inverted topic→domains map to rebuild on next use. */
export function _resetTopicDomainsForTests() {
  _topicDomains = null;
}

function normTitleTokens(s) {
  return titleTokenSet(s);
}

function titleJaccard(a, b) {
  const A = normTitleTokens(a), B = normTitleTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

let _nicknames = null;
function nicknames() {
  if (_nicknames) return _nicknames;
  try {
    _nicknames = JSON.parse(readFileSync(resolve(process.cwd(), 'config/nicknames.json'), 'utf8'));
  } catch {
    _nicknames = {};
  }
  return _nicknames;
}

function wordTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^\d+$/.test(w));
}

function domainTokens(email) {
  const domain = String(email || '').toLowerCase().split('@')[1] || '';
  return wordTokens(domain.replace(/[._-]+/g, ' '))
    .filter((w) => !DOMAIN_STOPWORDS.has(w));
}

// df_33f550b7 — exported so the deterministic owner-reconciliation in
// lib/granola-call-asana.js reuses the SAME normalization family (word tokens +
// first-name nickname aliases) rather than inventing a divergent normalizer.
export function tokenSet(s) {
  return new Set(wordTokens(s));
}

function titleTokenSet(s) {
  return new Set(wordTokens(s).filter((w) => !TITLE_STOPWORDS.has(w)));
}

function nameAliases(name) {
  const tokens = wordTokens(name);
  const out = new Set(tokens);
  const first = tokens[0];
  if (first) {
    for (const alias of nicknames()[first] || []) {
      const a = String(alias || '').toLowerCase();
      if (a.length > 2) out.add(a);
    }
  }
  return out;
}

// df_33f550b7 — exported alongside tokenSet for the shared owner-reconciliation
// normalizer (see tokenSet note above).
export function firstNameAliases(name) {
  const tokens = wordTokens(name);
  const out = new Set();
  const first = tokens[0];
  if (!first) return out;
  out.add(first);
  for (const alias of nicknames()[first] || []) {
    const a = String(alias || '').toLowerCase();
    if (a.length > 2) out.add(a);
  }
  return out;
}

function parseAttendees(rawAttendees) {
  let parsed = [];
  try { parsed = JSON.parse(rawAttendees); } catch { return []; }
  return Array.isArray(parsed) ? parsed : [];
}

function isResourceAttendee(email, name) {
  const e = String(email || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  return e.endsWith('@resource.calendar.google.com')
    || e.endsWith('@group.calendar.google.com')
    || n.includes('conference room')
    || n.includes('[zoom]')
    || /\broom\b/.test(n);
}

function usableAttendee(a) {
  if (a?.self) return false;
  const email = String(a?.email || '').trim().toLowerCase();
  if (!email.includes('@')) return false;
  const name = String(a?.name || a?.displayName || '').trim();
  const status = String(a?.status || a?.responseStatus || '').toLowerCase();
  if (status === 'declined') return false;
  if (isResourceAttendee(email, name)) return false;
  return true;
}

function addAttendeesFromJson(byEmail, rawAttendees) {
  const parsed = parseAttendees(rawAttendees);
  for (const a of parsed) {
    if (!usableAttendee(a)) continue;
    const email = String(a?.email || '').trim().toLowerCase();
    const name = String(a?.name || a?.displayName || '').trim();
    if (!byEmail.has(email) || (name && !byEmail.get(email).name)) {
      byEmail.set(email, { email, name });
    }
  }
}

function addAttendeesFromCsv(byEmail, csv) {
  for (const raw of String(csv || '').split(',')) {
    const email = raw.trim().toLowerCase();
    if (!email.includes('@')) continue;
    if (isResourceAttendee(email, '')) continue;
    if (!byEmail.has(email)) byEmail.set(email, { email, name: '' });
  }
}

function attendeeTitleScore(title, rawAttendees) {
  const titleTokens = titleTokenSet(title);
  if (!titleTokens.size) return 0;
  let score = 0;
  for (const a of parseAttendees(rawAttendees)) {
    if (!usableAttendee(a)) continue;
    const email = String(a?.email || '').trim().toLowerCase();
    const name = String(a?.name || a?.displayName || '').trim();
    for (const alias of nameAliases(name)) {
      if (titleTokens.has(alias)) score = Math.max(score, 1);
    }
    const local = email.split('@')[0] || '';
    for (const token of wordTokens(local.replace(/[._-]+/g, ' '))) {
      if (titleTokens.has(token)) score = Math.max(score, 0.6);
    }
    for (const token of domainTokens(email)) {
      if (titleTokens.has(token)) score = Math.max(score, 0.8);
    }
  }
  return score;
}

function topicDomainScore(topic, rawAttendees, summary) {
  const topicDomainList = topicDomains()[String(topic || '').toLowerCase()] || [];
  if (!topicDomainList.length) return 0;
  const s = String(summary || '').toLowerCase();
  const topicLabel = String(topic || '').toLowerCase().replace(/-/g, ' ');
  let score = s.includes(topicLabel) ? 1 : 0;
  for (const a of parseAttendees(rawAttendees)) {
    if (!usableAttendee(a)) continue;
    const email = String(a?.email || '').trim().toLowerCase();
    const domain = email.split('@')[1] || '';
    if (topicDomainList.some((d) => domain === d || domain.endsWith(`.${d}`))) {
      score = Math.max(score, 1);
    }
  }
  return score;
}

function eventPenalty(summary) {
  const s = String(summary || '').toLowerCase();
  return /\booo\b|out of office|school pickup|fitness class|canceled:/.test(s) ? 2 : 0;
}

function filteredAttendeeCount(rawAttendees) {
  return parseAttendees(rawAttendees).filter(usableAttendee).length;
}

let _titlePersonIndex = null;
function titlePersonIndex(db) {
  if (_titlePersonIndex) return _titlePersonIndex;
  const rows = db.prepare(`
    SELECT id, display_name, short_name, source_count, interaction_count, confidence
      FROM people
     WHERE archived = 0
       AND display_name IS NOT NULL
       AND display_name != ''
       AND display_name NOT LIKE '%@%'
       AND display_name NOT LIKE '''%'
     ORDER BY (COALESCE(source_count, 0) + COALESCE(interaction_count, 0) * 20 + COALESCE(confidence, 0) * 100) DESC
  `).all();
  const aliasToPerson = new Map();
  const blocked = new Set();
  for (const row of rows) {
    const weight = Number(row.source_count || 0)
      + (Number(row.interaction_count || 0) * 20)
      + (Number(row.confidence || 0) * 100);
    const aliases = new Set([...firstNameAliases(row.display_name), ...wordTokens(row.short_name)]);
    for (const alias of aliases) {
      if (alias.length <= 2) continue;
      if (blocked.has(alias)) continue;
      const existing = aliasToPerson.get(alias);
      if (existing && existing.id !== row.id) {
        if (weight > existing.weight * 3 && weight - existing.weight > 100) {
          aliasToPerson.set(alias, { id: row.id, name: row.display_name, weight });
        } else if (!(existing.weight > weight * 3 && existing.weight - weight > 100)) {
          aliasToPerson.delete(alias);
          blocked.add(alias);
        }
      } else {
        aliasToPerson.set(alias, { id: row.id, name: row.display_name, weight });
      }
    }
  }
  _titlePersonIndex = aliasToPerson;
  return _titlePersonIndex;
}

function addPeopleFromTitle(byEmail, db, title) {
  const titleTokens = titleTokenSet(title);
  if (!titleTokens.size) return;
  const index = titlePersonIndex(db);
  for (const token of titleTokens) {
    const person = index.get(token);
    if (!person) continue;
    const key = `person:${person.id}`;
    if (!byEmail.has(key)) {
      byEmail.set(key, { email: '', name: person.name, personIdHint: person.id });
    }
  }
}

/**
 * Resolve the candidate speaker roster for a transcript row.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{id:string, calendar_event_id?:string, ical_uid?:string}} transcriptRow
 * @returns {{candidates:Array<{personId:string|null,email:string,name:string,confidence:number,guard:string|null}>, eventId:string|null, matchedEventCount:number, directCalendarId:string|null}}
 *   candidates: one entry per non-self calendar attendee. personId is set when
 *   matchPerson resolved (email or full-name), null when the attendee is on the
 *   invite but not yet a known entity (honest — never created here).
 *   directCalendarId (df_33f550b7): the calendar_id of the transcript's OWN
 *   embedded event (calendar_event_id, then ical_uid) via an unfiltered lookup —
 *   additive, for the calendar-ownership routing layer; null when neither
 *   embedded key resolves. Never sourced from a time-window candidate.
 */
export function resolveRoster(db, transcriptRow) {
  const eventId = transcriptRow?.calendar_event_id || null;
  const icalUid = transcriptRow?.ical_uid || null;

  // Direct event-id join (Google path) first; fall back to the cross-provider
  // ical_uid bridge when present (built now, Microsoft/Apple verified later).
  let events = [];
  if (eventId) {
    events = db.prepare(
      "SELECT attendees FROM calendar_events WHERE id = ? AND attendees IS NOT NULL AND attendees != '' AND attendees != '[]'",
    ).all(eventId);
  }
  if (events.length === 0 && icalUid) {
    events = db.prepare(
      "SELECT attendees FROM calendar_events WHERE ical_uid = ? AND attendees IS NOT NULL AND attendees != '' AND attendees != '[]'",
    ).all(icalUid);
  }

  // Tier 3: deterministic calendar-time match. Prefer the event interval: a
  // Granola timestamp often lands inside a long meeting, not at the scheduled
  // start. If several nearby events collide, the transcript title and attendee
  // names break the tie.
  let matchMethod = events.length ? (eventId && events.length ? 'event_id' : 'ical_uid') : null;
  const meetingDate = transcriptRow?.meeting_date || null;
  if (events.length === 0 && meetingDate) {
    const nearby = db.prepare(
      `SELECT id, summary, attendees, start_time, end_time,
              abs(strftime('%s', start_time) - strftime('%s', ?)) AS dt,
              CASE
                WHEN strftime('%s', ?) BETWEEN
                     strftime('%s', start_time) - ?
                     AND strftime('%s', COALESCE(end_time, start_time)) + ?
                THEN 1 ELSE 0
              END AS in_interval
       FROM calendar_events
       WHERE attendees IS NOT NULL AND attendees != '' AND attendees != '[]'
         AND start_time IS NOT NULL
         AND (
           abs(strftime('%s', start_time) - strftime('%s', ?)) <= ?
           OR (
             end_time IS NOT NULL
             AND strftime('%s', ?) BETWEEN
                 strftime('%s', start_time) - ?
                 AND strftime('%s', end_time) + ?
           )
         )
       ORDER BY dt ASC`,
    ).all(
      meetingDate,
      meetingDate, INTERVAL_GRACE_SEC, INTERVAL_GRACE_SEC,
      meetingDate, BROAD_WINDOW_SEC,
      meetingDate, INTERVAL_GRACE_SEC, INTERVAL_GRACE_SEC,
    );

    const scored = nearby
      .map((e) => {
        const titleScore = titleJaccard(transcriptRow?.title, e.summary);
        const attendeeScore = attendeeTitleScore(transcriptRow?.title, e.attendees);
        const nearOrInside = e.in_interval === 1 || Number(e.dt || 0) <= TIME_WINDOW_SEC;
        const topicScore = nearOrInside ? topicDomainScore(transcriptRow?.topic, e.attendees, e.summary) : 0;
        const attendees = filteredAttendeeCount(e.attendees);
        const penalty = eventPenalty(e.summary);
        const intervalScore = e.in_interval ? 2 : 0;
        return {
          e,
          dt: Number(e.dt || 0),
          attendees,
          titleScore,
          attendeeScore,
          topicScore,
          interval: e.in_interval === 1,
          score: intervalScore + (titleScore * 2) + (attendeeScore * 3) + topicScore - penalty,
        };
      })
      .filter((x) => x.attendees > 0)
      .sort((a, b) => b.score - a.score || a.dt - b.dt);

    if (scored.length === 1 && scored[0].score >= 0) {
      events = [scored[0].e];
      matchMethod = scored[0].interval ? 'interval' : 'time';
    } else if (scored.length > 1) {
      const best = scored[0];
      const second = scored[1];
      const decisiveNearestTie = best.score === second.score && best.dt + TIME_WINDOW_SEC < second.dt;
      if (best.score > 0 && (best.score > second.score || decisiveNearestTie)) {
        events = [scored[0].e];
        matchMethod = best.interval ? 'interval+title' : 'time+title';
      }
      // else: no title/person signal among competing meetings → refuse.
    }
  }

  // Dedupe attendees by lowercased email across (rarely) multiple matched rows.
  const byEmail = new Map();
  for (const row of events) {
    addAttendeesFromJson(byEmail, row.attendees);
  }

  // Final fallback: Granola sync stores attendee_emails from the document
  // payload or calendar-title fallback. If the calendar table is incomplete,
  // the email identifiers still give a closed roster for two-person calls.
  if (byEmail.size === 0) {
    addAttendeesFromCsv(byEmail, transcriptRow?.attendee_emails);
  }

  // Last-resort historical repair: older Granola rows sometimes carry only the
  // owner's email and no matchable calendar key. If the title names exactly one
  // known person alias ("Sloan Sync", "Eddie Marketing ROI"), add that person
  // to the closed roster. This is read-only and never creates a person.
  if (events.length === 0 && byEmail.size <= 1) {
    addPeopleFromTitle(byEmail, db, transcriptRow?.title);
  }

  const candidates = [];
  const seen = new Set();
  const ownerId = ownerPersonId();
  const ownerEmailSet = new Set(ownerEmails());
  for (const entry of byEmail.values()) {
    const { email, name, personIdHint } = entry;
    // matchPerson is read-only: email guard (conf 1.0) then ≥2-token name guard
    // (conf 0.8). A miss yields null personId — the attendee is a candidate on
    // the invite but not a known entity; we never create one here.
    const match = personIdHint
      ? { personId: personIdHint, confidence: 0.75, guard: 'title_person' }
      : matchPerson({ name, email });
    const identityKey = match?.personId ? `person:${match.personId}` : `email:${email}`;
    if (seen.has(identityKey)) continue;
    seen.add(identityKey);
    if (!match?.personId && ownerEmailSet.has(email)) continue;
    let displayName = name;
    if (!displayName && match?.personId) {
      try {
        displayName = db.prepare('SELECT display_name FROM people WHERE id = ?').get(match.personId)?.display_name || '';
      } catch { /* optional polish only */ }
    }
    candidates.push({
      personId: match?.personId || null,
      email,
      name: displayName,
      confidence: match?.confidence ?? 0,
      guard: match?.guard || null,
    });
  }

  candidates.sort((a, b) => {
    if (a.personId === ownerId) return 1;
    if (b.personId === ownerId) return -1;
    return String(a.name || a.email).localeCompare(String(b.name || b.email));
  });

  // df_33f550b7 — dedicated, UNFILTERED read of the calendar the transcript's
  // OWN embedded event belongs to, for the calendar-ownership routing layer
  // (lib/call-routing.js). This deliberately OMITS the `attendees != '[]'`
  // filter the roster join above uses — import/subscribed calendars (e.g. the
  // owner's work calendar) strip attendees, so the filtered join can
  // never surface their calendar_id. Keyed ONLY on the transcript's own
  // calendar_event_id (then ical_uid), never a time-window candidate, so a
  // personal call merely time-adjacent to an import event cannot inherit that
  // calendar_id. Additive: it writes ONLY directCalendarId and must not touch
  // events/candidates/byEmail/matchedEventCount above. null when neither
  // embedded key resolves; the id result is preferred over ical when both do.
  let directCalendarId = null;
  try {
    if (eventId) {
      directCalendarId = db.prepare('SELECT calendar_id FROM calendar_events WHERE id = ? LIMIT 1').get(eventId)?.calendar_id || null;
    }
    if (!directCalendarId && icalUid) {
      directCalendarId = db.prepare('SELECT calendar_id FROM calendar_events WHERE ical_uid = ? LIMIT 1').get(icalUid)?.calendar_id || null;
    }
  } catch {
    // A minimal/legacy fixture DB may lack calendar_events.calendar_id. The
    // calendar-ownership signal is optional and purely additive, so degrade to
    // null (no signal) rather than crash the classifier — graceful degradation,
    // never fail on missing data. The live DB always carries the column.
    directCalendarId = null;
  }

  return { candidates, eventId, matchedEventCount: events.length, matchMethod, directCalendarId };
}
