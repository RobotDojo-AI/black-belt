/**
 * Apple Health FHIR clinical records importer — White Belt core data pipeline.
 *
 * Reads clinical-records/ from an Apple Health export and imports lab results
 * into health_data_points. Two FHIR formats handled:
 *   DiagnosticReport-*.json → contained[] Observations (LabCorp)
 *   Observation-*.json      → standalone Observations (NYU Langone, Epic)
 *
 * Tier 0 pipeline: local processing only, no LLM calls.
 * Idempotent: INSERT OR IGNORE, safe to re-run after each new export.
 *
 * resolveMarkerId() returns 3 states:
 *   string   → known marker ID → insert to health_data_points
 *   null     → explicitly skipped (derived, percentage, etc.) → stage with status='excluded'
 *   undefined → not in map at all → auto-create health_marker (auto_created=1) + insert
 *
 * @module health-fhir-import
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LAB_NAME_MAP } from '../config/lab-name-map.js';
import { writeLabEvent } from './health-timeline.js';
import { USER_DATABASES_DIR } from './robotdojo-paths.js';
import { deriveHealthSpecimenType, healthDataPointSourceId } from './health-data-point-source.js';
import { canonicalHealthMarkerId } from './health-marker-metadata.js';

// WHY: specimen_type is derived from marker_id naming convention rather than
// the FHIR specimen resource. Marker IDs already encode specimen unambiguously
// (urine_calcium_24hr is urine; calcium_serum is serum). Reading the FHIR
// specimen reference would require parser changes across all three ingestion
// paths (FHIR, Apple XML, PDF) for no signal gain — the marker ID is the
// canonical authority.
const DEFAULT_CLINICAL_DIR = path.join(
  USER_DATABASES_DIR,
  'health/source/apple-health/apple_health_export/clinical-records'
);

// Units that mean "percentage" — skip for absolute count markers
const PERCENT_UNITS = new Set(['%', 'percent', '%{cells}']);

// Markers that must come in as absolute counts, not percentages
const ABSOLUTE_COUNT_MARKERS = new Set(['anc', 'wbc', 'rbc', 'lymph_abs', 'eos_absolute', 'eosinophils', 'platelets']);

function normalizeUnit(u) {
  return (u || '').toLowerCase().trim();
}

function extractDate(effectiveDateTime) {
  if (!effectiveDateTime) return null;
  return effectiveDateTime.slice(0, 10);
}

function getLabName(code) {
  if (!code) return null;
  if (code.text) return code.text.toLowerCase().trim();
  if (Array.isArray(code.coding)) {
    for (const c of code.coding) {
      if (c.display) return c.display.toLowerCase().trim();
    }
  }
  return null;
}

function getLabDisplayName(code) {
  if (!code) return null;
  if (code.text) return code.text;
  if (Array.isArray(code.coding)) {
    for (const c of code.coding) {
      if (c.display) return c.display;
    }
  }
  return null;
}

function resolveMarkerId(labName) {
  if (!labName) return undefined;
  const lower = labName.toLowerCase().trim();
  if (lower in LAB_NAME_MAP) return LAB_NAME_MAP[lower];
  // Strip trailing lab-suffix like " 01" or " a, 01"
  const stripped = lower.replace(/\s+(a,\s*)?\d+$/, '').trim();
  if (stripped !== lower && stripped in LAB_NAME_MAP) return LAB_NAME_MAP[stripped];
  return undefined; // unmapped — caller handles auto-create
}

function slugify(name) {
  return (name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || null;
}

function canonicalizeResolvedMarkerId(markerId, labName) {
  if (markerId === null || markerId === undefined) return markerId;
  return canonicalHealthMarkerId({ id: markerId, name: labName || markerId });
}

function isTwentyFourHourUrineMarker(markerId) {
  return Boolean(markerId)
    && markerId.includes('24h')
    && (markerId.startsWith('urine_') || markerId.includes('_urine_') || markerId.includes('_ur_'));
}

function isTwentyFourHourObservation(labName, unit) {
  const text = `${labName || ''} ${unit || ''}`.toLowerCase();
  return /\b24\s*(?:h|hr|hrs|hour|hours)\b/.test(text) || /\b24-?hour\b/.test(text);
}

function shouldExcludeUnitMismatch(markerId, labName, unit) {
  return isTwentyFourHourUrineMarker(markerId) && !isTwentyFourHourObservation(labName, unit);
}

function healthIngestionColumnExists(db, column) {
  try {
    return db.prepare('PRAGMA table_info(health_ingestion_log)').all().some(row => row.name === column);
  } catch {
    return false;
  }
}

function recordFhirIngestion(db, clinicalDir, count, stats = {}) {
  const hasLog = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='health_ingestion_log'").get();
  if (!hasLog) return;
  const hasStatus = healthIngestionColumnExists(db, 'status');
  const hasError = healthIngestionColumnExists(db, 'error');
  const hasMetadata = healthIngestionColumnExists(db, 'metadata_json');
  const status = Number(stats.errors || 0) > 0 ? 'partial' : 'ok';
  const materialChange = Number(stats.inserted || 0) > 0
    || Number(stats.updated || 0) > 0
    || Number(stats.errors || 0) > 0;
  const metadata = JSON.stringify({
    files: stats.files,
    inserted: stats.inserted,
    persisted_rows: stats.persistedRows,
    active_rows: stats.activeRows,
    updated: stats.updated,
    recognized: stats.recognized,
    excluded: stats.excluded,
    dropped_no_value: stats.dropped_no_value,
    dropped_no_date: stats.dropped_no_date,
    errors: stats.errors,
  });
  const columns = ['id', 'source', 'file_path', 'ingested_date', 'record_count'];
  const values = ['?', "'fhir'", '?', "date('now')", '?'];
  const args = [randomUUID(), clinicalDir, count];
  if (hasStatus) { columns.push('status'); values.push('?'); args.push(status); }
  if (hasError) { columns.push('error'); values.push('?'); args.push(status === 'partial' ? `${stats.errors} file parse error(s)` : null); }
  if (hasMetadata) { columns.push('metadata_json'); values.push('?'); args.push(metadata); }
  const updates = [
    'ingested_date = excluded.ingested_date',
    `record_count = CASE
        WHEN excluded.record_count > 0 THEN excluded.record_count
        ELSE health_ingestion_log.record_count
      END`,
    `created_at = CASE
        WHEN ? = 1 THEN datetime('now')
        ELSE health_ingestion_log.created_at
      END`,
  ];
  if (hasStatus) updates.push('status = excluded.status');
  if (hasError) updates.push('error = excluded.error');
  if (hasMetadata) updates.push('metadata_json = excluded.metadata_json');
  db.prepare(`
    INSERT INTO health_ingestion_log (${columns.join(', ')})
    VALUES (${values.join(', ')})
    ON CONFLICT(source, file_path) DO UPDATE SET
      ${updates.join(',\n      ')}
  `).run(...args, materialChange ? 1 : 0);
}

function countPersistedFhirRows(db, sourceFiles, { activeOnly = false } = {}) {
  if (!Array.isArray(sourceFiles) || !sourceFiles.length) return 0;
  let total = 0;
  const chunkSize = 500;
  for (let i = 0; i < sourceFiles.length; i += chunkSize) {
    const chunk = sourceFiles.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const row = db.prepare(`
      SELECT COUNT(*) AS n
      FROM health_data_points
      WHERE source = 'fhir'
        ${activeOnly ? 'AND COALESCE(excluded, 0) = 0' : ''}
        AND source_file IN (${placeholders})
    `).get(...chunk);
    total += Number(row?.n || 0);
  }
  return total;
}

/**
 * Import FHIR clinical records from an Apple Health export directory.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db - open DB connection
 * @param {string} [opts.clinicalDir] - path to clinical-records/ directory
 * @param {boolean} [opts.dryRun] - if true, parse but don't write
 * @param {boolean} [opts.verbose] - log each record
 * @returns {object} stats
 */
