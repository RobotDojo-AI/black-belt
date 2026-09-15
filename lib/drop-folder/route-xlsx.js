/**
 * XLSX drop-folder router.
 *
 * WHY fire-and-forget subprocess: XLSX ingestion involves Jaro-Winkler matching
 * against 33K+ companies, N-tier recalculation, and local embedding for ~40
 * chunks. That's 5–30 seconds of CPU+IO. The drop-folder pipeline must
 * return immediately so the watcher can move the file and emit file_processed.
 * We spawn the ingestion script detached (same pattern as lab_report PDF import)
 * and return a queued status with topic metadata so the file is categorized
 * correctly in the ontology tree.
 *
 * Compute tier: ~40 agency chunks. All embedded inline — no Haiku pre-filter
 * needed at this scale.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { topicForDocType } from '../taxonomy.js';
import { detachedDbWriterDecision } from '../db-writer-policy.js';

// Path to the ingestion script — resolved relative to this file.
const INGEST_SCRIPT = fileURLToPath(
  new URL('../../scripts/ingest-agency-xlsx.js', import.meta.url),
);

/**
 * Classify the XLSX synchronously: peek at sheet names + row count to confirm
 * it's a collection-agency roster vs some other spreadsheet.
 *
 * WHY quick sniff: the watcher handles many file types. Sniffing ensures we
 * don't blindly spawn the ingestion script for any .xlsx (e.g. expense reports).
 * For unknown XLSXes, we still accept and spawn — the ingestion script will
 * validate and log if the format doesn't match.
 */
async function sniffXlsx(filePath) {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const sheetNames = wb.worksheets.map((s) => s.name);
    const mainSheet = wb.getWorksheet('Collection Agencies') || wb.worksheets[0];
    return {
      sheetNames,
      rowCount: mainSheet ? mainSheet.rowCount : 0,
      likelyAgencyRoster: sheetNames.some((n) =>
        /collection.agenc/i.test(n) || /agencies/i.test(n),
      ),
    };
  } catch {
    return { sheetNames: [], rowCount: 0, likelyAgencyRoster: false };
  }
}

/**
 * Route an XLSX file: sniff, spawn ingestion subprocess, return immediately.
 *
 * @param {{ path: string, originalName: string }} args
 * @returns {Promise<object>} Classification metadata (not ingestion results)
 */
export async function routeXlsx({ path: filePath, originalName }) {
  const decision = detachedDbWriterDecision('xlsx-import');
  if (!decision.ok) {
    const { t1, t2 } = topicForDocType('agency_xlsx');
    return {
      doc_type: 'agency_xlsx',
      topic_t1: t1,
      topic_t2: t2,
      status: 'needs_user',
      entity_refs: null,
      error: decision.message,
      extracted_json: JSON.stringify({
        blocked: true,
        reason: decision.reason,
        originalName,
      }),
    };
  }

  // WHY sniff: gives us richer classification metadata for the ontology path
  // and lets us log whether the file looks like a collection agency roster.
  const sniff = await sniffXlsx(filePath);

  // WHY fire-and-forget: ingestion is slow (embed calls, DB writes for 40+
  // entities). Return immediately; subprocess emits its own console logs.
  const child = spawn(process.execPath, [INGEST_SCRIPT, filePath], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) =>
    console.info(`[drop-folder:xlsx-ingest] ${d.toString().trim()}`),
  );
  child.stderr.on('data', (d) =>
    console.warn(`[drop-folder:xlsx-ingest] ${d.toString().trim()}`),
  );
  child.on('close', (code) => {
    if (code !== 0) {
      console.warn(
        `[drop-folder:xlsx-ingest] exited ${code} for ${originalName}`,
      );
    } else {
      console.info(`[drop-folder:xlsx-ingest] completed for ${originalName}`);
    }
  });
  child.unref();

  const { t1, t2 } = topicForDocType('agency_xlsx');
  return {
    doc_type: 'agency_xlsx',
    topic_t1: t1,
    topic_t2: t2,
    status: 'spawned',
    entity_refs: null,
    extracted_json: JSON.stringify({
      sheetNames: sniff.sheetNames,
      rowCount: sniff.rowCount,
      likelyAgencyRoster: sniff.likelyAgencyRoster,
    }),
  };
}
