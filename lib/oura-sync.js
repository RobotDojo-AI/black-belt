/**
 * Oura Ring sync — pulls daily sleep, readiness, activity via Oura API v2.
 * Stores one row per metric per day in health_notes with source='oura'.
 * Token: Keychain key robotdojo-OURA_PAT (Personal Access Token).
 */
import db from './db.js';
import { secret } from './config.js';
import { insertTimelineEvent } from './timeline-schema.js';
import { healthDataPointSourceId } from './health-data-point-source.js';

const BASE = 'https://api.ouraring.com/v2/usercollection';

const MARKERS = {
  oura_sleep_score:    { name: 'Oura Sleep Score',     unit: 'score', group_id: 'sleep',  view: 'focus',   description: 'Oura nightly sleep score (0-100)' },
  oura_readiness:      { name: 'Oura Readiness',       unit: 'score', group_id: 'sleep',  view: 'focus',   description: 'Oura daily readiness score (0-100)' },
  oura_hrv:            { name: 'Oura HRV',             unit: 'ms',    group_id: 'sleep',  view: 'focus',   description: 'Average overnight heart rate variability (ms)' },
  oura_rhr:            { name: 'Oura RHR',             unit: 'bpm',   group_id: 'sleep',  view: 'focus',   description: 'Lowest heart rate during sleep (bpm)' },
  oura_deep_sleep:     { name: 'Oura Deep Sleep',      unit: 'min',   group_id: 'sleep',  view: 'summary', description: 'Deep sleep duration (minutes)' },
  oura_rem_sleep:      { name: 'Oura REM Sleep',       unit: 'min',   group_id: 'sleep',  view: 'summary', description: 'REM sleep duration (minutes)' },
  oura_total_sleep:    { name: 'Oura Total Sleep',     unit: 'hours', group_id: 'sleep',  view: 'focus',   description: 'Total sleep duration (hours)' },
  oura_efficiency:     { name: 'Oura Sleep Efficiency', unit: 'score', group_id: 'sleep', view: 'summary', description: 'Sleep efficiency score (0-100)' },
  oura_activity_score: { name: 'Oura Activity Score',  unit: 'score', group_id: 'vitals', view: 'summary', description: 'Oura daily activity score (0-100)' },
  oura_steps:          { name: 'Oura Steps',           unit: 'steps', group_id: 'vitals', view: 'all',     description: 'Total steps from Oura ring' },
};

const NOTE_METRIC_MARKERS = {
  sleep_score: 'oura_sleep_score',
  sleep_efficiency: 'oura_efficiency',
  hrv: 'oura_hrv',
  rhr: 'oura_rhr',
  deep_sleep: 'oura_deep_sleep',
  rem_sleep: 'oura_rem_sleep',
  total_sleep: 'oura_total_sleep',
  readiness_score: 'oura_readiness',
  activity_score: 'oura_activity_score',
  steps: 'oura_steps',
};