export function importFhirClinicalRecords({ db, clinicalDir = DEFAULT_CLINICAL_DIR, dryRun = false, verbose = false }) {
  if (!fs.existsSync(clinicalDir)) {
    throw new Error(`Clinical records directory not found: ${clinicalDir}`);
  }

  const files = fs.readdirSync(clinicalDir);
  const diagnosticFiles = files.filter(f => f.startsWith('DiagnosticReport-') && f.endsWith('.json'));
  const observationFiles = files.filter(f => f.startsWith('Observation-') && f.endsWith('.json'));
  const sourceFiles = [...diagnosticFiles, ...observationFiles];

  // Load ref ranges from DB for outlier validation
  const markers = db.prepare('SELECT id, ref_low, ref_high FROM health_markers').all();
  const refRanges = Object.fromEntries(markers.map(m => [m.id, { low: m.ref_low, high: m.ref_high }]));

  // WHY: include source_id + specimen_type in the INSERT. The UNIQUE INDEX on
  // source_id makes INSERT OR IGNORE a no-op on duplicates — the
  // (marker_id, date, source_file) uniqueness from the legacy schema would
  // have allowed 49 rows for the same observation across 49 DiagnosticReport
  // files. Now: 1 row, regardless of how many files name it.
  const insertStmt = dryRun ? null : db.prepare(`
    INSERT OR IGNORE INTO health_data_points
      (marker_id, date, value, source, source_file, source_id, specimen_type, excluded, exclude_reason, updated_at)
    VALUES (@markerId, @date, @value, 'fhir', @sourceFile, @sourceId, @specimenType, @excluded, @excludeReason, strftime('%Y-%m-%d %H:%M:%f', 'now'))
  `);

  const updateExcludedStmt = dryRun ? null : db.prepare(`
    UPDATE health_data_points
    SET excluded = @excluded,
        exclude_reason = @excludeReason,
        updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE source = 'fhir'
      AND source_id = @sourceId
      AND (
        COALESCE(excluded, 0) != @excluded
        OR COALESCE(exclude_reason, '') != COALESCE(@excludeReason, '')
      )
  `);

  const stageStmt = dryRun ? null : db.prepare(`
    INSERT OR IGNORE INTO fhir_staged_observations
      (source_file, effective_date, fhir_display_name, value, unit, ref_low, ref_high, status, reason)
    VALUES (@sourceFile, @date, @labName, @value, @unit, @refLow, @refHigh, @status, @reason)
  `);

  const checkMarkerStmt = db.prepare('SELECT id FROM health_markers WHERE id = ?');
  const insertMarkerStmt = dryRun ? null : db.prepare(`
    INSERT OR IGNORE INTO health_markers (id, name, unit, group_id, auto_created)
    VALUES (?, ?, ?, 'labs', 1)
  `);

  const stats = {
    files: { diagnostic: diagnosticFiles.length, observation: observationFiles.length },
    total: 0,
    inserted: 0,
    updated: 0,
    recognized: 0,
    auto_created_markers: 0,
    excluded: 0,
    staged: 0,
    dropped_no_value: 0,
    dropped_no_date: 0,
    excluded_outlier: 0,
    errors: 0,
    perMarker: {},
    stagedNames: {},
    autoCreatedNames: [],
  };

  function ensureAutoMarker(markerId, displayName, unit) {
    if (checkMarkerStmt.get(markerId)) return false; // already exists
    if (!dryRun) {
      insertMarkerStmt.run(markerId, displayName || markerId, unit || '');
    }
    stats.auto_created_markers++;
    stats.autoCreatedNames.push(markerId);
    return true;
  }

  function processObs(obs, sourceFile) {
    if (!obs || obs.resourceType !== 'Observation') return;

    // Drop: no value
    if (!obs.valueQuantity || obs.valueQuantity.value == null) {
      stats.dropped_no_value++;
      return;
    }

    const labName = getLabName(obs.code);
    const displayName = getLabDisplayName(obs.code);
    const value = obs.valueQuantity.value;
    if (typeof value !== 'number' || !isFinite(value)) {
      stats.dropped_no_value++;
      return;
    }

    const unit = normalizeUnit(obs.valueQuantity.unit);
    const date = extractDate(obs.effectiveDateTime);

    // Drop: no date
    if (!date) {
      stats.dropped_no_date++;
      return;
    }

    const refLow = obs.referenceRange?.[0]?.low?.value ?? null;
    const refHigh = obs.referenceRange?.[0]?.high?.value ?? null;

    let markerId = resolveMarkerId(labName);

    // null = explicitly skipped → stage as 'excluded'
    if (markerId === null) {
      stats.excluded++;
      stats.stagedNames[labName] = (stats.stagedNames[labName] || 0) + 1;
      if (!dryRun && labName) {
        try {
          stageStmt.run({ sourceFile, date, labName: displayName || labName, value, unit, refLow, refHigh, status: 'excluded', reason: 'explicit_skip_in_map' });
        } catch { /* UNIQUE dedup on re-run — safely ignored */ }
      }
      return;
    }

    // undefined = not in map → auto-create marker + insert
    if (markerId === undefined) {
      const slug = slugify(labName);
      if (!slug) { stats.dropped_no_value++; return; }

      markerId = canonicalizeResolvedMarkerId(slug, displayName || labName);
      ensureAutoMarker(markerId, displayName, unit);
      stats.total++;

      if (!stats.perMarker[markerId]) stats.perMarker[markerId] = { inserted: 0, excluded: 0, skipped: 0 };

      if (dryRun) {
        stats.inserted++;
        stats.perMarker[markerId].inserted++;
      } else {
        const sourceId = healthDataPointSourceId({ source: 'fhir', markerId, date, value });
        const specimenType = deriveHealthSpecimenType(markerId);
        const r = insertStmt.run({ markerId, date, value, sourceFile, sourceId, specimenType, excluded: 0, excludeReason: null });
        if (r.changes > 0) {
          stats.inserted++;
          stats.perMarker[markerId].inserted++;
          // WHY: timeline write only runs on a real INSERT. INSERT OR IGNORE returns
          // 0 changes on a source_id collision; in that case the timeline event was
          // already written on the first import. The UNIQUE(source_type, source_id)
          // constraint on timeline_events is a second line of defense.
          try { writeLabEvent(markerId, date, value, unit, sourceId); } catch (e) { /* timeline write is best-effort */ }
        } else {
          stats.recognized++;
          stats.perMarker[markerId].skipped++;
        }
      }
      if (verbose) console.log(`  AUTO: ${markerId}=${value} ${unit} (${date}) [${sourceFile}]`);
      return;
    }

    markerId = canonicalizeResolvedMarkerId(markerId, displayName || labName);

    // Skip percentage values for absolute-count markers
    if (ABSOLUTE_COUNT_MARKERS.has(markerId) && PERCENT_UNITS.has(unit)) {
      stats.excluded++;
      return;
    }

    stats.total++;
    if (!stats.perMarker[markerId]) stats.perMarker[markerId] = { inserted: 0, excluded: 0, skipped: 0 };

    const dbRef = refRanges[markerId] || {};
    const rH = dbRef.high ?? refHigh;
    const rL = dbRef.low ?? refLow;

    let excluded = 0;
    let excludeReason = null;

    if (shouldExcludeUnitMismatch(markerId, labName, unit)) {
      excluded = 1; excludeReason = 'unit-mismatch-not-24hr-urine';
    } else if (rH != null && value > rH * 20) {
      excluded = 1; excludeReason = 'outlier-pending-review'; stats.excluded_outlier++;
      if (verbose) console.log(`  OUTLIER: ${markerId}=${value} ref_high=${rH} on ${date} (${sourceFile})`);
    } else if (rL != null && rL > 0 && value < rL / 20) {
      excluded = 1; excludeReason = 'outlier-pending-review'; stats.excluded_outlier++;
      if (verbose) console.log(`  OUTLIER LOW: ${markerId}=${value} ref_low=${rL} on ${date}`);
    }

    if (dryRun) {
      stats.inserted++;
      stats.perMarker[markerId].inserted++;
      if (excluded) stats.perMarker[markerId].excluded++;
    } else {
      try {
        const sourceId = healthDataPointSourceId({ source: 'fhir', markerId, date, value });
        const specimenType = deriveHealthSpecimenType(markerId);
        const r = insertStmt.run({ markerId, date, value, sourceFile, sourceId, specimenType, excluded, excludeReason });
        if (r.changes > 0) {
          stats.inserted++;
          stats.perMarker[markerId].inserted++;
          if (excluded) stats.perMarker[markerId].excluded++;
          // WHY: only fire the timeline write on a real INSERT — see auto-create
          // branch for full reasoning. Outliers (excluded=1) still earn a timeline
          // event because they happened — the exclusion is about whether the value
          // is reliable for analytics, not about whether the draw existed.
          try { writeLabEvent(markerId, date, value, unit, sourceId); } catch (e) { /* timeline write is best-effort */ }
        } else {
          if (excluded) {
            const u = updateExcludedStmt.run({ sourceId, excluded, excludeReason });
            if (u.changes > 0) stats.updated++;
          }
          stats.recognized++;
          stats.perMarker[markerId].skipped++;
        }
      } catch (insertErr) {
        // FK failure: marker_id not in health_markers (shouldn't happen in production)
        stats.recognized++;
        stats.perMarker[markerId].skipped++;
        if (verbose) console.log(`  WARN: ${markerId} insert failed (FK?): ${insertErr.message}`);
      }
    }
    if (verbose) console.log(`  ${markerId}=${value} ${unit} (${date})`);
  }

  // DiagnosticReport: traverse contained[]
  for (const file of diagnosticFiles) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(clinicalDir, file), 'utf8'));
      if (!Array.isArray(raw.contained)) continue;
      for (const item of raw.contained) {
        if (item.resourceType === 'Observation') processObs(item, file);
      }
    } catch (e) { stats.errors++; console.warn(`WARN: ${file}: ${e.message}`); }
  }

  // Standalone Observations
  for (const file of observationFiles) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(clinicalDir, file), 'utf8'));
      processObs(raw, file);
    } catch (e) { stats.errors++; console.warn(`WARN: ${file}: ${e.message}`); }
  }

  if (!dryRun) {
    stats.persistedRows = countPersistedFhirRows(db, sourceFiles);
    stats.activeRows = countPersistedFhirRows(db, sourceFiles, { activeOnly: true });
    recordFhirIngestion(db, clinicalDir, stats.persistedRows, stats);
  }

  return stats;
}

