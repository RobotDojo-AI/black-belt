/**
 * Daily Apple Health JSON importer (Health Auto Export / Shortcuts aggregates).
 *
 * Upserts into health_data_points with source='apple-health' using the same
 * source_id as the XML importer (marker + day), so a later pull for the same
 * day replaces values instead of duplicating.
 *
 * HAE shape: { data: { metrics: [ { name, units, data: [ { date, qty } ] } ] } }
 * FHIR clinical JSON is rejected — that path stays on importFhirClinicalRecords.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import db from './db.js';
import { recordIngestion, wasIngested } from './health-ingestion.js';
import { healthDataPointSourceId } from './health-data-point-source.js';
import { queueHealthIntelRegenerationIfChanged } from './health-intel-regeneration.js';
import { projectHealthDataPointBySourceId, ensureHealthPointsOnTimeline } from './health-timeline.js';
import {
  configForAppleMetric,
  convertAppleValue,
  MARKER_UNITS,
  roundAppleValue,
  sleepSamplesFromPoint,
} from './health-apple-canonical.js';

const SOURCE = 'apple-health';
const INGEST_SOURCE = 'apple-health-json';
const GROUP_ID = 'user_tracked';

function dayFromDate(raw) {
  const s = String(raw || '');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function sampleQty(point) {
  if (point == null || typeof point !== 'object') return null;
  const n = Number(
    point.qty
    ?? point.totalSleep
    ?? point.asleep
    ?? point.Avg
    ?? point.avg
    ?? point.systolic
    ?? point.value
    ?? point.max,
  );
  return Number.isFinite(n) ? n : null;
}

function extraPointValues(point) {
  const extras = [];
  if (point == null || typeof point !== 'object') return extras;
  const dia = Number(point.diastolic);
  if (Number.isFinite(dia)) extras.push({ suffix: 'diastolic', qty: dia });
  return extras;
}

function configForMetric(name, units) {
  return configForAppleMetric(name, units);
}

function convertValue(marker, value, units) {
  return convertAppleValue(marker, value, units);
}

export function isFhirJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.resourceType === 'string' && value.resourceType.length > 0) return true;
  if (Array.isArray(value.entry) && value.entry.some((e) => e?.resource?.resourceType)) return true;
  return false;
}

export function isHaeDailyJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (isFhirJson(value)) return false;
  if (Array.isArray(value.data?.metrics)) return true;
  if (Array.isArray(value.metrics)) return true;
  if (Array.isArray(value.data?.workouts)) return true;
  if (Array.isArray(value.workouts)) return true;
  return false;
}

function metricsFromPayload(payload) {
  if (Array.isArray(payload?.data?.metrics)) return payload.data.metrics;
  if (Array.isArray(payload?.metrics)) return payload.metrics;
  return [];
}

function workoutsFromPayload(payload) {
  if (Array.isArray(payload?.data?.workouts)) return payload.data.workouts;
  if (Array.isArray(payload?.workouts)) return payload.workouts;
  return [];
}

function ensureMarker(markerId, unit = '') {
  const existing = db.prepare('SELECT id FROM health_markers WHERE id = ?').get(markerId);
  if (existing) return;
  const name = markerId
    .replace(/^oura_/, 'Oura ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  db.prepare(`
    INSERT OR IGNORE INTO health_groups (id, name, description)
    VALUES (?, 'User Tracked', 'Manually tracked health metrics')
  `).run(GROUP_ID);
  db.prepare(`
    INSERT OR IGNORE INTO health_markers (id, name, unit, group_id)
    VALUES (?, ?, ?, ?)
  `).run(markerId, name, unit || MARKER_UNITS[markerId] || '', GROUP_ID);
}

const insertStmt = db.prepare(`
  INSERT INTO health_data_points (marker_id, date, value, source, source_file, source_id, excluded, exclude_reason, created_at, updated_at)
  VALUES (?, ?, ?, 'apple-health', ?, ?, 0, NULL, datetime('now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))
  ON CONFLICT(source_id) DO UPDATE SET
    updated_at = CASE
      WHEN ABS(health_data_points.value - excluded.value) > 1e-9
        OR health_data_points.source_file IS NOT excluded.source_file
      THEN excluded.updated_at
      ELSE health_data_points.updated_at
    END,
    value = excluded.value,
    source_file = excluded.source_file,
    excluded = 0,
    exclude_reason = NULL
`);

const getExisting = db.prepare('SELECT value FROM health_data_points WHERE source_id = ?');

function addSample(daily, cfg, date, qty, units) {
  const value = convertValue(cfg.marker, qty, units);
  const key = `${cfg.marker}|${date}`;
  const acc = daily[key];
  if (acc && acc.priority && !cfg.priority) return;
  if (acc && !acc.priority && cfg.priority) {
    daily[key] = { marker: cfg.marker, date, agg: cfg.agg, priority: true, sum: value, count: 1, last: value, units };
    return;
  }
  if (!acc) {
    daily[key] = { marker: cfg.marker, date, agg: cfg.agg, priority: !!cfg.priority, sum: value, count: 1, last: value, units };
    return;
  }
  acc.sum += value;
  acc.count += 1;
  acc.last = value;
}

function collectDaily(payload) {
  const daily = {};
  for (const metric of metricsFromPayload(payload)) {
    const units = metric.units || metric.unit || '';
    const cfg = configForMetric(metric?.name, units);
    const points = Array.isArray(metric.data) ? metric.data : [];
    const sleepMetric = cfg.marker === 'apple_sleep_total' || /sleep/.test(String(metric?.name || '').toLowerCase());
    for (const point of points) {
      const date = dayFromDate(point?.date);
      if (!date) continue;
      if (sleepMetric) {
        const sleepRows = sleepSamplesFromPoint(point, units);
        if (sleepRows.length) {
          for (const row of sleepRows) {
            addSample(daily, { marker: row.marker, agg: row.agg, units: row.units }, date, row.qty, row.units);
          }
          continue;
        }
      }
      const qty = sampleQty(point);
      if (qty != null) addSample(daily, cfg, date, qty, units);
      for (const extra of extraPointValues(point)) {
        addSample(daily, { ...cfg, marker: `${cfg.marker}_${extra.suffix}`, priority: false }, date, extra.qty, units);
      }
    }
  }
  for (const workout of workoutsFromPayload(payload)) {
    const date = dayFromDate(workout?.start || workout?.date || workout?.startDate);
    if (!date) continue;
    const seconds = Number(workout?.duration);
    const minutes = Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : 0;
    addSample(daily, { marker: 'workout_count', agg: 'sum' }, date, 1, 'count');
    if (minutes > 0) addSample(daily, { marker: 'workout_duration', agg: 'sum' }, date, minutes, 'min');
  }
  return Object.values(daily).map((acc) => {
    let raw;
    if (acc.agg === 'sum') raw = acc.sum;
    else if (acc.agg === 'avg') raw = acc.sum / acc.count;
    else raw = acc.last;
    const value = roundAppleValue(acc.marker, raw, acc.agg);
    return { marker: acc.marker, date: acc.date, value, priority: acc.priority, units: MARKER_UNITS[acc.marker] || acc.units || '' };
  });
}

export async function upsertAppleHealthDailyPayload(payload, { sourceFile = 'hae-rest.json' } = {}) {
  if (isFhirJson(payload)) {
    return { ok: false, inserted: 0, updated: 0, error: 'fhir_not_daily' };
  }
  if (!isHaeDailyJson(payload)) {
    return { ok: false, inserted: 0, updated: 0, error: 'not_daily_json' };
  }
  const rows = collectDaily(payload);
  let inserted = 0;
  let updated = 0;
  const txn = db.transaction(() => {
    for (const row of rows) {
      ensureMarker(row.marker, row.units);
      const sourceId = healthDataPointSourceId({
        source: SOURCE,
        markerId: row.marker,
        date: row.date,
        value: row.value,
      });
      const existing = getExisting.get(sourceId);
      insertStmt.run(row.marker, row.date, row.value, sourceFile, sourceId);
      projectHealthDataPointBySourceId(db, sourceId);
      if (!existing) inserted += 1;
      else if (Math.abs(Number(existing.value) - Number(row.value)) > 1e-9) updated += 1;
    }
  });
  txn();
  if (inserted + updated > 0) {
    ensureHealthPointsOnTimeline(db, { limit: 2000, sources: ['apple-health'] });
  }
  await recordIngestion({
    source: INGEST_SOURCE,
    path: `payload:${sourceFile}:${new Date().toISOString().slice(0, 10)}`,
    count: inserted + updated,
    status: inserted + updated > 0 || rows.length > 0 ? 'ok' : 'no_data',
    metadata: { inserted, updated, rows: rows.length, file: sourceFile },
  });
  queueHealthIntelRegenerationIfChanged({
    inserted: inserted + updated,
    reason: 'apple_health_import',
  });
  return { ok: true, inserted, updated, rows: rows.length };
}

export async function importAppleHealthDailyJson({ file, force = false } = {}) {
  const path = resolve(file);
  if (!existsSync(path)) {
    await recordIngestion({ source: INGEST_SOURCE, path, status: 'failed', error: 'file_not_found' });
    return { ok: false, inserted: 0, updated: 0, error: 'file_not_found', file: path };
  }

  const stat = statSync(path);
  const fingerprint = createHash('sha256').update(`${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 16);
  if (!force) {
    const prior = await wasIngested({ source: INGEST_SOURCE, path: fingerprint });
    if (prior) return { ok: true, inserted: 0, updated: 0, alreadyImported: true, file: path };
  }

  let payload;
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    await recordIngestion({ source: INGEST_SOURCE, path: fingerprint, status: 'failed', error: 'invalid_json' });
    return { ok: false, inserted: 0, updated: 0, error: 'invalid_json', file: path };
  }

  const sourceFile = path.split('/').pop() || 'daily.json';
  const r = await upsertAppleHealthDailyPayload(payload, { sourceFile });
  return { ...r, file: path, alreadyImported: false };
}
