/**
 * Calendar Extractor — entity extraction from calendar events.
 * Signal #2: time allocation = revealed preference.
 * Reads from calendar_events in robotdojo.db (already synced via Google Calendar API).
 */
import crypto from 'node:crypto';
import db from './db.js';
import { resolvePerson, FREEMAIL_DOMAINS, normalizeEmail } from './entity-resolve.js';
import { findOrCreatePlace, linkGenericEntityToEvent } from './timeline-schema.js';

// --- Virtual location patterns ---

const VIRTUAL_PATTERNS = [
  /zoom\.us/i,
  /^zoom$/i,
  /^google\s*meet/i,
  /meet\.google\.com/i,
  /microsoft\s*teams/i,
  /^teams$/i,
  /webex/i,
  /^skype$/i,
  /^facetime$/i,
  /\bphone\b/i,
  /^\+?\d[\d\s\-().]{6,}$/,  // phone numbers
  /^\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/,  // bare US phone (start of string)
  /^https?:\/\//i,            // any URL
  /^call\b/i,                 // "call him", "call me", "Call <name>"
  /^to call/i,
  /^tbd$/i,
  /^tba$/i,
  /^n\/?a$/i,
  /^none$/i,
  /^online$/i,
  /^remote$/i,
  /^virtual$/i,
  /^dial[\s-]?in/i,
  /^conference\s*call/i,
  /^see\s+(description|details|notes|below)/i,
  /instructions in description/i,
  /toll\s*free/i,
  /passcode/i,
  /^\d{3}[\s\-]\d{3}[\s\-]\d{4}$/,  // US phone
];

/**
 * Returns true if the location is virtual/online/noise.
 */
function isVirtualLocation(location) {
  if (!location || location.trim().length === 0) return true;
  const trimmed = location.trim();
  return VIRTUAL_PATTERNS.some(p => p.test(trimmed));
}

// US state abbreviations for city parsing
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

/**
 * Extract city from a location string using simple heuristics.
 * Handles formats like:
 *   "123 Main St, Philadelphia, PA 19103, USA"
 *   "Central Park Conservancy, 14 E 60th St, New York, NY 10022, USA"
 *   "Acme HQ, Boston, MA, United States"
 *   "Philadelphia PHL" (airport code)
 *   "NYC"
 * Returns { city, state } or null.
 */
function extractCity(location) {
  if (!location) return null;
  const trimmed = location.trim();

  // Airport codes: "City ABC" or just "ABC" — skip three-letter-only
  const airportMatch = trimmed.match(/^(.+?)\s+[A-Z]{3}$/);
  if (airportMatch) {
    return { city: airportMatch[1].trim(), state: null };
  }

  // Comma-separated: look for City, ST or City, ST ZIP patterns
  const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // Walk backwards to find state abbreviation
    for (let i = parts.length - 1; i >= 1; i--) {
      const segment = parts[i].trim();
      // Match "ST" or "ST 12345" or "ST 12345-6789"
      const stateMatch = segment.match(/^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/);
      if (stateMatch && US_STATES.has(stateMatch[1])) {
        const city = parts[i - 1].trim();
        // Skip if city looks like a street number
        if (city && !/^\d+\s/.test(city)) {
          return { city, state: stateMatch[1] };
        }
      }
      // Match "United States" or "USA" — city is two segments back
      if (/^(United States|USA|US)$/i.test(segment) && i >= 2) {
        // Check if the segment before this is a state
        const prevSegment = parts[i - 1].trim();
        const prevStateMatch = prevSegment.match(/^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/);
        if (prevStateMatch && US_STATES.has(prevStateMatch[1]) && i >= 3) {
          const city = parts[i - 2].trim();
          if (city && !/^\d+\s/.test(city)) {
            return { city, state: prevStateMatch[1] };
          }
        }
      }
    }
  }

  // Well-known city abbreviations
  const cityAbbrevs = { 'NYC': 'New York', 'LA': 'Los Angeles', 'SF': 'San Francisco', 'DC': 'Washington' };
  if (cityAbbrevs[trimmed.toUpperCase()]) {
    return { city: cityAbbrevs[trimmed.toUpperCase()], state: null };
  }

  return null;
}

// --- Prepared statements ---

const stmts = {
  eventsWithAttendees: db.prepare(`
    SELECT id, summary, start_time, end_time, attendees, organizer, status
    FROM calendar_events
    WHERE attendees != '[]' AND status != 'cancelled'
    ORDER BY start_time DESC
  `),
  eventCount: db.prepare(`
    SELECT COUNT(*) as count FROM calendar_events WHERE attendees != '[]' AND status != 'cancelled'
  `),
  eventsWithLocation: db.prepare(`
    SELECT id, summary, start_time, end_time, location, status
    FROM calendar_events
    WHERE location != '' AND status != 'cancelled'
    ORDER BY start_time DESC
  `),

  // Check if a timeline event exists for this calendar event
  timelineEventId: db.prepare(`
    SELECT id FROM timeline_events WHERE source_type = 'calendar' AND source_id = ?
  `),
};

/**
 * Content-hashed event ID for dedup.
 */
function contentHash(source, sourceId, content) {
  return crypto.createHash('sha256')
    .update(`${source}|${sourceId}|${content}`)
    .digest('hex');
}

/**
 * Extract email domain.
 */
function domainFrom(email) {
  if (!email || !email.includes('@')) return null;
  return email.split('@')[1].toLowerCase();
}

/**
 * Extract entities from calendar events.
 * @returns {Array<{ eventId: string, summary: string, startTime: string, attendeeEmails: string[] }>}
 */
