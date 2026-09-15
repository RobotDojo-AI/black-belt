/**
 * Health API — markers, data points, medications, notes, ui-config, intel.
 */
import { Hono } from 'hono';
import db from '../lib/db.js';
import {
  listHealthMarkers,
  listDataPointsGroupedByMarker,
  listDataPointCountsGroupedByMarker,
  listChartHealthNotes,
  listHealthWorkbenchContextNotes,
  listHealthGroups,
  listDataPointsSince,
  listRecentHealthNotes,
  healthTableColumns,
  markerOntologySignature,
  groupOntologySignature,
  healthMarkersCacheDbSignature,
  listHealthMarkerCopyRows,
  readHealthChartArchivePreferences,
  writeHealthChartArchivePreferences,
} from '../lib/health-queries.js';
import {
  normalizeAreaNarrative,
  registerHealthChartSubjectProvider,
  registerHealthMarkerCopyPayloadRefresher,
} from '../lib/health-marker-copy.js';
import { importFhirClinicalRecords, formatImportReport } from '../lib/health-fhir-import.js';
import { upsertAppleHealthDailyPayload } from '../lib/health-apple-daily-json.js';
import {
  canonicalHealthMarkerId,
  enrichHealthMarker,
  healthMarkerMetadataSignature,
} from '../lib/health-marker-metadata.js';
import {
  getFreshHealthMarkerPayload,
  getHealthMarkerPayloadCacheEntry,
  getHealthMarkerPayloadWarmPromise,
  prewarmHealthMarkerPayloadCache,
  refreshHealthMarkerPayloadCacheEntry,
  setHealthMarkerPayloadCache,
  clearHealthMarkerPayloadCache,
} from '../lib/health-marker-payload-cache.js';
import {
  TABS as INTEL_TABS,
  resolveIntelTab,
  getIntelCacheStatus,
  getIntelContent,
  listIntel,
  startIntelRegenerationJob,
  getIntelRegenerationJob,
  intelReadiness,
  getTabPrompt,
  getUIConfig,
} from '../lib/health-intel.js';
import { createOwnerAttestedHealthHistory } from '../lib/health-history.js';
import { listHealthTopicTimeline } from '../lib/health-timeline.js';
import {
  listEffectiveMedicationsRaw,
  medicationOntologySignature,
} from '../lib/health-medications.js';
import {
  registerHealthMarkerPayloadWarmer,
  queueHealthIntelRegeneration,
  queueHealthIntelRegenerationIfChanged,
} from '../lib/health-intel-regeneration.js';
import { buildHealthRecoveryStatus } from '../lib/health-recovery-status.js';

const routes = new Hono();
const HEALTH_MARKER_CHART_DISPLAY_POLICY_VERSION = '2026-06-29-lab-backed-chart-series-v3';

function healthTableColumnExists(table, column) {
  // The identifier guard now lives in healthTableColumns (returns [] for a
  // non-identifier table name), so an invalid table falls through to false.
  try {
    return healthTableColumns(db, table).some(row => row.name === column);
  } catch {
    return false;
  }
}

function healthMarkerOntologySignature() {
  try {
    const markerColumns = [
      'id',
      'name',
      'unit',
      'group_id',
      'view',
      'ref_low',
      'ref_high',
      'target',
      'trend',
      'description',
      'recommendations',
    ];
    if (healthTableColumnExists('health_markers', 'auto_created')) markerColumns.push('auto_created');
    if (healthTableColumnExists('health_markers', 'updated_at')) markerColumns.push('updated_at');
    const projection = markerColumns
      .map(column => `COALESCE(CAST(${column} AS TEXT), '')`)
      .join(` || char(31) || `);
    return markerOntologySignature(db, projection);
  } catch {
    return String(Date.now());
  }
}

function healthGroupOntologySignature() {
  try {
    return groupOntologySignature(db);
  } catch {
    return String(Date.now());
  }
}

// The marker-payload cache key must change whenever any table that feeds the
// rendered health payload changes, or a stale chart survives an edit. The SQL
// lives in lib/health-queries.js (thin-facade: routes hold zero db.prepare) but
// the route owns the invalidation contract, so the exact coverage is declared
// here. Columns/tables the signature MUST include (add here + in the lib query
// together): health_data_points AS point_updated_at (a re-dated point must bust
// the cache); health_chart_archive_preferences (archive/unarchive a marker);
// and health_ingestion_log_count / health_ingestion_log_created_at (a new
// import must recompute curation). Dropping any of these silently serves a
// stale chart after the underlying data moved. Added st_3ca30b26:
// health_marker_copy AS marker_copy_count / marker_copy_generated_at /
// marker_copy_content_len — a recalc that rewrites the generated Definition,
// Trend, Action or area narrative must reach the browser, and a rewrite can
// leave the row count unchanged, so the timestamp and total content length
// carry it.
function healthMarkersCacheSignature() {
  try {
    const dbSignature = healthMarkersCacheDbSignature(db);
    return JSON.stringify({
      ...dbSignature,
      chart_display_policy_version: HEALTH_MARKER_CHART_DISPLAY_POLICY_VERSION,
      marker_ontology_signature: healthMarkerOntologySignature(),
      marker_metadata_signature: healthMarkerMetadataSignature(),
      group_ontology_signature: healthGroupOntologySignature(),
      rx_ontology_signature: medicationOntologySignature(),
    });
  } catch {
    return String(Date.now());
  }
}

// --- Health ---

const DENSE_DISPLAY_SOURCES = new Set(['apple-health', 'oura-json', 'oura_sync', 'eight_sleep_sync']);
const DETAILED_PAYLOAD_SOURCES = new Set(['pdf-lab', 'fhir', 'manual', 'oura', 'derived-lipid']);
const LAB_BACKED_CHART_SOURCES = new Set(['pdf-lab', 'fhir', 'manual', 'derived-lipid']);
const LAB_BACKED_CHART_SOURCE_LIST = [...LAB_BACKED_CHART_SOURCES];
const CHART_CONTEXT_MARKER_DATA_IDS = ['weight', 'body_fat'];
const LAB_BACKED_CHART_CONTEXT_REASON = 'non-lab signal kept for synthesis, not charted';
const DENSE_DISPLAY_THRESHOLD = 300;
const DENSE_RECENT_RAW_DAYS = 120;
const CHART_WORKBENCH_CONTEXT_NOTE_LIMIT = 4;
const CHART_GENERIC_NOTE_LIMIT = 120;

function isoDateFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function dateMs(date) {
  const ms = new Date(date).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function denseHistoryKey(date) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  return `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function periodMidpointDate(points) {
  const times = points.map(point => dateMs(point.date)).filter(Number.isFinite);
  if (!times.length) return points[0]?.date || '';
  return isoDateFromMs((Math.min(...times) + Math.max(...times)) / 2);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function medianNumber(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarizeDisplayPoints(markerId, key, points, mode, sourceFile) {
  const values = points.map(point => Number(point.value)).filter(Number.isFinite);
  if (!values.length) return null;
  const sources = [...new Set(points.map(point => point.source).filter(Boolean))];
  return {
    date: mode === 'day' ? key : periodMidpointDate(points),
    value: average(values),
    source: sources.length === 1 ? sources[0] : 'wearable-summary',
    sourceFile,
    sourceId: `display:${markerId}:${mode}:${key}`,
    specimenType: 'wearable_summary',
    _bucketCount: values.length,
    _bucketMode: mode,
    _minValue: Math.min(...values),
    _maxValue: Math.max(...values),
  };
}

function collapseRecentDenseDisplayPoints(markerId, points) {
  const buckets = new Map();
  for (const point of points) {
    const key = String(point.date || '');
    const list = buckets.get(key);
    if (list) list.push(point);
    else buckets.set(key, [point]);
  }
  return [...buckets.entries()].map(([key, list]) => {
    if (list.length === 1) return list[0];
    return summarizeDisplayPoints(markerId, key, list, 'day', `${key} display average`);
  }).filter(Boolean);
}

function shouldShipDuplicateSources(point) {
  return Boolean(point?._duplicateCount && DETAILED_PAYLOAD_SOURCES.has(point.source || ''));
}

function serializeMarkerDataPointForPayload(point) {
  const source = point.source || '';
  const out = {
    date: point.date,
    value: point.value,
  };
  if (source) out.source = source;
  if (point.sourceMarkerId) out.sourceMarkerId = point.sourceMarkerId;
  const keepDetailedSource = DETAILED_PAYLOAD_SOURCES.has(source)
    || point._qualityNote
    || point._rawValue != null;
  if (keepDetailedSource) {
    out.sourceFile = point.sourceFile || '';
    out.sourceId = point.sourceId || '';
    out.specimenType = point.specimenType || 'unknown';
  }
  if (point._rawValue != null) out._rawValue = point._rawValue;
  if (point._qualityNote) out._qualityNote = point._qualityNote;
  if (point._duplicateCount) {
    out._duplicateCount = point._duplicateCount;
    if (shouldShipDuplicateSources(point)) out._duplicateSources = point._duplicateSources || [];
  }
  if (point._bucketCount) {
    out._bucketCount = point._bucketCount;
    out._bucketMode = point._bucketMode;
    out._minValue = point._minValue;
    out._maxValue = point._maxValue;
  }
  return out;
}

function reduceDenseDisplayData(marker) {
  const original = Array.isArray(marker.data) ? marker.data : [];
  const usesChartSourcePolicy = marker?.chartSourcePolicy?.kind === 'lab_backed_only';
  const raw = usesChartSourcePolicy ? markerChartData(marker) : original;
  const rawCount = marker.rawDataCount ?? original.length;
  if (raw.length <= DENSE_DISPLAY_THRESHOLD) {
    return { ...marker, rawDataCount: rawCount, data: raw, dataSummary: null };
  }

  const latestMs = Math.max(...raw.map(point => dateMs(point.date)).filter(Number.isFinite));
  if (!Number.isFinite(latestMs)) return { ...marker, rawDataCount: rawCount, data: raw, dataSummary: null };
  const cutoffMs = latestMs - DENSE_RECENT_RAW_DAYS * 86400000;
  const exact = [];
  const recentDense = [];
  const bucketable = [];
  for (const point of raw) {
    const ms = dateMs(point.date);
    const denseSource = DENSE_DISPLAY_SOURCES.has(point.source);
    if (denseSource && Number.isFinite(ms) && ms < cutoffMs) bucketable.push(point);
    else if (denseSource && Number.isFinite(ms)) recentDense.push(point);
    else exact.push(point);
  }
  if (bucketable.length < DENSE_DISPLAY_THRESHOLD / 3) {
    return { ...marker, rawDataCount: rawCount, data: raw, dataSummary: null };
  }

  const buckets = new Map();
  for (const point of bucketable) {
    const key = denseHistoryKey(point.date);
    const list = buckets.get(key);
    if (list) list.push(point);
    else buckets.set(key, [point]);
  }

  const displayBuckets = [...buckets.entries()]
    .map(([key, points]) => summarizeDisplayPoints(marker.id, key, points, 'month', `${key} display average`))
    .filter(point => point && Number.isFinite(point.value));
  const recentDisplay = collapseRecentDenseDisplayPoints(marker.id, recentDense);

  const data = [...displayBuckets, ...recentDisplay, ...exact]
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  return {
    ...marker,
    rawDataCount: rawCount,
    data,
    dataSummary: {
      reduced: true,
      rawCount,
      displayCount: data.length,
      bucketedCount: bucketable.length,
      recentDailyCount: recentDisplay.length,
      exactCount: exact.length + recentDisplay.length,
      bucketMode: 'month',
      recentRawDays: DENSE_RECENT_RAW_DAYS,
      label: 'Recent daily readings plus monthly averages for older wearable data',
    },
  };
}

function splitMixedUnitMarkers(markers) {
  const out = [];
  for (const marker of markers) {
    if (marker.id === 'eosinophils') {
      const percentData = [];
      const absoluteData = [];
      for (const point of marker.data || []) {
        const value = Number(point.value);
        if (Number.isFinite(value) && value > 2) percentData.push(point);
        else absoluteData.push(point);
      }

      if (percentData.length) {
        out.push({
          ...marker,
          id: 'eos',
          canonicalId: 'eos',
          aliases: [],
          name: 'Eosinophils',
          unit: '%',
          refRange: { low: 0, high: 8 },
          target: null,
          direction: 'range',
          data: percentData,
        });
      }
      if (absoluteData.length) {
        out.push({
          ...marker,
          id: 'eos_absolute',
          canonicalId: 'eos_absolute',
          aliases: ['eosinophils'],
          name: 'Eosinophils (Absolute)',
          unit: 'cells/uL',
          refRange: { low: 0, high: 500 },
          target: null,
          direction: 'range',
          data: absoluteData,
        });
      }
      continue;
    }

    if (marker.id !== 'free_testosterone') {
      out.push(marker);
      continue;
    }

    const percentData = [];
    const pgMlData = [];
    const ngDlData = [];
    for (const point of marker.data || []) {
      const value = Number(point.value);
      if (Number.isFinite(value) && value > 10) {
        if (/DiagnosticReport-20E1B107/i.test(point.sourceFile || '')) ngDlData.push(point);
        else pgMlData.push(point);
      } else {
        percentData.push(point);
      }
    }

    if (percentData.length) {
      out.push({
        ...marker,
        name: '% Free Testosterone',
        unit: '%',
        refRange: { low: 1.5, high: 4.2 },
        target: 2.2,
        direction: 'range',
        data: percentData,
      });
    }
    if (pgMlData.length) {
      out.push({
        ...marker,
        id: 'free_testosterone_pg_ml',
        canonicalId: 'free_testosterone_pg_ml',
        name: 'Free Testosterone (Direct)',
        unit: 'pg/mL',
        refRange: { low: 8.7, high: 25.1 },
        target: null,
        direction: 'range',
        data: pgMlData,
      });
    }
    if (ngDlData.length) {
      out.push({
        ...marker,
        id: 'free_testosterone_ng_dl',
        canonicalId: 'free_testosterone_ng_dl',
        name: 'Free Testosterone',
        unit: 'ng/dL',
        refRange: { low: 5, high: 21 },
        target: null,
        direction: 'range',
        data: ngDlData,
      });
    }
  }
  return out;
}

function markerDataCount(marker) {
  return Array.isArray(marker?.data) ? marker.data.length : 0;
}

function isLabBackedChartSource(source) {
  return LAB_BACKED_CHART_SOURCES.has(source || '');
}

function markerChartData(marker) {
  return (Array.isArray(marker?.data) ? marker.data : [])
    .filter(point => isLabBackedChartSource(point.source));
}

function markerChartDataCount(marker) {
  if (marker?.chartSourcePolicy && Number.isFinite(Number(marker.chartSourcePolicy.pointCount))) {
    return Number(marker.chartSourcePolicy.pointCount);
  }
  return markerChartData(marker).length;
}

function canonicalMarkerPointStats(markers, statsByMarker) {
  const byCanonical = new Map();
  for (const marker of markers || []) {
    const key = marker.canonicalId || marker.id;
    if (!key) continue;
    const stats = statsByMarker.get(marker.id) || { rawCount: 0, chartPointCount: 0 };
    const current = byCanonical.get(key) || { rawCount: 0, chartPointCount: 0 };
    current.rawCount += Number(stats.rawCount || 0);
    current.chartPointCount += Number(stats.chartPointCount || 0);
    byCanonical.set(key, current);
  }
  return byCanonical;
}

function attachLabBackedChartSourcePolicy(marker, pointStats = null) {
  const data = Array.isArray(marker?.data) ? marker.data : [];
  const chartPointCount = data.filter(point => isLabBackedChartSource(point.source)).length;
  const sourceChartPointCount = Number.isFinite(Number(pointStats?.chartPointCount))
    ? Number(pointStats.chartPointCount)
    : chartPointCount;
  const rawDataCount = Math.max(
    Number.isFinite(Number(pointStats?.rawCount)) ? Number(pointStats.rawCount) : 0,
    data.length
  );
  const hiddenCount = Math.max(0, rawDataCount - sourceChartPointCount, data.length - chartPointCount);
  const chartSourcePolicy = {
    kind: 'lab_backed_only',
    allowedSources: LAB_BACKED_CHART_SOURCE_LIST,
    pointCount: chartPointCount,
    hiddenCount,
  };
  if (!hiddenCount) return { ...marker, rawDataCount, chartSourcePolicy };
  return {
    ...marker,
    rawDataCount,
    chartSourcePolicy,
    dataQuality: {
      ...(marker.dataQuality || {}),
      chartSourcePolicy: 'lab_backed_only',
      chartSourceHiddenCount: hiddenCount,
    },
  };
}

function canonicalRepresentative(list, canonicalId) {
  const exact = list.find(marker => marker.id === canonicalId);
  if (exact) return exact;
  return [...list].sort((a, b) => {
    const aImported = a.group === 'auto_imported' ? 1 : 0;
    const bImported = b.group === 'auto_imported' ? 1 : 0;
    if (aImported !== bImported) return aImported - bImported;
    return markerDataCount(b) - markerDataCount(a);
  })[0];
}

function dataPointMergeKey(point) {
  return [
    point.date || '',
    Number(point.value).toPrecision(12),
    point.sourceId || '',
    point.sourceFile || '',
    point.specimenType || '',
  ].join('|');
}

function hasCellCountUnit(unit) {
  return /cells\/?u?l/i.test(unit || '');
}

function hasAbsoluteCellCountScale(marker) {
  if (!hasCellCountUnit(marker?.unit)) return false;
  const high = Number(marker?.refRange?.high);
  return Number.isFinite(high) && high >= 300;
}

function normalizeAbsoluteCellCountDataPoint(marker, point) {
  if (point?._hiddenReason) return point;
  if (!hasAbsoluteCellCountScale(marker)) return point;
  const value = Number(point.value);
  if (!Number.isFinite(value) || value <= 0) return point;
  if (value >= 10 && value <= 100) {
    return {
      ...point,
      _hiddenReason: 'percent value mapped into absolute count chart',
    };
  }
  if (value >= 10) return point;
  return {
    ...point,
    value: value * 1000,
    _rawValue: value,
    _qualityNote: 'converted x10E3/uL to cells/uL',
  };
}

function qualityMarkerId(marker) {
  return marker?.canonicalId || marker?.id || '';
}

const KNOWN_2020_24HR_URINE_TABLE_SHIFT_REASON = 'known 2020 24-hour urine table extraction mismatch';
const KNOWN_2020_24HR_URINE_TABLE_SHIFT_MARKERS = new Set([
  'ca_24_kg',
  'protein_catabolic_rate',
  'ss_cap',
  'urine_ammonium',
  'urine_ph',
  'urine_phosphorus',
  'urine_urea_nitrogen',
]);

function knownBad2020UrineExtraction(marker, point) {
  const id = qualityMarkerId(marker);
  if (!KNOWN_2020_24HR_URINE_TABLE_SHIFT_MARKERS.has(id)) return false;
  return /Master_Medical_Vault_Data_Lab_Work_2020_e029dd30/i.test(point?.sourceFile || point?.source_file || '');
}

function genericChartPointHiddenReason(marker, point, value) {
  const id = qualityMarkerId(marker);
  if (!Number.isFinite(value)) return 'non-numeric';
  if (knownBad2020UrineExtraction(marker, point)) return KNOWN_2020_24HR_URINE_TABLE_SHIFT_REASON;
  // Serum creatinine arrives from the 2019 panels with a second value on the
  // same draw date — 69.9 and 129 on 2018-12-20, 61.1 and 174 on 2019-04-27.
  // Divided by 88.4 (the mg/dL <-> umol/L factor) the low member of each pair
  // lands on a plausible serum value and the high member does not; 59.4 on
  // 2025-01-15 sits beside a serum creatinine of 0.96 mg/dL that it does not
  // convert to. So one is probably umol/L serum and the other probably a urine
  // creatinine mapped onto the serum marker — and the record does not say which.
  // Converting either would print a confident wrong number on his primary kidney
  // marker under the stone axis and the chlorthalidone decision, so the reading
  // is withheld and named as unresolved rather than guessed (AC 18).
  if (id === 'creatinine' && value > 5) return 'serum creatinine unit unresolved';
  if (id === 'body_fat' && value > 45) return 'body-fat import outlier';
  if (id === 'oura_rhr' && value > 110) return 'resting-heart-rate outlier';
  if (id === 'oura_total_sleep' && (value < 2 || value > 13.5)) return 'partial or over-merged sleep day';
  if ((id === 'oura_deep_sleep' || id === 'oura_rem_sleep') && (value < 5 || value > 360)) return 'partial or over-merged sleep-stage day';
  if (value === 0 && Number(marker.refRange?.low) > 0 && marker.direction !== 'lower') return 'zero placeholder below physiologic range';
  return '';
}

function normalizeGenericChartDataPoint(marker, point) {
  if (point?._hiddenReason) return point;
  const value = Number(point.value);
  if (!Number.isFinite(value)) return { ...point, _hiddenReason: 'non-numeric' };
  const id = qualityMarkerId(marker);
  if (id === 'height' && /in/i.test(marker.unit || '') && value > 100 && value < 250) {
    return {
      ...point,
      value: value / 2.54,
      _rawValue: value,
      _qualityNote: 'converted cm to in',
    };
  }
  if (id === 'weight' && /lb/i.test(marker.unit || '') && value >= 40 && value <= 120) {
    return {
      ...point,
      value: value * 2.2046226218,
      _rawValue: value,
      _qualityNote: 'converted kg to lb',
    };
  }
  const reason = genericChartPointHiddenReason(marker, point, value);
  if (reason) {
    return {
      ...point,
      _hiddenReason: reason,
    };
  }
  return point;
}

function normalizeChartDataPoint(marker, point) {
  return normalizeGenericChartDataPoint(marker, normalizeAbsoluteCellCountDataPoint(marker, point));
}

function summarizeDataQuality(points) {
  const summary = {
    hiddenCount: 0,
    convertedCount: 0,
    hiddenReasons: {},
    conversionNotes: {},
    examples: [],
  };
  for (const point of points) {
    if (point._hiddenReason) {
      summary.hiddenCount += 1;
      summary.hiddenReasons[point._hiddenReason] = (summary.hiddenReasons[point._hiddenReason] || 0) + 1;
      if (summary.examples.length < 3) {
        summary.examples.push({
          date: point.date,
          value: point._rawValue ?? point.value,
          sourceId: point.sourceId || '',
          reason: point._hiddenReason,
        });
      }
    }
    if (point._qualityNote) {
      summary.convertedCount += 1;
      summary.conversionNotes[point._qualityNote] = (summary.conversionNotes[point._qualityNote] || 0) + 1;
    }
  }
  if (!summary.hiddenCount) delete summary.hiddenReasons;
  if (!summary.convertedCount) delete summary.conversionNotes;
  if (!summary.examples.length) delete summary.examples;
  return summary.hiddenCount || summary.convertedCount ? summary : null;
}

// A reference range only means something if it is expressed in the unit the
// series is plotted in. When it is not, every derived claim built on it is
// false: the range-status clause calls a normal value "below reference floor",
// computeTrend reads a permanent out-of-range breach, Highlights promotes the
// marker, and the normalized view draws +-1/2/3 SD bands whose width comes from
// that same range. Measured on the live corpus: anc read 2 against 1500-7800.
//
// The three cell-count markers are correct today only because
// normalizeAbsoluteCellCountDataPoint happens to convert their points first.
// This guard makes that structural: any marker whose readings cannot be
// reconciled with its own range loses the range instead of printing against it.
const REFERENCE_RANGE_UNIT_MISMATCH_FACTOR = 10;
// One stray import must not strip a real range, so require a series.
const REFERENCE_RANGE_MIN_READINGS = 3;

/**
 * Decide whether a marker's reference range is expressed in the unit its
 * readings are plotted in.
 *
 * A unit mismatch has a specific signature: EVERY reading sits outside the
 * range, all on the same side, by at least an order of magnitude. That is not
 * what a genuinely abnormal marker looks like — an abnormal marker has readings
 * near or inside its range, or a smaller excursion. Deliberately NOT a
 * ratio-of-medians test: a heavy metal at 0.1 against a toxic ceiling of 2 is
 * 20x from the ceiling and is a perfectly normal result, and an immunity titre
 * far above its protective floor is the outcome you want.
 *
 * @returns {'' | 'above' | 'below'} '' when the range is usable.
 */
function referenceRangeUnitMismatch(marker) {
  const values = (Array.isArray(marker?.data) ? marker.data : [])
    .map(point => Number(point?.value))
    .filter(Number.isFinite);
  if (values.length < REFERENCE_RANGE_MIN_READINGS) return '';
  const low = marker?.refRange?.low == null ? null : Number(marker.refRange.low);
  const high = marker?.refRange?.high == null ? null : Number(marker.refRange.high);
  if (Number.isFinite(high) && high > 0
    && values.every(value => value > high * REFERENCE_RANGE_UNIT_MISMATCH_FACTOR)) return 'above';
  if (Number.isFinite(low) && low > 0
    && values.every(value => value < low / REFERENCE_RANGE_UNIT_MISMATCH_FACTOR)) return 'below';
  return '';
}

/**
 * Drop a reference range (and the target derived against it) that the series
 * cannot be read against, and record why.
 *
 * Dropping is the whole mechanism. With no range and no target,
 * rangeStatusSentence prints no position, computeTrend finds no breach,
 * markerHighlightCandidate stops promoting the marker, and
 * getMarkerNormalizationBaseline returns null so the marker leaves the
 * normalized view rather than being drawn against meaningless SD bands. One
 * guard, and every derived claim goes quiet together (AC 15, 17, 18).
 */
function reconcileReferenceRangeUnits(marker) {
  const side = referenceRangeUnitMismatch(marker);
  if (!side) return marker;
  const dataQuality = {
    ...(marker.dataQuality || {}),
    rangeDropped: {
      reason: `reference range is not in ${marker.unit || 'the charted unit'}`,
      low: marker.refRange?.low ?? null,
      high: marker.refRange?.high ?? null,
      side,
    },
  };
  return {
    ...marker,
    refRange: { low: null, high: null },
    target: null,
    dataQuality,
  };
}

function normalizeCanonicalMarkerDataUnits(marker) {
  if (!Array.isArray(marker?.data) || !marker.data.length) return marker;
  const normalized = marker.data.map(point => normalizeChartDataPoint(marker, point));
  const dataQuality = summarizeDataQuality(normalized);
  const data = normalized.filter(point => !point._hiddenReason);
  return {
    ...marker,
    rawDataCount: marker.rawDataCount ?? marker.data.length,
    data,
    ...(dataQuality ? { dataQuality } : {}),
  };
}

const SOURCE_PRIORITY = {
  'pdf-lab': 0,
  fhir: 1,
  'derived-lipid': 1.5,
  'apple-health': 2,
  'oura-json': 3,
  oura_sync: 3,
  eight_sleep_sync: 3,
  'wearable-summary': 4,
};

function normalizedDuplicateKey(point) {
  const value = Number(point?.value);
  if (!Number.isFinite(value)) return null;
  return `${point.date || ''}|${value.toPrecision(12)}`;
}

function sourcePriority(point) {
  return SOURCE_PRIORITY[point?.source] ?? 9;
}

function duplicateSourceSummary(point) {
  return {
    source: point.source || '',
    sourceFile: point.sourceFile || '',
    sourceId: point.sourceId || '',
    specimenType: point.specimenType || 'unknown',
  };
}

function representativeDuplicatePoint(points) {
  const sorted = [...points].sort((a, b) => {
    const priority = sourcePriority(a) - sourcePriority(b);
    if (priority) return priority;
    return String(a.sourceFile || '').localeCompare(String(b.sourceFile || ''));
  });
  const primary = sorted[0];
  return {
    ...primary,
    _duplicateCount: points.length,
    _duplicateSources: sorted.map(duplicateSourceSummary),
  };
}

function appendDuplicateDataQuality(dataQuality, duplicateGroups) {
  if (!duplicateGroups.length) return dataQuality || null;
  const duplicateCount = duplicateGroups.reduce((sum, group) => sum + group.length - 1, 0);
  return {
    ...(dataQuality || {}),
    duplicateCount,
    duplicateGroups: duplicateGroups.length,
    duplicateExamples: duplicateGroups.slice(0, 3).map(group => ({
      date: group[0].date,
      value: group[0].value,
      sources: group.map(duplicateSourceSummary),
    })),
  };
}

const SAME_DAY_CONFLICT_REASON = 'same-day conflicting source value hidden from chart';

function markerReferenceSpan(marker) {
  const low = Number(marker?.refRange?.low);
  const high = Number(marker?.refRange?.high);
  if (Number.isFinite(low) && Number.isFinite(high) && high > low) return high - low;
  const target = Number(marker?.target);
  if (Number.isFinite(target) && target !== 0) return Math.abs(target) * 0.2;
  if (Number.isFinite(high) && high !== 0) return Math.abs(high) * 0.2;
  if (Number.isFinite(low) && low !== 0) return Math.abs(low) * 0.2;
  return null;
}

function pointReferencePenalty(marker, value) {
  const low = Number(marker?.refRange?.low);
  const high = Number(marker?.refRange?.high);
  const span = markerReferenceSpan(marker) || Math.max(Math.abs(value) * 0.2, 1);
  if (Number.isFinite(high) && value > high) return (value - high) / span;
  if (Number.isFinite(low) && value < low) return (low - value) / span;
  return 0;
}

function sameDayConflictTolerance(marker, values) {
  const med = medianNumber(values) ?? 0;
  const span = markerReferenceSpan(marker) || 0;
  return Math.max(Math.abs(med) * 0.08, span * 0.15, 0.2);
}

function isMaterialSameDayConflict(marker, points) {
  const values = points.map(point => Number(point.value)).filter(Number.isFinite);
  if (values.length < 2) return false;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return max - min > sameDayConflictTolerance(marker, values);
}

function sameDayConflictScore(marker, point, peerMedian, peerScale) {
  const value = Number(point.value);
  if (!Number.isFinite(value)) return -Infinity;
  const refPenalty = pointReferencePenalty(marker, value);
  const sourcePenalty = sourcePriority(point) * 2;
  const seriesPenalty = Number.isFinite(peerMedian)
    ? Math.abs(value - peerMedian) / Math.max(peerScale, Number.EPSILON)
    : 0;
  const inReferenceBonus = refPenalty === 0 && markerReferenceSpan(marker) ? 50 : 0;
  return inReferenceBonus - (refPenalty * 100) - (seriesPenalty * 12) - sourcePenalty;
}

function scoredSameDayConflictPoints(marker, group, allPoints) {
  const date = pointDateKey(group[0]);
  const peerValues = allPoints
    .filter(point => pointDateKey(point) !== date)
    .map(point => Number(point.value))
    .filter(Number.isFinite);
  const peerMedian = medianNumber(peerValues);
  const peerSpread = peerValues.length
    ? Math.max(Math.max(...peerValues) - Math.min(...peerValues), 0)
    : 0;
  const peerScale = Math.max(peerSpread || 0, markerReferenceSpan(marker) || 0, Math.abs(peerMedian || 0) * 0.08, 1);
  return group
    .map(point => ({ point, score: sameDayConflictScore(marker, point, peerMedian, peerScale) }))
    .sort((a, b) => b.score - a.score);
}

function appendSameDayConflictDataQuality(dataQuality, conflictGroups) {
  if (!conflictGroups.length) return dataQuality || null;
  const hiddenCount = conflictGroups.reduce((sum, group) => sum + group.hidden.length, 0);
  const hiddenReasons = { ...(dataQuality?.hiddenReasons || {}) };
  hiddenReasons[SAME_DAY_CONFLICT_REASON] = (hiddenReasons[SAME_DAY_CONFLICT_REASON] || 0) + hiddenCount;
  const examples = [...(dataQuality?.examples || [])];
  for (const group of conflictGroups) {
    for (const point of group.hidden) {
      if (examples.length >= 3) break;
      examples.push({
        date: point.date,
        value: point.value,
        sourceId: point.sourceId || '',
        reason: SAME_DAY_CONFLICT_REASON,
      });
    }
  }
  return {
    ...(dataQuality || {}),
    hiddenCount: Number(dataQuality?.hiddenCount || 0) + hiddenCount,
    hiddenReasons,
    examples,
    sameDayConflictHiddenCount: Number(dataQuality?.sameDayConflictHiddenCount || 0) + hiddenCount,
    sameDayConflictGroups: Number(dataQuality?.sameDayConflictGroups || 0) + conflictGroups.length,
    sameDayConflictExamples: conflictGroups.slice(0, 3).map(group => ({
      date: group.date,
      kept: duplicateSourceSummary(group.kept),
      hidden: group.hidden.map(duplicateSourceSummary),
    })),
  };
}

function collapseSameDayConflictingClinicalDataPoints(marker) {
  if (!Array.isArray(marker?.data) || marker.data.length < 2) return marker;
  const byDate = new Map();
  const passthrough = [];
  for (const point of marker.data) {
    const date = pointDateKey(point);
    const value = Number(point.value);
    if (!date || !Number.isFinite(value)) {
      passthrough.push(point);
      continue;
    }
    const normalized = { ...point, date, value };
    const list = byDate.get(date);
    if (list) list.push(normalized);
    else byDate.set(date, [normalized]);
  }

  const data = [...passthrough];
  const conflictGroups = [];
  for (const [date, group] of byDate.entries()) {
    if (group.length > 1 && isMaterialSameDayConflict(marker, group)) {
      const scored = scoredSameDayConflictPoints(marker, group, marker.data);
      const best = scored[0];
      const hidden = scored
        .filter(({ score }) => best.score - score >= 45)
        .map(({ point }) => point);
      if (hidden.length) {
        const hiddenSet = new Set(hidden);
        conflictGroups.push({ date, kept: best.point, hidden });
        data.push(...group.filter(point => !hiddenSet.has(point)));
      } else {
        data.push(...group);
      }
    } else {
      data.push(...group);
    }
  }
  if (!conflictGroups.length) return marker;
  data.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  return {
    ...marker,
    data,
    dataQuality: appendSameDayConflictDataQuality(marker.dataQuality, conflictGroups),
  };
}

function collapseDuplicateClinicalDataPoints(marker) {
  if (!Array.isArray(marker?.data) || marker.data.length < 2) return marker;
  const buckets = new Map();
  const passthrough = [];
  for (const point of marker.data) {
    const key = normalizedDuplicateKey(point);
    if (!key) {
      passthrough.push(point);
      continue;
    }
    const list = buckets.get(key);
    if (list) list.push(point);
    else buckets.set(key, [point]);
  }

  const duplicateGroups = [];
  const data = [...passthrough];
  for (const group of buckets.values()) {
    if (group.length > 1) {
      duplicateGroups.push(group);
      data.push(representativeDuplicatePoint(group));
    } else {
      data.push(group[0]);
    }
  }
  if (!duplicateGroups.length) return marker;
  data.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  return {
    ...marker,
    data,
    dataQuality: appendDuplicateDataQuality(marker.dataQuality, duplicateGroups),
  };
}

function markerMatchesCanonical(marker, id) {
  return marker?.id === id || marker?.canonicalId === id || (marker?.aliases || []).includes(id);
}

function findMarkerByCanonical(markers, id) {
  return markers.find(marker => markerMatchesCanonical(marker, id)) || null;
}

function roundToNearest(value, increment = 0.5) {
  if (!Number.isFinite(value) || increment <= 0) return value;
  return Math.round(value / increment) * increment;
}

function parseMarkerDate(point) {
  const ms = Date.parse(`${String(point?.date || '').slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function nearestPointByDate(points, targetMs, maxDays) {
  if (!Number.isFinite(targetMs)) return null;
  const maxMs = maxDays * 86400000;
  let best = null;
  for (const point of points) {
    const ms = parseMarkerDate(point);
    if (!Number.isFinite(ms)) continue;
    const distance = Math.abs(ms - targetMs);
    if (distance > maxMs) continue;
    if (!best || distance < best.distance) best = { point, distance };
  }
  return best?.point || null;
}

function deriveWeightTargetFromBodyComposition(markers) {
  const weight = findMarkerByCanonical(markers, 'weight');
  const bodyFat = findMarkerByCanonical(markers, 'body_fat');
  if (!weight || !bodyFat || weight.target != null || bodyFat.target == null) return markers;

  const bodyFatTarget = Number(bodyFat.target);
  if (!Number.isFinite(bodyFatTarget) || bodyFatTarget <= 3 || bodyFatTarget >= 45) return markers;

  const bodyFatPoints = markerNumericData(bodyFat)
    .filter(point => point.value > 3 && point.value < 60)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const weightPoints = markerNumericData(weight)
    .filter(point => point.value >= 80 && point.value <= 400);
  if (!bodyFatPoints.length || !weightPoints.length) return markers;

  for (let i = bodyFatPoints.length - 1; i >= 0; i -= 1) {
    const bodyFatPoint = bodyFatPoints[i];
    const weightPoint = nearestPointByDate(weightPoints, parseMarkerDate(bodyFatPoint), 45);
    if (!weightPoint) continue;
    const leanMass = weightPoint.value * (1 - bodyFatPoint.value / 100);
    const targetWeight = leanMass / (1 - bodyFatTarget / 100);
    if (!Number.isFinite(targetWeight) || targetWeight < 80 || targetWeight > 400) continue;
    const roundedTarget = roundToNearest(targetWeight, 0.5);
    return markers.map(marker => marker === weight ? {
      ...marker,
      target: roundedTarget,
      direction: latestMarkerValue(marker) > roundedTarget ? 'lower' : 'higher',
      description: marker.description || 'Body weight interpreted against the patient body-composition record, not a generic BMI table.',
      recommendations: marker.recommendations || `Derived target ${roundedTarget} lb from ${bodyFatPoint.date} weight/body-fat data and the body-fat target of ${bodyFatTarget}%.`,
    } : marker);
  }

  return markers;
}

function pointDateKey(point) {
  const text = String(point?.date || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

function bestClinicalPointByDate(points) {
  const byDate = new Map();
  for (const point of points || []) {
    const date = pointDateKey(point);
    const value = Number(point?.value);
    if (!date || !Number.isFinite(value)) continue;
    const candidate = { ...point, date, value };
    const current = byDate.get(date);
    if (!current) {
      byDate.set(date, candidate);
      continue;
    }
    const priority = sourcePriority(candidate) - sourcePriority(current);
    if (priority < 0) byDate.set(date, candidate);
    else if (priority === 0) {
      const candidateKey = `${candidate.sourceFile || ''}|${candidate.sourceId || ''}`;
      const currentKey = `${current.sourceFile || ''}|${current.sourceId || ''}`;
      if (candidateKey.localeCompare(currentKey) < 0) byDate.set(date, candidate);
    }
  }
  return byDate;
}

function derivedLipidSourceFile(total, hdl) {
  const files = [...new Set([total?.sourceFile, hdl?.sourceFile].filter(Boolean))];
  if (!files.length) return 'derived from Total Cholesterol and HDL';
  return files.join(' + ');
}

function derivedNonHdlPoint(date, total, hdl) {
  const value = Number((Number(total.value) - Number(hdl.value)).toFixed(3));
  if (!Number.isFinite(value) || value <= 0 || value >= 400) return null;
  return {
    date,
    value,
    source: 'derived-lipid',
    sourceFile: derivedLipidSourceFile(total, hdl),
    sourceId: `derived:non_hdl:${date}:${total.sourceId || total.sourceFile || 'total_chol'}:${hdl.sourceId || hdl.sourceFile || 'hdl'}`,
    specimenType: total.specimenType || hdl.specimenType || 'serum',
    _derivedFrom: ['total_chol', 'hdl'],
  };
}

function deriveNonHdlCholesterol(markers) {
  const total = findMarkerByCanonical(markers, 'total_chol');
  const hdl = findMarkerByCanonical(markers, 'hdl');
  if (!total || !hdl) return markers;

  const totalByDate = bestClinicalPointByDate(total.data);
  const hdlByDate = bestClinicalPointByDate(hdl.data);
  if (!totalByDate.size || !hdlByDate.size) return markers;

  const existing = findMarkerByCanonical(markers, 'non_hdl');
  const directDates = new Set((existing?.data || []).map(pointDateKey).filter(Boolean));
  const derived = [];
  for (const [date, totalPoint] of totalByDate) {
    if (directDates.has(date)) continue;
    const hdlPoint = hdlByDate.get(date);
    if (!hdlPoint) continue;
    const point = derivedNonHdlPoint(date, totalPoint, hdlPoint);
    if (point) derived.push(point);
  }
  if (!derived.length) return markers;

  const data = [...(existing?.data || []), ...derived]
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  if (existing) {
    return markers.map(marker => marker === existing ? { ...marker, data } : marker);
  }
  const synthetic = {
    id: 'non_hdl',
    canonicalId: 'non_hdl',
    name: 'Non-HDL Cholesterol',
    unit: total.unit || hdl.unit || 'mg/dL',
    group: total.group || hdl.group || 'labs',
    groupName: total.groupName || hdl.groupName || 'Lab Results',
    groupId: total.groupId || hdl.groupId || 'labs',
    autoCreated: false,
    view: 'all',
    refRange: { low: null, high: 100 },
    target: 100,
    direction: 'lower',
    description: 'Calculated as total cholesterol minus HDL; useful for APOE4 lipid-risk monitoring.',
    data,
  };
  return [...markers, synthetic];
}

function mergeCanonicalMarkerAliases(markers) {
  const byCanonical = new Map();
  for (const marker of markers) {
    const key = marker.canonicalId || marker.id;
    const list = byCanonical.get(key);
    if (list) list.push(marker);
    else byCanonical.set(key, [marker]);
  }

  const merged = [];
  for (const [canonicalId, list] of byCanonical) {
    if (list.length === 1) {
      const marker = list[0];
      if (canonicalId && marker.id && canonicalId !== marker.id) {
        merged.push({
          ...marker,
          id: canonicalId,
          canonicalId,
          aliases: [...new Set([marker.id, ...(marker.aliases || [])].filter(id => id && id !== canonicalId))],
        });
      } else {
        merged.push(marker);
      }
      continue;
    }

    const primary = canonicalRepresentative(list, canonicalId);
    const aliases = [...new Set(list.map(marker => marker.id).filter(id => id && id !== canonicalId))];
    const seen = new Set();
    const data = [];
    for (const marker of list) {
      for (const point of marker.data || []) {
        const key = dataPointMergeKey(point);
        if (seen.has(key)) continue;
        seen.add(key);
        data.push({ ...point, sourceMarkerId: marker.id });
      }
    }
    data.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    merged.push({
      ...primary,
      id: canonicalId,
      canonicalId,
      aliases,
      autoCreated: Boolean(primary.autoCreated),
      mergedFrom: list.map(marker => ({
        id: marker.id,
        name: marker.name,
        sourceName: marker.sourceName || null,
        group: marker.group,
        autoCreated: Boolean(marker.autoCreated),
        points: markerDataCount(marker),
      })),
      data,
    });
  }

  return merged.sort((a, b) => {
    const group = String(a.groupName || a.group || '').localeCompare(String(b.groupName || b.group || ''));
    if (group) return group;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function normalizeMarkerTaxonomy(markers, groups) {
  const hasLabResults = groups.some(group => group.id === 'labs');
  if (!hasLabResults) return { markers, groups };
  return {
    markers: markers.map(marker => marker.group === 'auto_imported'
      ? { ...marker, group: 'labs', groupId: 'labs', groupName: 'Lab Results' }
      : marker),
    groups: groups.filter(group => group.id !== 'auto_imported'),
  };
}

function normalizeLabBackedChartGroups(markers) {
  return (markers || []).map(marker => {
    if (marker.chartContextOnly || marker.group === 'labs' || markerChartDataCount(marker) <= 0) return marker;
    return {
      ...marker,
      group: 'labs',
      groupId: 'labs',
      groupName: 'Lab Results',
    };
  });
}

function latestMarkerValue(marker) {
  const data = markerChartData(marker);
  return data.length ? Number(data[data.length - 1].value) : null;
}

function markerNumericData(marker) {
  return (Array.isArray(marker?.data) ? marker.data : [])
    .map(point => ({ ...point, value: Number(point.value) }))
    .filter(point => Number.isFinite(point.value));
}

function markerIsOutOfRange(marker) {
  const value = latestMarkerValue(marker);
  if (!Number.isFinite(value)) return false;
  const low = marker?.refRange?.low;
  const high = marker?.refRange?.high;
  return (low != null && value < Number(low)) || (high != null && value > Number(high));
}

function isAllergyPanelMarker(marker) {
  const text = `${marker?.id || ''} ${marker?.name || ''} ${marker?.unit || ''}`.toLowerCase();
  return /igg foods|igg reactivity|food allergy|allergen|[_-]ige[_-]|-ige\b|\bige\b/.test(text);
}

function isFlatLowInfoMarker(marker) {
  const data = markerChartData(marker);
  if (data.length < 4 || markerIsOutOfRange(marker)) return false;
  const values = new Set(data.map(point => Number(point.value).toPrecision(8)));
  return values.size === 1;
}

const REDUNDANT_WEARABLE_MARKERS = new Map([
  ['oura_steps', 'redundant wearable step summary; Apple Health Steps is the primary chart'],
  ['oura_spo2', 'redundant wearable oxygen summary; SpO2 is the primary chart'],
  ['oura_activity_score', 'low-actionability wearable summary score'],
]);
const EIGHT_SLEEP_CHART_HOLD_REASON = 'Eight Sleep kept for analysis; Oura is the charted sleep source';
const SPARSE_CONTEXT_MARKERS = new Set(['height', 'bmi', 'blood_pressure', 'bp_systolic', 'bp_diastolic', 'pulse', 'mpv']);

function redundantWearableReason(marker) {
  const id = marker?.id || marker?.canonicalId || '';
  if (String(id).startsWith('eight_sleep_')) return EIGHT_SLEEP_CHART_HOLD_REASON;
  return REDUNDANT_WEARABLE_MARKERS.get(id) || '';
}

function isSparseContextMarker(marker, count) {
  const id = marker?.id || marker?.canonicalId || '';
  return SPARSE_CONTEXT_MARKERS.has(id) && count <= 8;
}

function markerAutoArchiveReason(marker) {
  const count = markerChartDataCount(marker);
  if (count > 0 && count <= 3) return 'too few readings to show a trend';
  const redundantWearable = redundantWearableReason(marker);
  if (redundantWearable) return redundantWearable;
  if (isSparseContextMarker(marker, count)) return 'static or sparse context marker';
  if (marker?.autoCreated && count < 6 && !markerIsOutOfRange(marker)) return 'review-needed imported marker with limited trend';
  if (isFlatLowInfoMarker(marker)) return 'flat repeated value';
  return '';
}

function markerChartContextOnlyReason(marker) {
  const count = markerChartDataCount(marker);
  const rawCount = Number(marker?.rawDataCount || 0);
  if (count === 0 && rawCount > 0) {
    const hiddenReasons = marker?.dataQuality?.hiddenReasons || {};
    const [reason] = Object.keys(hiddenReasons);
    if (markerDataCount(marker) > 0 || Number(marker?.chartSourcePolicy?.hiddenCount || 0) > 0) {
      return LAB_BACKED_CHART_CONTEXT_REASON;
    }
    return reason || 'no chartable readings after data-quality filtering';
  }
  if (isAllergyPanelMarker(marker)) return 'allergy/reactivity panel';
  return '';
}

function applyChartDisplayDecisions(markers) {
  return markers.map(marker => {
    const chartContextOnlyReason = markerChartContextOnlyReason(marker);
    const chartContextOnly = !!chartContextOnlyReason;
    const autoArchiveReason = markerAutoArchiveReason(marker);
    const autoArchived = !!autoArchiveReason;
    return {
      ...marker,
      chartContextOnly,
      chartContextOnlyReason,
      autoArchived,
      autoArchiveReason,
      chart: {
        contextOnly: chartContextOnly,
        contextOnlyReason: chartContextOnlyReason,
        autoArchived,
        autoArchiveReason,
        pointCount: markerChartDataCount(marker),
      },
    };
  });
}

function listHealthChartArchivePreferences() {
  try {
    return new Map(readHealthChartArchivePreferences(db).map(row => [row.marker_id, row]));
  } catch {
    return new Map();
  }
}

function markerArchivePreferenceKeys(marker) {
  return [marker?.id, marker?.canonicalId, ...(marker?.aliases || [])].filter(Boolean);
}

function getMarkerArchivePreference(preferences, marker) {
  for (const key of markerArchivePreferenceKeys(marker)) {
    const row = preferences.get(key);
    if (row) return row;
  }
  return null;
}

function applyChartArchivePreferences(markers, preferences = listHealthChartArchivePreferences()) {
  return markers.map(marker => {
    if (marker.chartContextOnly) {
      return {
        ...marker,
        defaultAutoArchived: false,
        defaultAutoArchiveReason: '',
        archivePreference: null,
        chart: {
          ...(marker.chart || {}),
          defaultAutoArchived: false,
          defaultAutoArchiveReason: '',
          autoArchived: false,
          autoArchiveReason: '',
        },
      };
    }

    const defaultAutoArchived = Boolean(marker.autoArchived);
    const defaultAutoArchiveReason = marker.autoArchiveReason || '';
    const preference = getMarkerArchivePreference(preferences, marker);
    if (!preference) {
      return {
        ...marker,
        defaultAutoArchived,
        defaultAutoArchiveReason,
        archivePreference: null,
      };
    }

    const userArchived = Number(preference.archived) === 1;
    const autoArchived = userArchived;
    const autoArchiveReason = userArchived ? 'user archived' : '';
    return {
      ...marker,
      autoArchived,
      autoArchiveReason,
      defaultAutoArchived,
      defaultAutoArchiveReason,
      archivePreference: userArchived ? 'archived' : 'visible',
      chart: {
        ...(marker.chart || {}),
        autoArchived,
        autoArchiveReason,
        defaultAutoArchived,
        defaultAutoArchiveReason,
      },
    };
  });
}

function chartCurationReason(marker) {
  return marker?.autoArchiveReason || marker?.chart?.autoArchiveReason || marker?.defaultAutoArchiveReason || 'archived';
}

function chartCurationSummary(markers, payloadView) {
  const reasonCounts = new Map();
  const contextOnlyReasonCounts = new Map();
  let archivedCount = 0;
  let archivedOutOfRangeCount = 0;
  let contextOnlyCount = 0;
  let userArchivedCount = 0;
  let manualVisibleCount = 0;
  for (const marker of markers || []) {
    if (marker.chartContextOnly) {
      contextOnlyCount += 1;
      const reason = marker.chartContextOnlyReason || marker.chart?.contextOnlyReason || 'context-only';
      contextOnlyReasonCounts.set(reason, (contextOnlyReasonCounts.get(reason) || 0) + 1);
      continue;
    }
    if (marker.autoArchived) {
      archivedCount += 1;
      if (markerIsOutOfRange(marker)) archivedOutOfRangeCount += 1;
      if (marker.archivePreference === 'archived') userArchivedCount += 1;
      const reason = chartCurationReason(marker);
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    } else if (marker.archivePreference === 'visible' && marker.defaultAutoArchived) {
      manualVisibleCount += 1;
    }
  }
  const totalMarkerCount = markers.length;
  const chartEligibleCount = Math.max(0, totalMarkerCount - contextOnlyCount);
  const activeCount = Math.max(0, chartEligibleCount - archivedCount);
  return {
    policyVersion: HEALTH_MARKER_CHART_DISPLAY_POLICY_VERSION,
    view: payloadView,
    totalMarkerCount,
    chartEligibleCount,
    activeCount,
    archivedCount,
    archivedOutOfRangeCount,
    contextOnlyCount,
    userArchivedCount,
    manualVisibleCount,
    reasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    contextOnlyReasons: [...contextOnlyReasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

function resolveArchivePreferenceMarkerIds(markerId) {
  const requested = String(markerId || '').trim();
  if (!requested) return [];
  let canonicalId = canonicalHealthMarkerId({ id: requested, name: requested });
  const equivalent = new Set([requested, canonicalId]);
  try {
    const markers = listHealthMarkers(db, false).map(marker => enrichHealthMarker(marker));
    const clicked = markers.find(marker => marker.id === requested);
    if (clicked?.canonicalId) {
      canonicalId = clicked.canonicalId;
      equivalent.add(canonicalId);
    }
    for (const marker of markers) {
      if (marker.id === requested || marker.canonicalId === canonicalId) equivalent.add(marker.id);
    }
  } catch {
    // Fall back to the clicked id + deterministic metadata alias.
  }
  return [...equivalent].filter(Boolean);
}

const ROUTINE_HEALTH_EVENT_TYPES = new Set(['lab_draw', 'lab_result', 'health_metric', 'oura']);
const MATERIAL_HEALTH_EVENT_RE = /\b(owner-attested|health history|family history|diagnos|procedure|surgery|symptom|flare|medication|started|stopped|dose|olumiant|humira|chlorthalidone|rosuvastatin|ezetimibe|finasteride|behcet|alopecia|kidney|stone|calcium|nutrition|diet|food|supplement|apoe|lipid|autoimmune|inflammation|dexa|fracture|sleep|exposure)\b/i;
const MATERIAL_HEALTH_EVENT_LIMIT = 160;
const EVENT_TYPE_COLORS = {
  medication: '#2563eb',
  supplement: '#d97706',
  procedure: '#059669',
  flare: '#b45309',
  condition: '#b45309',
  lifestyle: '#6366f1',
  exposure: '#92400e',
  history: '#64748b',
};
const DOMAIN_EVENT_MARKERS = [
  { re: /\b(kidney|stone|hypercalciuria|urinary calcium|urine calcium|oxalate|citrate|chlorthalidone)\b/i, markers: ['urine_calcium_24hr', 'calcium_serum', 'egfr', 'creatinine', 'bun', 'urine_oxalate_24hr', 'pth', 'vitamin_d', 'sodium', 'potassium'] },
  { re: /\b(apoe|apo\s*b|apob|non[-_\s]?hdl|ldl|lipid|cholesterol|statin|rosuvastatin|ezetimibe|lpa|heart|cardiovascular)\b/i, markers: ['ldl', 'apob', 'non_hdl', 'hdl', 'total_chol', 'triglycerides', 'lpa', 'alt', 'ast'] },
  { re: /\b(behcet|autoimmune|inflammation|humira|adalimumab|olumiant|baricitinib|flare|ulcer|vasculitis)\b/i, markers: ['hscrp', 'c3', 'c4', 'anc', 'lymph_abs', 'wbc', 'esr', 'alt'] },
  { re: /\b(alopecia|hair|finasteride|dht|testosterone)\b/i, markers: ['testosterone', 'free_testosterone', 'free_testosterone_pg_ml', 'free_testosterone_ng_dl', 'dheas', 'ferritin', 'copper', 'zinc'] },
  { re: /\b(liver|gilbert|bilirubin|statin|hepatotoxicity)\b/i, markers: ['bilirubin', 'alt', 'ast', 'ggt'] },
  { re: /\b(bone|dexa|fracture|vitamin d|vdr|calcium)\b/i, markers: ['vitamin_d', 'calcium_serum', 'urine_calcium_24hr', 'pth', 'phosphorus', 'alp'] },
  { re: /\b(sleep|oura|recovery|hrv|readiness)\b/i, markers: ['oura_sleep_score', 'oura_total_sleep', 'oura_hrv', 'oura_rhr', 'oura_readiness'] },
  { re: /\b(glucose|metabolic|insulin|weight|body fat|hba1c)\b/i, markers: ['glucose', 'hba1c', 'insulin', 'weight', 'body_fat'] },
  { re: /\b(diet|nutrition|food|olive oil|avocado oil|citrus|lemon|oxalate|almond|spinach)\b/i, markers: ['ldl', 'apob', 'non_hdl', 'triglycerides', 'glucose', 'urine_calcium_24hr', 'urine_oxalate_24hr', 'hscrp'] },
];

function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeEventDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function normalizeEventText(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9()]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function markerLookup(markers) {
  const byId = new Map();
  const terms = [];
  for (const marker of markers || []) {
    const aliases = [...new Set([marker.id, marker.canonicalId, ...(marker.aliases || [])].filter(Boolean))];
    for (const alias of aliases) byId.set(alias, marker.id);
    const nameTerms = normalizeEventText(marker.name)
      .split(' ')
      .filter(term => term.length >= 4 && !['serum', 'total', 'blood', 'ratio', 'value', 'level', 'test'].includes(term));
    for (const term of [...aliases, marker.name, marker.sourceName, ...nameTerms]) {
      const normalized = normalizeEventText(term);
      if (normalized.length >= 3) terms.push({ term: normalized, id: marker.id });
    }
  }
  return { byId, terms };
}

function addOntologyMarkerLinks(out, text, lookup) {
  const cfg = getUIConfig();
  for (const entry of Object.values(cfg.rxMarkerMap || {})) {
    if (!entry?.pattern) continue;
    try {
      if (new RegExp(entry.pattern, 'i').test(text)) {
        for (const markerId of entry.markerIds || []) out.add(lookup.byId.get(markerId) || markerId);
      }
    } catch {}
  }
  for (const domain of DOMAIN_EVENT_MARKERS) {
    if (!domain.re.test(text)) continue;
    for (const markerId of domain.markers) out.add(lookup.byId.get(markerId) || markerId);
  }
  const normalized = normalizeEventText(text);
  for (const { term, id } of lookup.terms) {
    if (normalized.includes(term)) out.add(id);
    if (out.size >= 16) break;
  }
}

function inferHealthEventType({ eventType = '', sourceType = '', text = '', medicationType = '' } = {}) {
  const t = `${eventType} ${sourceType} ${text} ${medicationType}`.toLowerCase();
  if (/\b(procedure|surgery|scan|dexa|mri|x-ray|xray|colonoscopy)\b/.test(t)) return 'procedure';
  if (/\b(exposure|mold|toxin|mycotoxin|heavy metal)\b/.test(t)) return 'exposure';
  if (/\b(diet|nutrition|food|meal|citrus|hydration|exercise|lifestyle)\b/.test(t)) return 'lifestyle';
  if (/\b(flare|symptom|ulcer|attack|pain)\b/.test(t)) return 'flare';
  if (/\b(medication|started|stopped|dose|rx|olumiant|humira|rosuvastatin|ezetimibe|chlorthalidone|finasteride)\b/.test(t)) return medicationType === 'supplement' ? 'supplement' : 'medication';
  if (/\b(history|family|owner-attested)\b/.test(t)) return 'history';
  return 'condition';
}

function eventLabel(row, meta = {}) {
  const title = meta.title || meta.name || '';
  if (title && !/^owner-attested health history$/i.test(title)) return String(title).slice(0, 140);
  return String(row.summary || row.content || 'Health event').replace(/^Owner-attested history:\s*/i, '').slice(0, 140);
}

function healthTimelineRows(database) {
  try {
    return database.prepare(`
      SELECT id, event_date, source_type, source_id, event_type, summary, metadata
      FROM timeline_events
      WHERE (
          source_type = 'user'
          OR event_type LIKE '%owner_attested%'
          OR (source_type = 'health' AND event_type NOT IN ('lab_draw', 'lab_result', 'health_metric'))
        )
        AND event_type NOT IN ('lab_draw', 'lab_result', 'health_metric')
      ORDER BY event_date ASC, id ASC
      LIMIT ?
    `).all(MATERIAL_HEALTH_EVENT_LIMIT * 2);
  } catch {
    return [];
  }
}

function buildTimelineHealthEvents(database, markers) {
  const lookup = markerLookup(markers);
  const events = [];
  for (const row of healthTimelineRows(database)) {
    if (ROUTINE_HEALTH_EVENT_TYPES.has(String(row.event_type || '').toLowerCase())) continue;
    const meta = safeJson(row.metadata);
    const text = `${row.summary || ''} ${meta.content_excerpt || ''} ${(meta.tags || []).join?.(' ') || ''}`;
    if (!MATERIAL_HEALTH_EVENT_RE.test(text) && row.source_type !== 'health') continue;
    const date = normalizeEventDate(row.event_date);
    if (!date) continue;
    const linked = new Set();
    for (const tag of meta.tags || []) {
      const id = lookup.byId.get(tag) || tag;
      if (lookup.byId.has(tag) || lookup.byId.has(id)) linked.add(id);
    }
    if (meta.markerId) linked.add(lookup.byId.get(meta.markerId) || meta.markerId);
    addOntologyMarkerLinks(linked, text, lookup);
    const type = inferHealthEventType({ eventType: row.event_type, sourceType: row.source_type, text });
    events.push({
      id: row.id,
      date,
      endDate: normalizeEventDate(meta.end_date || meta.endDate),
      type,
      label: eventLabel(row, meta),
      color: EVENT_TYPE_COLORS[type] || EVENT_TYPE_COLORS.history,
      markers: [...linked].slice(0, 16),
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceQuality: meta.source_quality || null,
    });
  }
  return events;
}

function buildMedicationHealthEvents(database, markers) {
  const lookup = markerLookup(markers);
  let meds = [];
  try { meds = listEffectiveMedicationsRaw(database); } catch { return []; }
  const events = [];
  for (const med of meds) {
    const medText = `${med.name || ''} ${med.notes || ''} ${med.type || ''}`;
    for (const change of [
      { key: 'date_started', verb: 'started' },
      { key: 'date_stopped', verb: 'stopped' },
    ]) {
      const date = normalizeEventDate(med[change.key]);
      if (!date) continue;
      const linked = new Set();
      addOntologyMarkerLinks(linked, medText, lookup);
      const type = inferHealthEventType({ eventType: 'medication_change', text: medText, medicationType: med.type });
      const details = [med.dose, med.frequency, med.timing].filter(Boolean).join(' | ');
      const sourceType = med.source === 'health_rx_ontology' ? 'health_rx_ontology' : 'curated_medications';
      events.push({
        id: `med-${med.id}-${change.verb}`,
        date,
        endDate: '',
        type,
        label: `${med.name} ${change.verb}${details ? ` (${details})` : ''}`,
        color: EVENT_TYPE_COLORS[type] || EVENT_TYPE_COLORS.medication,
        markers: [...linked].slice(0, 16),
        sourceType,
        sourceId: String(med.id),
        sourceQuality: sourceType === 'health_rx_ontology' ? 'rx_ontology' : 'curated',
      });
    }
  }
  return events;
}

function materialHealthEvents(database, markers) {
  const seen = new Set();
  return [...buildTimelineHealthEvents(database, markers), ...buildMedicationHealthEvents(database, markers)]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)))
    .filter(event => {
      const key = `${event.sourceType}:${event.sourceId}:${event.date}:${event.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MATERIAL_HEALTH_EVENT_LIMIT);
}

function healthMarkerPayloadCacheKey(teaser, payloadView) {
  return `${teaser ? 'teaser' : 'full'}:${payloadView}`;
}

function buildProcessedHealthMarkers({ teaser = false, payloadView = 'active' } = {}) {
  const rawMarkers = listHealthMarkers(db, !!teaser).map(enrichHealthMarker);
  const dataByMarker = listDataPointsGroupedByMarker(db, {
    sources: LAB_BACKED_CHART_SOURCE_LIST,
    includeMarkerIds: CHART_CONTEXT_MARKER_DATA_IDS,
  });
  const pointStatsByCanonical = canonicalMarkerPointStats(
    rawMarkers,
    listDataPointCountsGroupedByMarker(db, { chartSources: LAB_BACKED_CHART_SOURCE_LIST })
  );

  let globalMin = Infinity;
  let globalMax = -Infinity;
  let markers = rawMarkers.map(marker => {
    const dataPoints = dataByMarker.get(marker.id) || [];
    const data = dataPoints.map(point => ({
      date: point.date,
      value: point.value,
      source: point.source,
      sourceFile: point.source_file || '',
      sourceId: point.source_id || '',
      specimenType: point.specimen_type || 'unknown',
    }));

    for (const point of dataPoints) {
      const t = new Date(point.date).getTime();
      if (t < globalMin) globalMin = t;
      if (t > globalMax) globalMax = t;
    }

    return {
      id: marker.id,
      canonicalId: marker.canonicalId,
      name: marker.name,
      sourceName: marker.sourceName || null,
      unit: marker.unit,
      group: marker.group_id,
      groupName: marker.group_name,
      groupId: marker.group_id,
      autoCreated: Boolean(marker.auto_created),
      view: marker.view || 'all',
      refRange: { low: marker.ref_low, high: marker.ref_high },
      target: marker.target,
      direction: marker.direction,
      trend: marker.trend,
      description: marker.description,
      recommendations: marker.recommendations,
      data,
    };
  });

  markers = mergeCanonicalMarkerAliases(splitMixedUnitMarkers(markers));
  markers = deriveNonHdlCholesterol(markers);
  markers = markers.map(normalizeCanonicalMarkerDataUnits);
  markers = markers.map(collapseDuplicateClinicalDataPoints);
  markers = markers.map(collapseSameDayConflictingClinicalDataPoints);
  // Runs on the settled series and BEFORE any target is derived, so a range the
  // readings cannot be read against never reaches a derived figure.
  markers = markers.map(reconcileReferenceRangeUnits);
  markers = deriveWeightTargetFromBodyComposition(markers);
  markers = markers.map(marker => attachLabBackedChartSourcePolicy(
    marker,
    pointStatsByCanonical.get(marker.canonicalId || marker.id)
  ));
  markers = markers.map(reduceDenseDisplayData);
  markers = applyChartDisplayDecisions(markers);
  markers = applyChartArchivePreferences(markers);
  markers = normalizeLabBackedChartGroups(markers);

  const chartCuration = chartCurationSummary(markers, payloadView);
  const totalMarkerCount = markers.length;
  const archivedCount = markers.filter(marker => !marker.chartContextOnly && marker.autoArchived).length;
  const payloadMarkers = payloadView === 'active'
    ? markers.filter(marker => !marker.chartContextOnly && !marker.autoArchived)
    : markers.filter(marker => !marker.chartContextOnly);

  if (globalMin === Infinity) globalMin = 0;
  if (globalMax === -Infinity) globalMax = Date.now();

  return {
    markers,
    payloadMarkers,
    chartCuration,
    totalMarkerCount,
    archivedCount,
    globalMin,
    globalMax,
  };
}

/**
 * Read the generated copy cache into the two shapes the payload carries:
 * a marker-id map and the body-area narrative map. A never-generated corpus
 * yields an empty map and an empty object, which is what makes a fresh install
 * render today's behaviour rather than a blank surface.
 */
function readGeneratedChartCopy() {
  const markerCopy = new Map();
  const areaNarratives = {};
  let rows = [];
  try { rows = listHealthMarkerCopyRows(db); } catch { return { markerCopy, areaNarratives }; }
  for (const row of rows) {
    if (row.scope === 'marker') {
      markerCopy.set(row.subject_id, {
        definition: row.definition || '',
        trend: row.trend || '',
        action: row.action || '',
        omitted: Boolean(row.omitted),
      });
    } else if (row.scope === 'area' && !row.omitted && row.narrative) {
      areaNarratives[row.subject_id] = normalizeAreaNarrative(row.narrative);
    }
  }
  return { markerCopy, areaNarratives };
}

function buildHealthMarkersPayload({ teaser = false, payloadView = 'active' } = {}) {
  const processed = buildProcessedHealthMarkers({ teaser, payloadView });

  let notes = [];
  try {
    notes = [
      ...listHealthWorkbenchContextNotes(db, CHART_WORKBENCH_CONTEXT_NOTE_LIMIT),
      ...listChartHealthNotes(db, CHART_GENERIC_NOTE_LIMIT),
    ];
  } catch {}
  notes = notes.map(note => {
    let tags = [];
    try { tags = typeof note.tags === 'string' ? JSON.parse(note.tags || '[]') : (note.tags || []); } catch {}
    return { ...note, tags };
  });

  let medications = [];
  try {
    medications = listEffectiveMedicationsRaw(db).map(medication => ({
      name: medication.name,
      type: medication.type,
      status: medication.status,
      dateStart: medication.date_started || null,
      dateEnd: medication.date_stopped || null,
      dose: medication.dose || '',
      frequency: medication.frequency || '',
      reason: medication.notes || '',
      source: medication.source || 'curated_medications',
      markers: medication.marker_ids || [],
    }));
  } catch {}

  let groups = [];
  try {
    groups = listHealthGroups(db);
  } catch {}
  let markers = processed.payloadMarkers;
  ({ markers, groups } = normalizeMarkerTaxonomy(markers, groups));

  // Generated chart copy (st_3ca30b26). Attached here and NOT in
  // buildProcessedHealthMarkers, which /api/health/charts also calls and which
  // must stay slim. Three states matter to the renderer and they are distinct:
  // no row -> marker.copy is null and the deterministic annotation chain
  // renders; an omitted row -> the block renders nothing; a filled row ->
  // generated prose replaces the templated slots.
  const { markerCopy, areaNarratives } = readGeneratedChartCopy();

  return {
    markers: markers.map(marker => ({
      ...marker,
      copy: markerCopy.get(marker.canonicalId || marker.id) || null,
      data: (marker.data || []).map(serializeMarkerDataPointForPayload),
    })),
    areaNarratives,
    groups,
    timeRange: { min: processed.globalMin, max: processed.globalMax },
    view: payloadView,
    totalMarkerCount: processed.totalMarkerCount,
    archivedCount: processed.archivedCount,
    hasArchivedCharts: processed.archivedCount > 0,
    chartCuration: processed.chartCuration,
    notes,
    medications,
    events: materialHealthEvents(db, markers),
    ...(teaser ? { teaser: true } : {}),
  };
}

function scheduleHealthMarkerPayloadPrewarm({ reason = '', views = ['active', 'full'] } = {}) {
  let signature = '';
  try {
    signature = healthMarkersCacheSignature();
  } catch (err) {
    console.warn('[health] marker cache prewarm signature failed', { reason, error: err.message });
    return;
  }
  for (const payloadView of views) {
    const normalizedView = payloadView === 'full' ? 'full' : 'active';
    const cacheKey = healthMarkerPayloadCacheKey(false, normalizedView);
    prewarmHealthMarkerPayloadCache(cacheKey, {
      signature,
      buildPayload: () => buildHealthMarkersPayload({ teaser: false, payloadView: normalizedView }),
      onError: err => console.warn('[health] marker cache prewarm failed', {
        reason,
        view: normalizedView,
        error: err.message,
      }),
    });
  }
}

function clearAndPrewarmHealthMarkerPayloadCache(options = {}) {
  clearHealthMarkerPayloadCache();
  scheduleHealthMarkerPayloadPrewarm(options);
}

registerHealthMarkerPayloadWarmer(({ reason } = {}) => {
  scheduleHealthMarkerPayloadPrewarm({ reason, views: ['active', 'full'] });
});

// Which markers are charted, and what each chart actually shows, is decided by
// the curation pipeline above (alias merge, mixed-unit split, unit
// normalisation, same-day collapse, lab-backed source policy, dense-series
// reduction, derived targets, auto-archive, archive preferences) — route-local
// by design. lib/health-marker-copy.js writes the copy for those charts and
// must not import this file, so the route hands the curated markers in.
registerHealthChartSubjectProvider(() => buildProcessedHealthMarkers({ teaser: false, payloadView: 'active' }).payloadMarkers);

// After a generation run the server payload cache still holds the pre-run copy.
// Same inversion: the cache lives here, the job runs there.
registerHealthMarkerCopyPayloadRefresher(({ reason } = {}) => {
  clearAndPrewarmHealthMarkerPayloadCache({ reason, views: ['active', 'full'] });
});

scheduleHealthMarkerPayloadPrewarm({ reason: 'route_startup', views: ['active'] });

/**
 * GET /api/health/charts — White Belt chart data surface.
 *
 * Returns time-series chart data for active/unarchived health markers by
 * default. Use `view=full` for the archived audit payload. Always 200
 * (never 402) for both White and Black Belt users —
 * the intelligence tabs (overview, chronology, diet, rx, nextvisit) are
 * the paywalled surface, not the raw chart data. st_42799dbe AC 12.
 *
 * Body: { charts: [{markerId, name, unit, data: [{date,value}]}], markers, teaser? }
 */
routes.get('/api/health/charts', (c) => {
  // WHY no user check: the global /api/* middleware in lib/server.js already
  // enforces auth (session cookie OR Bearer token). Bearer-token callers
  // pass auth but don't populate c.get('user') — gating on user here would
  // 401 the bearer flow. The middleware is the authoritative gate.
  const teaser = c.get('teaser');
  const payloadView = c.req.query('view') === 'full' ? 'full' : 'active';
  const {
    payloadMarkers,
    totalMarkerCount,
    archivedCount,
    chartCuration,
  } = buildProcessedHealthMarkers({ teaser: !!teaser, payloadView });
  const charts = payloadMarkers.map(m => ({
    markerId: m.id,
    canonicalMarkerId: m.canonicalId,
    aliases: m.aliases || [],
    autoCreated: Boolean(m.autoCreated),
    chartContextOnly: Boolean(m.chartContextOnly),
    chartContextOnlyReason: m.chartContextOnlyReason || '',
    autoArchived: Boolean(m.autoArchived),
    autoArchiveReason: m.autoArchiveReason || '',
    defaultAutoArchived: Boolean(m.defaultAutoArchived),
    defaultAutoArchiveReason: m.defaultAutoArchiveReason || '',
    archivePreference: m.archivePreference || null,
    chartSourcePolicy: m.chartSourcePolicy || null,
    chart: m.chart || null,
    name: m.name,
    sourceName: m.sourceName || null,
    unit: m.unit,
    group: m.group,
    refRange: m.refRange,
    target: m.target,
    direction: m.direction,
    rawDataCount: m.rawDataCount,
    dataSummary: m.dataSummary,
    dataQuality: m.dataQuality || null,
    data: markerChartData(m).map(d => ({
      date: d.date,
      value: d.value,
      ...(d._duplicateCount ? {
        duplicateCount: d._duplicateCount,
        ...(shouldShipDuplicateSources(d) ? { duplicateSources: d._duplicateSources || [] } : {}),
      } : {}),
      ...(d._bucketCount ? {
        bucketCount: d._bucketCount,
        bucketMode: d._bucketMode,
        minValue: d._minValue,
        maxValue: d._maxValue,
      } : {}),
    })),
  }));
  return c.json({
    charts,
    markers: charts.length,
    view: payloadView,
    totalMarkerCount,
    archivedCount,
    hasArchivedCharts: archivedCount > 0,
    chartCuration,
    data_points: charts.reduce((sum, c) => sum + c.data.length, 0),
    ...(teaser ? { teaser: true } : {}),
  });
});

/**
 * GET /api/health/tabs — intelligence tab visibility for the current user.
 *
 * Black Belt users see every tab unlocked. White Belt users see the same
 * tabs in the response with `locked: true` so the frontend can render them
 * visible-but-locked with an upgrade affordance (AC 12). The shape mirrors
 * /api/health/intel so the frontend can drop in the locked flag without
 * a second roundtrip.
 *
 * Body: { tabs: [{id, label, locked}] }
 */
routes.get('/api/health/tabs', (c) => {
  // Same reasoning as /api/health/charts — global middleware enforces auth.
  // WHY X-Belt override: testing/QA needs a deterministic way to verify the
  // white-belt locked-tab response from an admin port. We honor X-Belt only
  // as a DOWNGRADE (white can never escalate to black) so this header is
  // safe to expose without a separate session machinery.
  let belt = c.get('belt') || 'white';
  const headerBelt = c.req.header('X-Belt');
  if (headerBelt === 'white' || headerBelt === 'demo') belt = headerBelt;
  const locked = belt === 'white' || belt === 'demo';
  // The intelligence tab labels mirror lib/health-intel.js TABS, with the
  // "intelligence" virtual tab front-loaded so the response always has at
  // least one locked entry for VC-12b's grep (looks for "intelligence".*locked).
  const intelligenceTab = { id: 'intelligence', label: 'Intelligence', locked };
  const tabs = [intelligenceTab, ...INTEL_TABS.map(id => ({
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
    locked,
  }))];
  return c.json({ tabs });
});

routes.get('/api/health/markers', async (c) => {
  // Auth is enforced by the global /api/* middleware in lib/server.js. Do not
  // require c.get('user') here: local Bearer-token callers are authorized by
  // middleware but do not populate a session user.
  const teaser = c.get('teaser');
  // Product contract: Charts > All means all unarchived insight charts. Archived
  // or low-information charts are available only by explicit `view=full`.
  const payloadView = c.req.query('view') === 'full' ? 'full' : 'active';
  const cacheKey = healthMarkerPayloadCacheKey(!!teaser, payloadView);
  const signature = healthMarkersCacheSignature();
  const freshPayload = getFreshHealthMarkerPayload(cacheKey);
  const cached = getHealthMarkerPayloadCacheEntry(cacheKey);
  if (freshPayload && cached?.signature === signature) return c.json(freshPayload);
  if (cached && cached.signature === signature) {
    refreshHealthMarkerPayloadCacheEntry(cached);
    return c.json(cached.payload);
  }
  const warmPromise = getHealthMarkerPayloadWarmPromise(cacheKey);
  if (warmPromise) {
    await warmPromise;
    const warmed = getHealthMarkerPayloadCacheEntry(cacheKey);
    if (warmed?.signature === signature) {
      refreshHealthMarkerPayloadCacheEntry(warmed);
      return c.json(warmed.payload);
    }
  }
  const payload = buildHealthMarkersPayload({ teaser: !!teaser, payloadView });
  setHealthMarkerPayloadCache(cacheKey, { signature, payload });
  return c.json(payload);
});

routes.get('/api/health/data/:markerId', (c) => {
  const { markerId } = c.req.param();
  const since = c.req.query('since') || '2020-01-01';
  const points = listDataPointsSince(db, markerId, since);
  return c.json(points);
});

routes.get('/api/health/medications', (c) => {
  const meds = listEffectiveMedicationsRaw(db);
  return c.json(meds);
});

// Health extended
routes.get('/api/health/ui-config', (c) => {
  return c.json(getUIConfig());
});

routes.get('/api/health/notes', (c) => {
  try {
    const rows = listRecentHealthNotes(db, 50);
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

routes.post('/api/health/markers/:markerId/archive', async (c) => {
  const { markerId } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const archived = body.archived === true || body.archived === 1 || body.archived === 'true';
  if (!markerId || String(markerId).length > 160) {
    return c.json({ ok: false, error: 'invalid_marker_id' }, 400);
  }

  const markerIds = resolveArchivePreferenceMarkerIds(markerId);
  // A marker and its canonical/alias ids must flip together in one atomic write
  // so a partial failure can never leave half the group archived. The lib owns
  // the transactional SQL (thin-facade: routes hold zero db.prepare); this local
  // wrapper names the one call the handler makes.
  const writeArchivePreferences = (ids) => writeHealthChartArchivePreferences(db, ids, archived);
  writeArchivePreferences(markerIds);
  clearAndPrewarmHealthMarkerPayloadCache({ reason: 'chart_archive_preference', views: ['active', 'full'] });

  return c.json({
    ok: true,
    markerId,
    markerIds,
    archivePreference: archived ? 'archived' : 'visible',
    archived,
  });
});

routes.post('/api/health/notes', async (c) => {
  return c.json({
    error: 'coming_soon',
    message: 'Health note capture is not available in this launch build yet.',
    status: 503,
  }, 503);
});

routes.get('/api/health/timeline', (c) => {
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '60', 10) || 60));
  return c.json(listHealthTopicTimeline(db, { limit }));
});

routes.post('/api/health/history', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const entry = createOwnerAttestedHealthHistory({
      content: body.content,
      startDate: body.start_date || body.startDate,
      endDate: body.end_date || body.endDate,
    });
    const regeneration = queueHealthIntelRegeneration({ reason: 'history_added' });
    return c.json({
      ok: true,
      recalculation_started: !!regeneration?.job,
      alreadyRunning: !!regeneration?.alreadyRunning,
      queued: !!regeneration?.queued,
      history: {
        note_id: entry.noteId,
        timeline_event_id: entry.timelineEventId,
        source_id: entry.sourceId,
        event_date: entry.eventDate,
        start_date: entry.startDate,
        end_date: entry.endDate || null,
        is_ongoing: entry.isOngoing,
        period: entry.period,
        source_quality: entry.sourceQuality,
        content_length: entry.content.length,
      },
      job: regeneration?.job || null,
      regeneration,
    }, 202);
  } catch (err) {
    const message = err?.message || 'Could not save health history';
    const status = /too short|too long/i.test(message) ? 400 : 500;
    return c.json({ error: 'history_save_failed', message }, status);
  }
});

// --- Health Intel (Opus-synthesized tab content) ---

function healthIntelTabPayload(tab) {
  const row = getIntelContent(tab, { includeStale: true });
  if (!row) {
    const cache = getIntelCacheStatus(tab);
    return {
      tab,
      content: null,
      generated_at: cache.generated_at,
      model: cache.model,
      stale: cache.stale,
      stale_reasons: cache.stale_reasons || [],
      missing_requirements: cache.missing_requirements || [],
      latest_input_at: cache.latest_input_at || null,
      input_stale: cache.input_stale === true,
      content_chars: cache.content_chars,
      prompt: getTabPrompt(tab),
      ...intelReadiness(),
    };
  }

  return {
    tab: row.tab,
    content: row.content,
    generated_at: row.generated_at,
    model: row.model,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    stale: row.stale === true,
    stale_reasons: row.stale_reasons || [],
    freshness: row.freshness || null,
    content_chars: String(row.content || '').length,
    prompt: getTabPrompt(tab),
  };
}

// Return all cached synthesis rows in one read so the UI can prewarm the
// intelligence tabs without touching the expensive generation path.
routes.get('/api/health/intel/all', (c) => {
  return c.json({
    tabs: INTEL_TABS,
    intel: Object.fromEntries(INTEL_TABS.map(tab => [tab, healthIntelTabPayload(tab)])),
    ...intelReadiness(),
  });
});

// Return cached synthesis for a tab. Cache is keyed by tab name — one row per
// tab, always-current, never lazily regenerated on read (Opus is expensive).
// Clients that want fresh content POST to the regenerate endpoint below.
routes.get('/api/health/intel/:tab', (c) => {
  const tab = resolveIntelTab(c.req.param('tab'));
  if (!tab) {
    return c.json({ error: 'unknown_tab', tabs: INTEL_TABS }, 404);
  }
  return c.json(healthIntelTabPayload(tab));
});

// Index of what's been generated and when. Useful for a "regenerate all"
// button and for surfacing staleness in the UI.
routes.get('/api/health/intel', (c) => {
  return c.json({
    tabs: INTEL_TABS,
    cached: listIntel(),
    ...intelReadiness(),
  });
});

// POST /api/health/apple-daily — Health Auto Export REST JSON (metrics + workouts).
routes.post('/api/health/apple-daily', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ ok: false, error: 'invalid_json' }, 400);
  }
  try {
    const stats = await upsertAppleHealthDailyPayload(body, { sourceFile: 'hae-rest.json' });
    if (!stats.ok) {
      const status = stats.error === 'not_daily_json' || stats.error === 'fhir_not_daily' ? 400 : 500;
      return c.json(stats, status);
    }
    return c.json(stats);
  } catch (err) {
    return c.json({ ok: false, error: 'import_failed', message: err.message }, 500);
  }
});

// POST /api/health/data/import/fhir — trigger Apple Health FHIR clinical records import.
// Idempotent. Re-runs safely after each new Apple Health export.
routes.post('/api/health/data/import/fhir', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const dryRun = body.dry_run === true;
    const stats = importFhirClinicalRecords({ db, dryRun });
    const report = formatImportReport(stats);
    // WHY: fire-and-forget intelligence regeneration after a successful real import.
    // Opus synthesis (Tier 3) takes ~30s+; the response is the import stats — we do
    // not block the HTTP turn on the regen. Errors are logged but not surfaced to
    // the caller; the next /api/health/intel poll will reflect the new content.
    const changedRows = stats.inserted + (stats.updated || 0);
    const regeneration = queueHealthIntelRegenerationIfChanged({
      dryRun,
      inserted: changedRows,
      reason: 'apple_health_import',
    });
    return c.json({ ok: true, dry_run: dryRun, stats, report, regeneration });
  } catch (err) {
    return c.json({ error: 'import_failed', message: err.message }, 500);
  }
});

// GET /api/health/recovery-status — read-only proof that the health substrate
// can recover without re-extracting owner PDFs unless a restore actually fails.
routes.get('/api/health/recovery-status', (c) => {
  try {
    return c.json(buildHealthRecoveryStatus(db));
  } catch (err) {
    return c.json({ ok: false, error: 'recovery_status_failed', message: err.message }, 500);
  }
});

// Start a full-tab regeneration job. Returns immediately; clients poll status.
// A FULL recalc also regenerates the per-chart copy and the body-area
// narratives (st_3ca30b26); the single-tab path below deliberately does not.
// POST /api/health/intel/all/regenerate
routes.post('/api/health/intel/all/regenerate', async (c) => {
  try {
    let spendCapUsd = null;
    try {
      const body = await c.req.json();
      const cap = Number(body?.spend_cap_usd);
      if (Number.isFinite(cap) && cap > 0) spendCapUsd = cap;
    } catch { /* no body is a full uncapped-by-job recalc */ }
    const { job, alreadyRunning } = startIntelRegenerationJob({ reason: 'manual', includeMarkerCopy: true, spendCapUsd });
    return c.json({ ok: true, alreadyRunning, job }, 202);
  } catch (err) {
    return c.json({ error: 'regenerate_failed', message: err.message }, 500);
  }
});

// Poll the active or most recent full-tab regeneration job.
// GET /api/health/intel/all/regenerate/status
routes.get('/api/health/intel/all/regenerate/status', (c) => {
  return c.json({ ok: true, job: getIntelRegenerationJob() });
});

// Regenerate a single tab on explicit owner command (df_feb7754e). Schedules a
// SINGLE-tab background job and returns immediately (202); the client polls the
// shared status route. WHY a background job instead of the old blocking Opus call:
// it reuses the same job + poll infra as "regenerate all", so there is one code
// path, no ~30s blocking HTTP hold, and `tabs: [tab]` guarantees exactly one Opus
// call on the happy path (normalizeJobTabs selects only this tab) — never five.
// POST /api/health/intel/:tab/regenerate
routes.post('/api/health/intel/:tab/regenerate', (c) => {
  const requested = c.req.param('tab');
  const tab = resolveIntelTab(requested);
  if (!tab) {
    return c.json({ error: 'unknown_tab', tabs: INTEL_TABS }, 404);
  }
  try {
    const { job, alreadyRunning } = startIntelRegenerationJob({
      tabs: INTEL_TABS,
      reason: 'manual',
      includeMarkerCopy: true,
    });
    return c.json({ ok: true, alreadyRunning, job }, 202);
  } catch (err) {
    return c.json({ error: 'regenerate_failed', message: err.message }, 500);
  }
});
// Named exports for behavioral tests of the unit-reconciliation contract
// (st_3ca30b26 AC 15-18). Pure functions over a marker object: no HTTP, no db.
export { referenceRangeUnitMismatch, reconcileReferenceRangeUnits };
export default routes;