const insertMarker = db.prepare(`
  INSERT OR IGNORE INTO health_markers (id, name, unit, group_id, view, description)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function ensureOuraMarkers(markerIds) {
  db.prepare(`
    INSERT OR IGNORE INTO health_groups (id, name, description)
    VALUES
      ('sleep', 'Sleep', 'Sleep, recovery, HRV, and circadian rhythm'),
      ('vitals', 'Vitals', 'Blood pressure, heart rate, temperature')
  `).run();

  const tx = db.transaction((ids) => {
    for (const id of ids) {
      const marker = MARKERS[id];
      if (!marker) continue;
      insertMarker.run(id, marker.name, marker.unit, marker.group_id, marker.view, marker.description);
    }
  });
  tx([...new Set(markerIds)]);
}

function pad(date) {
  return date.toISOString().slice(0, 10);
}

function headers() {
  const token = secret('OURA_PAT') || secret('OURA_CLIENT_SECRET');
  if (!token) throw new Error('OURA_PAT not in Keychain — store via request_credential tool');
  return { Authorization: `Bearer ${token}` };
}

async function fetchCollection(path, startDate, endDate) {
  const rows = [];
  let nextToken = null;
  do {
    const url = new URL(`${BASE}/${path}`);
    url.searchParams.set('start_date', startDate);
    url.searchParams.set('end_date', endDate);
    if (nextToken) url.searchParams.set('next_token', nextToken);
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Oura ${path} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    rows.push(...(data.data || []));
    nextToken = data.next_token || null;
  } while (nextToken);
  return rows;
}

async function fetchOptionalCollection(path, startDate, endDate) {
  try {
    return await fetchCollection(path, startDate, endDate);
  } catch (err) {
    console.warn(`[oura-sync] optional ${path} metrics skipped: ${err.message}`);
    return [];
  }
}

const insertNote = db.prepare(`
  INSERT OR REPLACE INTO health_notes (date, content, tags, source, created_at)
  VALUES (?, ?, ?, 'oura', datetime('now'))
`);

const insertDataPoint = db.prepare(`
  INSERT INTO health_data_points
    (marker_id, date, value, source, source_file, source_id, specimen_type, excluded, exclude_reason, created_at)
  VALUES (?, ?, ?, 'oura_sync', 'oura-api', ?, 'wearable', 0, NULL, datetime('now'))
  ON CONFLICT(source_id) DO UPDATE SET
    value = excluded.value,
    source_file = excluded.source_file,
    specimen_type = excluded.specimen_type,
    excluded = 0,
    exclude_reason = NULL
`);

function upsertMetrics(rows) {
  const chartRows = rows
    .map(row => ({ ...row, markerId: NOTE_METRIC_MARKERS[row.metric] }))
    .filter(row => row.markerId && row.value != null && Number.isFinite(Number(row.value)));
  ensureOuraMarkers(chartRows.map(row => row.markerId));

  let chartPoints = 0;
  const tx = db.transaction((entries) => {
    for (const { date, metric, value, unit } of entries) {
      if (value == null) continue;
      const content = `${metric}: ${value}${unit ? ' ' + unit : ''}`;
      const tags = JSON.stringify(['oura', metric]);
      insertNote.run(date, content, tags);
      insertTimelineEvent({
        sourceType: 'oura',
        sourceId: `oura:${metric}:${date}`,
        eventDate: date,
        eventType: 'health_note',
        summary: content,
        content,
        metadata: { metric, tags: ['oura', metric] },
      });
    }

    for (const { date, value, markerId } of chartRows) {
      const rounded = Math.round(Number(value) * 100) / 100;
      const sourceId = healthDataPointSourceId({ source: 'oura_sync', markerId, date, value: rounded, sourceFile: 'oura-api' });
      const result = insertDataPoint.run(markerId, date, rounded, sourceId);
      if (result.changes > 0) chartPoints++;
    }
  });
  tx(rows);
  return { chartPoints };
}

function parseSleep(items) {
  return items.flatMap(item => {
    const date = item.day;
    return [
      { date, metric: 'sleep_score', value: item.score, unit: 'score' },
      { date, metric: 'sleep_total', value: item.contributors?.total_sleep, unit: 'score' },
      { date, metric: 'sleep_efficiency', value: item.contributors?.efficiency, unit: 'score' },
      { date, metric: 'sleep_rem', value: item.contributors?.rem_sleep, unit: 'score' },
      { date, metric: 'sleep_deep', value: item.contributors?.deep_sleep, unit: 'score' },
    ];
  });
}

function parseReadiness(items) {
  return items.flatMap(item => {
    const date = item.day;
    return [
      { date, metric: 'readiness_score', value: item.score, unit: 'score' },
      { date, metric: 'hrv_balance', value: item.contributors?.hrv_balance, unit: 'score' },
      { date, metric: 'resting_heart_rate', value: item.contributors?.resting_heart_rate, unit: 'bpm' },
      { date, metric: 'recovery_index', value: item.contributors?.recovery_index, unit: 'score' },
      { date, metric: 'body_temperature', value: item.contributors?.body_temperature, unit: 'score' },
    ];
  });
}

function parseActivity(items) {
  return items.flatMap(item => {
    const date = item.day;
    return [
      { date, metric: 'activity_score', value: item.score, unit: 'score' },
      { date, metric: 'steps', value: item.steps, unit: 'steps' },
      { date, metric: 'active_calories', value: item.active_calories, unit: 'kcal' },
      { date, metric: 'total_calories', value: item.total_calories, unit: 'kcal' },
    ];
  });
}

function parseSleepPeriods(items) {
  const byDay = new Map();
  for (const item of items) {
    const date = item.day || (item.bedtime_start ? String(item.bedtime_start).slice(0, 10) : null);
    if (!date) continue;
    if (!byDay.has(date)) byDay.set(date, { hrv: [], rhr: [], deepSec: 0, remSec: 0, totalSec: 0 });
    const day = byDay.get(date);
    if (Number(item.average_hrv) > 0) day.hrv.push(Number(item.average_hrv));
    if (Number(item.lowest_heart_rate) > 0) day.rhr.push(Number(item.lowest_heart_rate));
    day.deepSec += Number(item.deep_sleep_duration) || 0;
    day.remSec += Number(item.rem_sleep_duration) || 0;
    day.totalSec += Number(item.total_sleep_duration) || 0;
  }

  const avg = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const rows = [];
  for (const [date, day] of byDay) {
    if (day.hrv.length) rows.push({ date, metric: 'hrv', value: avg(day.hrv), unit: 'ms' });
    if (day.rhr.length) rows.push({ date, metric: 'rhr', value: Math.min(...day.rhr), unit: 'bpm' });
    if (day.deepSec > 0) rows.push({ date, metric: 'deep_sleep', value: Math.round(day.deepSec / 60), unit: 'min' });
    if (day.remSec > 0) rows.push({ date, metric: 'rem_sleep', value: Math.round(day.remSec / 60), unit: 'min' });
    if (day.totalSec > 0) rows.push({ date, metric: 'total_sleep', value: Math.round(day.totalSec / 360) / 10, unit: 'hours' });
  }
  return rows;
}

export async function syncOuraData(opts = {}) {
  const through = opts.through || new Date();
  const since = opts.since || new Date(Date.now() - 30 * 86400_000);
  const startDate = pad(since);
  const endDate = pad(through);

  const [sleepItems, readinessItems, activityItems, sleepPeriodItems] = await Promise.all([
    fetchCollection('daily_sleep', startDate, endDate),
    fetchCollection('daily_readiness', startDate, endDate),
    fetchCollection('daily_activity', startDate, endDate),
    fetchOptionalCollection('sleep', startDate, endDate),
  ]);

  const rows = [
    ...parseSleep(sleepItems),
    ...parseReadiness(readinessItems),
    ...parseActivity(activityItems),
    ...parseSleepPeriods(sleepPeriodItems),
  ];

  const { chartPoints } = upsertMetrics(rows);
  const synced = rows.filter(r => r.value != null).length;
  console.info(`[oura-sync] synced ${synced} metrics, ${chartPoints} chart points (${startDate} → ${endDate})`);
  db.prepare(`UPDATE accounts SET synced_at=datetime('now'), last_error=NULL WHERE vendor='oura'`).run();
  return { synced, chartPoints };
}

export async function syncOuraLatest() {
  return syncOuraData({ since: new Date(Date.now() - 7 * 86400_000) });
}