export function extractCalendarEntities() {
  const events = stmts.eventsWithAttendees.all();
  const results = [];

  for (const event of events) {
    let attendees;
    try {
      attendees = JSON.parse(event.attendees);
    } catch (err) {
      console.warn(`[calendar] bad attendees JSON for event ${event.id}: ${err.message}`);
      continue;
    }

    if (!Array.isArray(attendees) || attendees.length === 0) continue;

    // Normalize: attendees are email strings in this schema
    const emails = attendees
      .map(a => normalizeEmail(typeof a === 'string' ? a : a.email))
      .filter(Boolean);

    if (emails.length === 0) continue;

    results.push({
      eventId: event.id,
      summary: event.summary,
      startTime: event.start_time,
      endTime: event.end_time,
      attendeeEmails: emails,
    });
  }

  console.info(`[calendar] extracted ${results.length} events with attendees`);
  return results;
}

/**
 * Ingest calendar entities: resolve attendees, compute co-occurrence stats.
 * @returns {{ events: number, attendeesResolved: number, created: number, coOccurrences: Map<string, number> }}
 */
export function ingestCalendarEntities() {
  const events = extractCalendarEntities();
  const stats = { events: events.length, attendeesResolved: 0, created: 0, pairs: 0 };

  // Track per-person event counts and co-occurrence pairs
  const personEvents = new Map();   // personId → count
  const coOccurrence = new Map();   // "idA|idB" → count (sorted IDs)

  for (const event of events) {
    const resolvedIds = [];

    for (const email of event.attendeeEmails) {
      try {
        const result = resolvePerson({ email, source: 'calendar' });
        resolvedIds.push(result.personId);
        stats.attendeesResolved++;
        if (result.created) stats.created++;

        // Track per-person event count
        personEvents.set(result.personId, (personEvents.get(result.personId) || 0) + 1);
      } catch (err) {
        console.error(`[calendar] failed to resolve ${email}: ${err.message}`);
      }
    }

    // Record co-occurrence for all pairs in this event
    for (let i = 0; i < resolvedIds.length; i++) {
      for (let j = i + 1; j < resolvedIds.length; j++) {
        const pair = [resolvedIds[i], resolvedIds[j]].sort().join('|');
        coOccurrence.set(pair, (coOccurrence.get(pair) || 0) + 1);
      }
    }
  }

  stats.pairs = coOccurrence.size;

  // Log top co-occurring pairs
  const topPairs = [...coOccurrence.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (topPairs.length > 0) {
    console.info(`[calendar] top co-occurrences:`);
    for (const [pair, count] of topPairs) {
      console.info(`  ${pair}: ${count} events`);
    }
  }

  // Compute per-person calendar stats
  const calendarStats = {
    totalPeople: personEvents.size,
    totalEvents: events.length,
    topAttendees: [...personEvents.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id, count]) => ({ personId: id, eventCount: count })),
  };

  console.info(`[calendar] ingested: ${stats.events} events, ${stats.attendeesResolved} attendees resolved, ${stats.created} created, ${stats.pairs} co-occurrence pairs`);

  return { ...stats, personEvents, coOccurrence, calendarStats };
}

/**
 * Extract places from calendar event locations.
 * Skips virtual/online locations. Creates place records and links to timeline events.
 * @returns {{ total: number, physical: number, virtual: number, placesCreated: number, citiesCreated: number, linked: number }}
 */
export function extractCalendarPlaces() {
  const events = stmts.eventsWithLocation.all();
  const stats = { total: events.length, physical: 0, virtual: 0, placesCreated: 0, citiesCreated: 0, linked: 0 };

  // Disable FK checks for place linking — person_id column has legacy FK to people(id)
  // and PRAGMA foreign_keys cannot be changed inside a transaction.
  db.pragma('foreign_keys = OFF');

  const txn = db.transaction((batch) => {
    for (const event of batch) {
      const location = event.location.trim();

      if (isVirtualLocation(location)) {
        stats.virtual++;
        continue;
      }

      stats.physical++;

      // Extract city from the location
      const cityInfo = extractCity(location);
      let parentPlaceId = null;

      // Create or find city as parent
      if (cityInfo) {
        const cityName = cityInfo.state ? `${cityInfo.city}, ${cityInfo.state}` : cityInfo.city;
        const cityResult = findOrCreatePlace({
          name: cityName,
          placeType: 'city',
          eventDate: event.start_time,
        });
        parentPlaceId = cityResult.id;
        if (cityResult.created) stats.citiesCreated++;
      }

      // Create or find the place
      const placeResult = findOrCreatePlace({
        name: location,
        placeType: 'venue',
        parentPlaceId,
        address: location,
        eventDate: event.start_time,
      });
      if (placeResult.created) stats.placesCreated++;

      // Link to timeline event if one exists
      const timelineEvent = stmts.timelineEventId.get(event.id);
      if (timelineEvent) {
        try {
          linkGenericEntityToEvent(timelineEvent.id, 'place', placeResult.id, 'location');
          stats.linked++;
        } catch (err) {
          // UNIQUE constraint — already linked
        }
      }
    }
  });

  try {
    // Process in batches of 1000
    const BATCH = 1000;
    for (let i = 0; i < events.length; i += BATCH) {
      txn(events.slice(i, i + BATCH));
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }

  console.info(`[calendar:places] ${stats.total} locations — ${stats.physical} physical, ${stats.virtual} virtual`);
  console.info(`[calendar:places] ${stats.placesCreated} places created, ${stats.citiesCreated} cities created, ${stats.linked} linked to timeline`);

  return stats;
}

// Export helpers for testing
export { isVirtualLocation, extractCity };
