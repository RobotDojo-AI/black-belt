/**
 * Health topic timeline.
 *
 * Labs belong on the timeline by definition: every pdf-lab / fhir / manual /
 * derived-lipid point projects to timeline_events, and the Health topic
 * timeline reads those points directly. User-attested facts are separate
 * (source_type=user) and also append to that topic's LOG.md.
 *
 * Same contract for any user's health topic (slug `health`).
 */
import db from './db.js';
import { insertTimelineEventForDb } from './timeline-schema.js';
import { listEffectiveMedicationsRaw } from './health-medications.js';

export const HEALTH_TOPIC_SLUG = 'health';
export const LAB_TIMELINE_SOURCES = Object.freeze(['pdf-lab', 'fhir', 'manual', 'derived-lipid']);

const LAB_SOURCE_SET = new Set(LAB_TIMELINE_SOURCES);

export function isLabTimelineSource(source) {
  return LAB_SOURCE_SET.has(String(source || ''));
}

function clip(text, max = 180) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
}

function monthLabel(iso) {
  const day = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day || '';
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function markerLabel(markerId) {
  return String(markerId || 'marker').replace(/_/g, ' ');
}

export function healthMetricTimelineEvent(row = {}) {
  const source = String(row.source || 'health_metric');
  const lab = isLabTimelineSource(source);
  return {
    sourceType: source,
    sourceId: String(row.id),
    eventDate: row.date,
    eventType: lab ? 'lab_result' : 'health_metric',
    summary: clip(`${row.marker_id}: ${row.value}`),
    content: `${row.marker_id}:${row.value}`,
    metadata: {
      marker_id: row.marker_id,
      source_file: row.source_file || null,
      excluded: !!row.excluded,
      topic: HEALTH_TOPIC_SLUG,
      lab: lab,
    },
  };
}

export function projectHealthDataPointForDb(database, row) {
  if (!row?.id || !row?.date) return null;
  const event = healthMetricTimelineEvent(row);
  if (!event.sourceType || !event.sourceId || !event.eventDate) return null;
  return insertTimelineEventForDb(database, event);
}

export function projectHealthDataPointBySourceId(database, sourceId) {
  const row = pointBySourceId(database, sourceId);
  if (!row) return null;
  return projectHealthDataPointForDb(database, row);
}

export function ensureHealthPointsOnTimeline(database = db, { limit = 20_000, sources = null } = {}) {
  if (!database?.prepare) return { scanned: 0, projected: 0 };
  const list = Array.isArray(sources) && sources.length ? sources : null;
  let rows = [];
  try {
    if (list) {
      const placeholders = list.map(() => '?').join(',');
      rows = database.prepare(`
        SELECT h.id, h.marker_id, h.date, h.value, h.source, h.source_file, h.excluded
        FROM health_data_points h
        WHERE h.source IN (${placeholders})
          AND h.date IS NOT NULL AND h.date != ''
          AND NOT EXISTS (
            SELECT 1 FROM timeline_events t
            WHERE t.source_type = h.source
              AND t.source_id = CAST(h.id AS TEXT)
          )
        LIMIT ?
      `).all(...list, limit);
    } else {
      rows = database.prepare(`
        SELECT h.id, h.marker_id, h.date, h.value, h.source, h.source_file, h.excluded
        FROM health_data_points h
        WHERE h.date IS NOT NULL AND h.date != ''
          AND NOT EXISTS (
            SELECT 1 FROM timeline_events t
            WHERE t.source_type = h.source
              AND t.source_id = CAST(h.id AS TEXT)
          )
        LIMIT ?
      `).all(limit);
    }
  } catch {
    return { scanned: 0, projected: 0 };
  }
  let projected = 0;
  for (const row of rows) {
    const result = projectHealthDataPointForDb(database, row);
    if (result?.inserted) projected += 1;
  }
  return { scanned: rows.length, projected };
}

export function projectLabDataPointForDb(database, row) {
  if (!isLabTimelineSource(row?.source)) return null;
  return projectHealthDataPointForDb(database, row);
}

function pointBySourceId(database, sourceId) {
  if (!database?.prepare || !sourceId) return null;
  try {
    return database.prepare(`
      SELECT id, marker_id, date, value, source, source_file, excluded
      FROM health_data_points
      WHERE source_id = ?
    `).get(sourceId) || null;
  } catch {
    return null;
  }
}

/**
 * Write a lab result onto the timeline. Prefer the health_data_points row
 * when the caller already persisted it; otherwise fall back to the source id.
 */
export function writeLabEvent(markerId, date, value, unit, sourceId, extra = {}) {
  const database = extra.database || db;
  const row = extra.row || pointBySourceId(database, sourceId);
  if (row) return projectHealthDataPointForDb(database, row);
  return insertTimelineEventForDb(database, {
    sourceType: extra.source || 'fhir',
    sourceId: sourceId || `${markerId}|${date}`,
    eventDate: date,
    eventType: 'lab_result',
    summary: clip(`Lab: ${markerId} = ${value}${unit ? ` ${unit}` : ''}`),
    content: `${markerId}:${value}`,
    metadata: {
      marker_id: markerId,
      unit: unit || null,
      topic: HEALTH_TOPIC_SLUG,
      lab: true,
    },
  });
}

export function writeMedEvent(name, event, date, extra = {}) {
  const database = extra.database || db;
  const verb = String(event || 'changed');
  const sourceId = extra.sourceId || `med|${name}|${verb}|${date}`;
  return insertTimelineEventForDb(database, {
    sourceType: extra.sourceType || 'curated_medications',
    sourceId: String(sourceId),
    eventDate: date,
    eventType: 'medication_change',
    summary: clip(`Medication: ${name} — ${verb}`),
    content: `${name}:${verb}`,
    metadata: {
      name,
      event: verb,
      topic: HEALTH_TOPIC_SLUG,
      provenance: extra.provenance || 'curated',
    },
  });
}

export function ensureLabPointsOnTimeline(database = db, { limit = 20_000 } = {}) {
  if (!database?.prepare) return { scanned: 0, projected: 0 };
  const placeholders = LAB_TIMELINE_SOURCES.map(() => '?').join(',');
  let rows = [];
  try {
    rows = database.prepare(`
      SELECT h.id, h.marker_id, h.date, h.value, h.source, h.source_file, h.excluded
      FROM health_data_points h
      WHERE h.source IN (${placeholders})
        AND h.date IS NOT NULL AND h.date != ''
        AND NOT EXISTS (
          SELECT 1 FROM timeline_events t
          WHERE t.source_type = h.source
            AND t.source_id = CAST(h.id AS TEXT)
        )
      LIMIT ?
    `).all(...LAB_TIMELINE_SOURCES, limit);
  } catch {
    return { scanned: 0, projected: 0 };
  }
  let projected = 0;
  for (const row of rows) {
    const result = projectHealthDataPointForDb(database, row);
    if (result?.inserted) projected += 1;
  }
  return { scanned: rows.length, projected };
}

function listLabDraws(database, { limit }) {
  const placeholders = LAB_TIMELINE_SOURCES.map(() => '?').join(',');
  const draws = database.prepare(`
    SELECT date, COUNT(*) AS n, COUNT(DISTINCT marker_id) AS markers
    FROM health_data_points
    WHERE source IN (${placeholders})
      AND COALESCE(excluded, 0) = 0
      AND date IS NOT NULL AND date != ''
    GROUP BY date
    ORDER BY date DESC
    LIMIT ?
  `).all(...LAB_TIMELINE_SOURCES, limit);
  if (!draws.length) return [];
  const dates = draws.map((row) => row.date);
  const datePlaceholders = dates.map(() => '?').join(',');
  const points = database.prepare(`
    SELECT date, marker_id, value, source
    FROM health_data_points
    WHERE source IN (${placeholders})
      AND COALESCE(excluded, 0) = 0
      AND date IN (${datePlaceholders})
    ORDER BY date DESC, marker_id ASC
  `).all(...LAB_TIMELINE_SOURCES, ...dates);
  const byDate = new Map(draws.map((row) => [row.date, {
    date: row.date,
    month: monthLabel(row.date),
    count: row.n,
    origin: 'import',
    markers: [],
  }]));
  for (const point of points) {
    const bucket = byDate.get(point.date);
    if (!bucket || bucket.markers.length >= 8) continue;
    bucket.markers.push({
      id: point.marker_id,
      label: markerLabel(point.marker_id),
      value: point.value,
      source: point.source,
    });
  }
  return [...byDate.values()];
}

function listUserFacts(database, { topic, limit }) {
  const rows = database.prepare(`
    SELECT id, event_date, source_type, event_type, summary, metadata
    FROM timeline_events
    WHERE source_type = 'user'
       OR event_type LIKE '%owner_attested%'
    ORDER BY event_date DESC, id DESC
    LIMIT ?
  `).all(Math.max(limit * 4, 80));
  const slug = String(topic || HEALTH_TOPIC_SLUG);
  const out = [];
  for (const row of rows) {
    let meta = {};
    try { meta = JSON.parse(row.metadata || '{}') || {}; } catch { meta = {}; }
    const factTopic = String(meta.topic || HEALTH_TOPIC_SLUG);
    if (row.source_type === 'user' && factTopic && factTopic !== slug) continue;
    out.push({
      id: row.id,
      date: String(row.event_date || '').slice(0, 10),
      month: monthLabel(row.event_date),
      origin: 'user',
      title: meta.title || row.summary,
      content: meta.content_excerpt || row.summary,
      source_type: row.source_type,
      event_type: row.event_type,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function listMedicationFacts(database, { limit }) {
  let rows = [];
  try {
    rows = listEffectiveMedicationsRaw(database);
  } catch {
    return [];
  }
  const out = [];
  for (const med of rows) {
    for (const change of [
      { date: med.date_started, verb: 'started' },
      { date: med.date_stopped, verb: 'stopped' },
    ]) {
      if (!change.date) continue;
      const details = [med.dose, med.frequency, med.status].filter(Boolean).join(', ');
      out.push({
        id: `med-${med.id}-${change.verb}`,
        date: String(change.date).slice(0, 10),
        month: monthLabel(change.date),
        origin: 'user',
        title: `${med.name} ${change.verb}`,
        content: clip(`${med.name} ${change.verb}${details ? `. ${details}` : ''}${med.notes ? `. ${med.notes}` : ''}`),
        source_type: 'curated_medications',
        event_type: 'medication_change',
      });
    }
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit);
}

/**
 * Health topic timeline for any user: attested facts, medications, and every lab draw.
 */
export function listHealthTopicTimeline(database = db, {
  topic = HEALTH_TOPIC_SLUG,
  limit = 60,
} = {}) {
  const cap = Math.min(200, Math.max(1, Number(limit) || 60));
  const coverage = ensureLabPointsOnTimeline(database);
  const facts = listUserFacts(database, { topic, limit: cap });
  const medications = listMedicationFacts(database, { limit: cap });
  const labs = listLabDraws(database, { limit: cap });
  return {
    topic: String(topic || HEALTH_TOPIC_SLUG),
    facts,
    medications,
    labs,
    coverage,
  };
}
