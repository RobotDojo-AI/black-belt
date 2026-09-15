#!/usr/bin/env node
/**
 * Apple Health export.xml importer.
 *
 * Streams the XML line-by-line (handles 1GB+ files) and aggregates daily
 * values for steps, weight, heart rate, HRV, sleep, SpO2, body fat, and
 * blood glucose. Upserts daily aggregates by source_id so newer exports can
 * refresh prior days instead of silently preserving stale values.
 *
 * Usage:
 *   node scripts/import-apple-health-xml.js
 *   node scripts/import-apple-health-xml.js --file /path/to/export.xml
 *   node scripts/import-apple-health-xml.js --since 2024-01-01
 *   node scripts/import-apple-health-xml.js --dry-run
 *   node scripts/import-apple-health-xml.js --stats
 *   node scripts/import-apple-health-xml.js --force   (re-import even if already logged)
 */

import { createReadStream, statSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import db from '../lib/db.js';
import { recordIngestion, wasIngested } from '../lib/health-ingestion.js';
import { insertTimelineEvent } from '../lib/timeline-schema.js';
import { healthDataPointSourceId } from '../lib/health-data-point-source.js';
import { queueHealthIntelRegenerationIfChanged } from '../lib/health-intel-regeneration.js';

const DEFAULT_EXPORT_XML = join(homedir(), 'Library', 'Application Support', 'Apple Health', 'export.xml');

// ─── Apple Health type → marker mapping ─────────────────────────────────

const TYPE_MAP = {
  HKQuantityTypeIdentifierStepCount:                   { marker: 'steps',             agg: 'sum',  unit: 'count' },
  HKQuantityTypeIdentifierHeartRate:                   { marker: 'oura_rhr',           agg: 'avg',  unit: 'count/min' },
  HKQuantityTypeIdentifierRestingHeartRate:            { marker: 'oura_rhr',           agg: 'avg',  unit: 'count/min', priority: true },
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN:    { marker: 'oura_hrv',           agg: 'avg',  unit: 'ms' },
  HKQuantityTypeIdentifierBodyMass:                    { marker: 'weight',             agg: 'last', unit: 'lb' },
  HKQuantityTypeIdentifierOxygenSaturation:            { marker: 'spo2',              agg: 'avg',  unit: '%' },
  HKQuantityTypeIdentifierRespiratoryRate:             { marker: 'respiratory_rate',   agg: 'avg',  unit: 'count/min' },
  HKQuantityTypeIdentifierBodyFatPercentage:           { marker: 'body_fat',           agg: 'last', unit: '%' },
  HKQuantityTypeIdentifierBloodGlucose:                { marker: 'glucose',            agg: 'avg',  unit: 'mg/dL' },
};

// ─── Regex patterns ───────────────────────────────────────────────────────

const VALUE_RE  = /\bvalue="([^"]*)"/;
const UNIT_RE   = /\bunit="([^"]*)"/;
const TYPE_RE   = /\btype="([^"]*)"/;
const START_RE  = /\bstartDate="(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/;
const END_RE    = /\bendDate="(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/;

// ─── Marker auto-provisioning ─────────────────────────────────────────────

const GROUP_ID = 'user_tracked';

const MARKER_UNITS = {
  steps:            'count',
  oura_rhr:         'count/min',
  oura_hrv:         'ms',
  weight:           'lb',
  spo2:             '%',
  respiratory_rate: 'count/min',
  body_fat:         '%',
  glucose:          'mg/dL',
  oura_total_sleep: 'hours',
  oura_deep_sleep:  'min',
  oura_rem_sleep:   'min',
};