/**
 * Format import stats as a human-readable report string.
 * Invariant: inserted + recognized + excluded + staged + dropped_no_value + dropped_no_date + errors === total_seen
 */
export function formatImportReport(stats, { verbose = false } = {}) {
  const totalSeen = stats.total + stats.excluded + stats.staged + stats.dropped_no_value + stats.dropped_no_date + stats.errors;
  const accounted = stats.inserted + stats.recognized + stats.excluded + stats.staged + stats.dropped_no_value + stats.dropped_no_date + stats.errors;

  const lines = [
    `Import complete — FHIR clinical records`,
    `───────────────────────────────────────────────────────────`,
    `  DiagnosticReport files:          ${String(stats.files.diagnostic).padStart(6)}`,
    `  Observation files:               ${String(stats.files.observation).padStart(6)}`,
    `───────────────────────────────────────────────────────────`,
    `  Inserted (new):                  ${String(stats.inserted).padStart(6)}`,
    `  Updated existing rows:           ${String(stats.updated || 0).padStart(6)}`,
    `  Recognized (prior import):       ${String(stats.recognized).padStart(6)}`,
    `  Auto-created markers:            ${String(stats.auto_created_markers).padStart(6)}`,
    `  Excluded (intentional skip):     ${String(stats.excluded).padStart(6)}`,
    `  Staged (pending review):         ${String(stats.staged).padStart(6)}`,
    `  Dropped (no value):              ${String(stats.dropped_no_value).padStart(6)}`,
    `  Dropped (no date):               ${String(stats.dropped_no_date).padStart(6)}`,
    `  Outliers flagged:                ${String(stats.excluded_outlier).padStart(6)}`,
    `  Errors:                          ${String(stats.errors).padStart(6)}`,
    `───────────────────────────────────────────────────────────`,
  ];

  if (totalSeen === accounted) {
    lines.push(`  All data accounted for. Re-run is safe.`);
  } else {
    lines.push(`  WARNING: accounting mismatch — seen ${totalSeen} but accounted ${accounted}. Please report this.`);
  }

  if (stats.auto_created_markers > 0) {
    lines.push(``, `── Auto-created lab markers needing ontology review ─────────────`);
    for (const name of stats.autoCreatedNames.slice(0, 30)) {
      lines.push(`  ${name}`);
    }
    if (stats.autoCreatedNames.length > 30) {
      lines.push(`  ... and ${stats.autoCreatedNames.length - 30} more`);
    }
  }

  if (verbose) {
    const sorted = Object.entries(stats.perMarker).sort((a, b) => b[1].inserted - a[1].inserted);
    if (sorted.length > 0) {
      lines.push(``, `── Per-marker breakdown ────────────────────────────────────`);
      for (const [mid, c] of sorted) {
        const ex = c.excluded ? ` [${c.excluded} outliers]` : '';
        const sk = c.skipped ? ` [${c.skipped} dup]` : '';
        lines.push(`  ${mid.padEnd(30)} +${c.inserted}${ex}${sk}`);
      }
    }

    const topStaged = Object.entries(stats.stagedNames || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 20);
    if (topStaged.length > 0) {
      lines.push(``, `── Staged/excluded names (top 20) ──────────────────────────`);
      for (const [name, count] of topStaged) {
        lines.push(`  ${String(count).padStart(4)}x  ${name}`);
      }
    }
  }

  return lines.join('\n');
}
