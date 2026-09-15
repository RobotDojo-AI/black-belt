/**
 * Health drop-folder router.
 *
 * Handles two cases:
 *   1. Apple Health export.xml — copy into the canonical clinical-records
 *      source directory; note that the XML itself is a summary, not FHIR.
 *      The clinical-records/ FHIR JSONs are the importable data and will
 *      arrive separately after the archive router extracts the zip.
 *
 *   2. Individual FHIR clinical record JSON (re-queued after zip extraction)
 *      — copy into user/databases/health/source/apple-health/clinical-records/
 *      then trigger importFhirClinicalRecords() so the import is idempotent
 *      (INSERT OR IGNORE on source_id hash prevents duplicates).
 *
 * WHY copy rather than move: the source directory is the import archive.
 * We want the originals preserved there; the watcher owns the inbox copy.
 *
 * WHY call import on every file: the importer is O(files-in-dir) not O(1).
 * For a personal health system with at most a few hundred FHIR files, this
 * is acceptable — it re-scans the directory and INSERT OR IGNOREs existing
 * rows, so re-running is always safe.
 */

import { copyFile, mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import db from '../db.js';
import { importFhirClinicalRecords } from '../health-fhir-import.js';
import { queueHealthIntelRegenerationIfChanged } from '../health-intel-regeneration.js';
import { USER_DATABASES_DIR } from '../robotdojo-paths.js';

const CLINICAL_DIR = join(
  USER_DATABASES_DIR,
  'health/source/apple-health/apple_health_export/clinical-records'
);
const APPLE_HEALTH_DIR = join(USER_DATABASES_DIR, 'health/source/apple-health');

export async function routeHealth({ path: filePath, originalName }) {
  const name = basename(originalName || filePath);
  const ext = extname(name).toLowerCase();

  // Ensure clinical-records directory exists.
  await mkdir(CLINICAL_DIR, { recursive: true });

  if (ext === '.json') {
    // FHIR clinical record — copy to clinical-records dir.
    const dest = join(CLINICAL_DIR, name);
    await copyFile(filePath, dest);

    // Run import now — idempotent, so safe to call per file.
    let stats = { inserted: 0, recognized: 0, errors: 0, dropped: 0 };
    try {
      stats = importFhirClinicalRecords({ db });
      const changedRows = Number(stats.inserted || 0) + Number(stats.updated || 0);
      queueHealthIntelRegenerationIfChanged({
        inserted: changedRows,
        reason: 'apple_health_import',
      });
    } catch (err) {
      console.error('[route-health] import error after FHIR JSON drop:', err.message);
    }

    return {
      doc_type: 'fhir_resource',
      topic_t1: 'personal', topic_t2: 'health',
      extracted_json: JSON.stringify({ file: name, import: stats }),
      entity_refs: null,
      confidence: 0.95,
    };
  }

  if (ext === '.xml' || name === 'export.xml') {
    // Apple Health export.xml — archive for provenance, then import its
    // HKQuantity time-series (steps, HR, HRV, weight, sleep, …) IN-PROCESS
    // (controlled write path). The clinical-records FHIR JSONs carry diagnoses;
    // export.xml carries the daily quantity series, which we now actually import
    // instead of only archiving. st_fcdbe84f AC7.
    const dest = join(APPLE_HEALTH_DIR, name);
    await copyFile(filePath, dest);

    let stats = null;
    try {
      const { importAppleHealthXml } = await import('../../scripts/import-apple-health-xml.js');
      stats = await importAppleHealthXml({ file: dest });
    } catch (err) {
      stats = { ok: false, error: err.message };
    }

    return {
      doc_type: 'health_export',
      topic_t1: 'personal', topic_t2: 'health',
      extracted_json: JSON.stringify({ file: name, import: stats }),
      entity_refs: null,
      confidence: 0.95,
    };
  }

  // Unknown health file type — archive it and flag for user review.
  return {
    doc_type: 'health_export',
    topic_t1: 'personal', topic_t2: 'health',
    extracted_json: null,
    entity_refs: null,
    confidence: 0.5,
    prompt_user: 'Health file received — what type is this?',
  };
}