function ensureMarker(markerId) {
  const existing = db.prepare('SELECT id FROM health_markers WHERE id = ?').get(markerId);
  if (existing) return;

  const name = markerId
    .replace(/^oura_/, 'Oura ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  db.prepare(`
    INSERT OR IGNORE INTO health_groups (id, name, description)
    VALUES (?, 'User Tracked', 'Manually tracked health metrics')
  `).run(GROUP_ID);

  db.prepare(`
    INSERT OR IGNORE INTO health_markers (id, name, unit, group_id)
    VALUES (?, ?, ?, ?)
  `).run(markerId, name, MARKER_UNITS[markerId] || '', GROUP_ID);
}

// ─── DB insert (INSERT OR IGNORE — never overwrites existing rows) ────────

const insertStmt = db.prepare(`
  INSERT INTO health_data_points (marker_id, date, value, source, source_file, source_id, excluded, exclude_reason, created_at, updated_at)
  VALUES (?, ?, ?, 'apple-health', 'export.xml', ?, 0, NULL, datetime('now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))
  ON CONFLICT(source_id) DO UPDATE SET
    updated_at = CASE
      WHEN ABS(health_data_points.value - excluded.value) > 1e-9
        OR health_data_points.source_file IS NOT excluded.source_file
        OR COALESCE(health_data_points.excluded, 0) != 0
        OR health_data_points.exclude_reason IS NOT NULL
      THEN excluded.updated_at
      ELSE health_data_points.updated_at
    END,
    value = excluded.value,
    source_file = excluded.source_file,
    excluded = 0,
    exclude_reason = NULL
`);

const getExistingPoint = db.prepare(`
  SELECT value
  FROM health_data_points
  WHERE source_id = ?
`);

// ─── Duration parser ──────────────────────────────────────────────────────

function parseDurationMinutes(startDate, startTime, endDate, endTime) {
  const start = new Date(`${startDate}T${startTime}`);
  const end   = new Date(`${endDate}T${endTime}`);
  return (end - start) / 60000;
}

// ─── Main ─────────────────────────────────────────────────────────────────

/**
 * Import an Apple Health export.xml (HKQuantity time-series) into
 * health_data_points, in-process (controlled write path). Called by the
 * drop-folder health router when an export.xml is dropped, so the time-series
 * actually imports instead of just being archived. Returns a stats object;
 * never calls process.exit. st_fcdbe84f AC7.
 */
export async function importAppleHealthXml({ file = DEFAULT_EXPORT_XML, since = null, force = false, dryRun = false, statsOnly = false } = {}) {
  const EXPORT_XML = resolve(file);
  const SINCE_DATE = since;
  const DRY_RUN = dryRun;
  const STATS_ONLY = statsOnly;
  const FORCE = force;
  const recordAttempt = async ({ path, count = 0, status = 'ok', error = null, metadata = null } = {}) => {
    if (DRY_RUN || STATS_ONLY) return;
    try {
      await recordIngestion({ source: 'apple-health-xml', path, count, status, error, metadata });
    } catch (err) {
      console.warn(`[health] could not record Apple Health ingestion attempt: ${err.message}`);
    }
  };
  if (!existsSync(EXPORT_XML)) {
    await recordAttempt({ path: EXPORT_XML, status: 'failed', error: 'file_not_found' });
    return { ok: false, inserted: 0, error: 'file_not_found', file: EXPORT_XML };
  }
  const mode = DRY_RUN ? 'DRY RUN' : STATS_ONLY ? 'STATS' : 'IMPORT';
  console.log(`=== Apple Health XML ${mode} ===`);
  console.log(`File: ${EXPORT_XML}`);
  if (SINCE_DATE) console.log(`Since: ${SINCE_DATE}`);

  const stat = statSync(EXPORT_XML);
  const fileMb = (stat.size / 1024 / 1024).toFixed(1);
  console.log(`Size: ${fileMb} MB\n`);

  const fingerprint = createHash('sha256')
    .update(`${stat.size}:${stat.mtimeMs}`)
    .digest('hex').slice(0, 16);

  if (!DRY_RUN && !STATS_ONLY && !FORCE) {
    const prior = await wasIngested({ source: 'apple-health-xml', path: fingerprint });
    if (prior) {
      console.log(`Already imported on ${prior.created_at} (${prior.record_count} records)`);
      return { ok: true, inserted: 0, alreadyImported: true, file: EXPORT_XML };
    }
  }

  const stream = createReadStream(EXPORT_XML, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const dailyData = {};
  const sleepData = {};
  const typeCounts = {};
  let lineCount = 0, recordCount = 0, sleepRecordCount = 0;

  try {
    for await (const line of rl) {
      lineCount++;
      if (lineCount % 500_000 === 0) {
        process.stdout.write(`  ${(lineCount / 1_000_000).toFixed(1)}M lines...\r`);
      }

      const trimmed = line.trim();
      if (!trimmed.startsWith('<Record')) continue;

      if (trimmed.includes('SleepAnalysis')) {
        const valueMatch = VALUE_RE.exec(trimmed);
        const startMatch = START_RE.exec(trimmed);
        const endMatch   = END_RE.exec(trimmed);

        if (startMatch && endMatch && valueMatch) {
          const date = startMatch[1];
          if (SINCE_DATE && date < SINCE_DATE) { typeCounts.SleepAnalysis = (typeCounts.SleepAnalysis || 0) + 1; continue; }

          const SLEEP_VALUES = {
            HKCategoryValueSleepAnalysisAsleepCore:       'core',
            HKCategoryValueSleepAnalysisAsleepDeep:       'deep',
            HKCategoryValueSleepAnalysisAsleepREM:        'rem',
            HKCategoryValueSleepAnalysisAsleepUnspecified: 'unspecified',
          };
          const sleepType = SLEEP_VALUES[valueMatch[1]];
          if (sleepType) {
            const minutes = parseDurationMinutes(startMatch[1], startMatch[2], endMatch[1], endMatch[2]);
            if (minutes > 0 && minutes < 720) {
              if (!sleepData[date]) sleepData[date] = { deep: 0, rem: 0, core: 0, total: 0 };
              sleepData[date][sleepType] = (sleepData[date][sleepType] || 0) + minutes;
              sleepData[date].total += minutes;
              sleepRecordCount++;
            }
          }
        }
        typeCounts.SleepAnalysis = (typeCounts.SleepAnalysis || 0) + 1;
        continue;
      }

      const typeMatch = TYPE_RE.exec(trimmed);
      if (!typeMatch) continue;
      const type = typeMatch[1];
      typeCounts[type] = (typeCounts[type] || 0) + 1;

      const config = TYPE_MAP[type];
      if (!config) continue;

      const valueMatch = VALUE_RE.exec(trimmed);
      const startMatch = START_RE.exec(trimmed);
      if (!valueMatch || !startMatch) continue;

      const date = startMatch[1];
      if (SINCE_DATE && date < SINCE_DATE) continue;

      const value = parseFloat(valueMatch[1]);
      if (isNaN(value)) continue;

      const unitMatch = UNIT_RE.exec(trimmed);
      const unit = unitMatch ? unitMatch[1] : '';

      let finalValue = value;
      if (config.marker === 'weight' && unit === 'kg') {
        finalValue = Math.round(value * 2.20462 * 10) / 10;
      }
      if ((config.marker === 'body_fat' || config.marker === 'spo2') && value <= 1) {
        finalValue = Math.round(value * 100 * 10) / 10;
      }
      if (config.marker === 'glucose' && (unit === 'mmol/L' || unit === 'mmol<190>L')) {
        finalValue = Math.round(value * 18.0182 * 10) / 10;
      }

      const marker = config.marker;
      if (!dailyData[marker]) dailyData[marker] = {};
      if (!dailyData[marker][date]) dailyData[marker][date] = { sum: 0, count: 0, last: finalValue, priority: false };

      const acc = dailyData[marker][date];
      if (config.priority) {
        if (!acc.priority) { acc.sum = 0; acc.count = 0; }
        acc.priority = true;
      } else if (acc.priority) {
        continue;
      }

      acc.sum += finalValue;
      acc.count++;
      acc.last = finalValue;
      recordCount++;
    }
  } catch (err) {
    await recordAttempt({ path: fingerprint, status: 'failed', error: `xml_stream_failed: ${err.message}`, metadata: { lineCount } });
    return { ok: false, inserted: 0, error: `xml_stream_failed: ${err.message}`, file: EXPORT_XML };
  }

  console.log(`\nParsed ${lineCount.toLocaleString()} lines, ${recordCount.toLocaleString()} quantity records, ${sleepRecordCount.toLocaleString()} sleep records\n`);

  if (STATS_ONLY) {
    console.log('=== Record type counts ===');
    const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      console.log(`  ${String(count).padStart(8)}  ${type}`);
    }
    return { ok: true, inserted: 0, statsOnly: true, typeCounts };
  }

  let totalInserted = 0, totalUpdated = 0, totalUnchanged = 0, totalSkipped = 0;
  const markerCounts = {};

  const insertMany = db.transaction((entries) => {
    for (const [marker, date, value] of entries) {
      const sourceId = healthDataPointSourceId({ source: 'apple-health', markerId: marker, date, value });
      const existing = getExistingPoint.get(sourceId);
      const r = insertStmt.run(marker, date, value, sourceId);
      if (!existing && r.changes > 0) {
        totalInserted++;
        markerCounts[marker] = (markerCounts[marker] || 0) + 1;
        insertTimelineEvent({
          sourceType: 'apple-health',
          sourceId: `apple-health:${marker}:${date}`,
          eventDate: date,
          eventType: 'health_metric',
          summary: `${marker}: ${value}`,
          content: `${marker}:${value}`,
          metadata: { marker_id: marker, source_file: 'export.xml' },
        });
      } else if (existing && Math.abs(Number(existing.value) - Number(value)) > 1e-9) {
        totalUpdated++;
        markerCounts[marker] = (markerCounts[marker] || 0) + 1;
      } else if (existing) {
        totalUnchanged++;
      } else {
        totalSkipped++;
      }
    }
  });

  const batch = [];
  for (const [marker, dates] of Object.entries(dailyData)) {
    const agg = Object.values(TYPE_MAP).find(c => c.marker === marker)?.agg || 'avg';
    for (const [date, acc] of Object.entries(dates)) {
      let value;
      if (agg === 'sum')  value = Math.round(acc.sum);
      else if (agg === 'avg') value = Math.round(acc.sum / acc.count * 10) / 10;
      else value = acc.last;
      if (!DRY_RUN) batch.push([marker, date, value]);
      else { totalInserted++; markerCounts[marker] = (markerCounts[marker] || 0) + 1; }
    }
  }

  for (const [date, sleep] of Object.entries(sleepData)) {
    const totalHours = Math.round(sleep.total / 60 * 10) / 10;
    const deepMin = Math.round(sleep.deep);
    const remMin  = Math.round(sleep.rem);
    if (totalHours <= 0 || totalHours >= 16) continue;

    if (!DRY_RUN) {
      batch.push(['oura_total_sleep', date, totalHours]);
      if (deepMin > 0) batch.push(['oura_deep_sleep', date, deepMin]);
      if (remMin > 0)  batch.push(['oura_rem_sleep',  date, remMin]);
    } else {
      markerCounts.oura_total_sleep = (markerCounts.oura_total_sleep || 0) + 1;
      totalInserted++;
    }
  }

  if (!DRY_RUN && batch.length) {
    const markers = [...new Set(batch.map(b => b[0]))];
    for (const m of markers) ensureMarker(m);
    insertMany(batch);
  }

  console.log('=== Import summary ===');
  console.log(`Data points ${DRY_RUN ? 'would insert' : 'inserted'}: ${totalInserted.toLocaleString()}`);
  if (!DRY_RUN) console.log(`Data points refreshed: ${totalUpdated.toLocaleString()}`);
  if (!DRY_RUN) console.log(`Unchanged existing:    ${totalUnchanged.toLocaleString()}`);
  console.log(`Skipped (duplicates):  ${totalSkipped.toLocaleString()}`);

  if (Object.keys(markerCounts).length) {
    console.log('\nPer-marker:');
    for (const [m, c] of Object.entries(markerCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${m}: ${c.toLocaleString()} days`);
    }
  }

  if (!DRY_RUN) {
    await recordIngestion({
      source: 'apple-health-xml',
      path: fingerprint,
      count: totalInserted + totalUpdated,
      status: totalInserted + totalUpdated + totalUnchanged > 0 ? 'ok' : 'no_data',
      error: totalInserted + totalUpdated + totalUnchanged > 0 ? null : 'no_supported_records',
      metadata: { lineCount, recordCount, sleepRecordCount, totalInserted, totalUpdated, totalUnchanged, totalSkipped },
    });
    queueHealthIntelRegenerationIfChanged({
      inserted: totalInserted + totalUpdated,
      reason: 'apple_health_import',
    });
    const total = db.prepare('SELECT COUNT(*) as n FROM health_data_points WHERE excluded = 0').get();
    console.log(`\nTotal data points in DB: ${total.n.toLocaleString()}`);
  }
  return { ok: true, inserted: totalInserted, updated: totalUpdated, unchanged: totalUnchanged, skipped: totalSkipped, markers: markerCounts, file: EXPORT_XML };
}

// CLI entry — only when invoked directly (importing for the watcher must not run).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
  const fileArg = arg('--file');
  importAppleHealthXml({
    file: fileArg ? resolve(fileArg) : DEFAULT_EXPORT_XML,
    since: arg('--since'),
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
    statsOnly: args.includes('--stats'),
  })
    .then((r) => {
      if (r && r.ok === false) { console.error('Import failed:', r.error); process.exitCode = 1; }
    })
    .catch((err) => { console.error('Fatal:', err.message); process.exitCode = 1; });
}
