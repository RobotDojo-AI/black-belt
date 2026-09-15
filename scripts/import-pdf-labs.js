#!/usr/bin/env node
/**
 * PDF lab result importer.
 *
 * Extracts text from a PDF via pdf-parse, then calls Claude Haiku to pull
 * lab values (marker name, value, unit, reference range, date). Stores
 * results in health_data_points. Tracks every import in health_ingestion_log
 * via SHA256 dedup — never processes the same file twice unless --force.
 *
 * Usage:
 *   node scripts/import-pdf-labs.js --file labs.pdf
 *   node scripts/import-pdf-labs.js --file labs.pdf --date 2026-03-01
 *   node scripts/import-pdf-labs.js --file labs.pdf --dry-run
 *   node scripts/import-pdf-labs.js --file labs.pdf --force
 */

import { readFile, access, copyFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import db from '../lib/db.js';
import { getProvider } from '../lib/llm/index.js';
import { recordIngestion, wasIngested } from '../lib/health-ingestion.js';
import { LAB_NAME_MAP } from '../config/lab-name-map.js';
import { ocrPdf } from '../lib/health-pdf-ocr.js';
import { deriveHealthSpecimenType, healthDataPointSourceId } from '../lib/health-data-point-source.js';
import { canonicalHealthMarkerId } from '../lib/health-marker-metadata.js';
import { queueHealthIntelRegenerationIfChanged } from '../lib/health-intel-regeneration.js';
import { USER_DATABASES_DIR } from '../lib/robotdojo-paths.js';
import { projectHealthDataPointForDb } from '../lib/health-timeline.js';
import { modelFor } from '../lib/model-lane.js';

export const INTELLIGENCE_TIER = 'orchestration';

const HAIKU_MODEL = modelFor('fast');
const PDF_LAB_VAULT = join(USER_DATABASES_DIR, 'health', 'archive', 'labs');

const EXTRACTION_PROMPT = `Extract ALL lab test results from the following lab report text.

Return a JSON array. Each element must have:
- "name": exact test name as shown in the report
- "value": numeric value only (number, no units)
- "unit": unit of measurement (string)
- "date": collection date in YYYY-MM-DD format (use the date hint if not in report)
- "ref_low": lower bound of reference range (number or null)
- "ref_high": upper bound of reference range (number or null)
- "flag": "H" if high, "L" if low, "N" if normal, null if not indicated

Rules:
- Include every numeric result — do not skip any values
- If date is not found in the text, use the date hint provided
- If this is not a lab report or contains no numeric values, return []
- Return ONLY the JSON array, no prose, no code fences`;

// Parse the Haiku JSON array, salvaging a truncated response. Even at 8192
// output tokens Haiku can run out mid-array on a huge panel, leaving invalid
// JSON; recover all complete objects rather than dropping the whole import.
// st_fcdbe84f AC7.
function parseLabJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const lastComplete = text.lastIndexOf('}');
    if (lastComplete === -1) return [];
    try {
      return JSON.parse(`${text.slice(0, lastComplete + 1)}]`);
    } catch {
      return [];
    }
  }
}

function vaultPdfFilename(filename, sha256) {
  const ext = extname(filename) || '.pdf';
  const base = basename(filename, ext)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'lab-report';
  return `${sha256.slice(0, 16)}-${base}${ext.toLowerCase()}`;
}

async function preservePdfLabSource(filePath, filename, sha256) {
  await mkdir(PDF_LAB_VAULT, { recursive: true });
  const vaultPath = join(PDF_LAB_VAULT, vaultPdfFilename(filename, sha256));
  await copyFile(filePath, vaultPath);
  return vaultPath;
}

// ─── Marker name resolution ───────────────────────────────────────────────
// LAB_NAME_MAP imported from config/lab-name-map.js (canonical source)

function resolveMarkerName(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();

  if (LAB_NAME_MAP[lower] !== undefined) return LAB_NAME_MAP[lower];

  const normalized = lower.replace(/[,()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (LAB_NAME_MAP[normalized] !== undefined) return LAB_NAME_MAP[normalized];

  const withoutSerum = normalized.replace(/ serum$/, '').trim();
  if (LAB_NAME_MAP[withoutSerum] !== undefined) return LAB_NAME_MAP[withoutSerum];

  return undefined;
}

function nameToId(name) {
  return (name || '').toLowerCase()
    .replace(/^[%\s]+/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || null;
}

function canonicalizeResolvedMarkerId(markerId, labName) {
  if (markerId === null || markerId === undefined) return markerId;
  return canonicalHealthMarkerId({ id: markerId, name: labName || markerId });
}

// ─── DB helpers ───────────────────────────────────────────────────────────

function ensureMarker(markerId, name, unit, refLow = null, refHigh = null, { autoCreated = false } = {}) {
  const existing = db.prepare('SELECT id FROM health_markers WHERE id = ?').get(markerId);
  if (existing) return;

  db.prepare(`
    INSERT OR IGNORE INTO health_groups (id, name, description)
    VALUES ('labs', 'Lab Results', 'Blood and clinical laboratory results')
  `).run();

  db.prepare(`
    INSERT OR IGNORE INTO health_markers (id, name, unit, group_id, ref_low, ref_high, auto_created)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(markerId, name, unit || '', 'labs', refLow ?? null, refHigh ?? null, autoCreated ? 1 : 0);
}

const getPointBySourceId = db.prepare(`
  SELECT id, marker_id, date, value, source, source_file, source_id, specimen_type, excluded
  FROM health_data_points
  WHERE source_id = ?
`);

const getLegacyPdfPoints = db.prepare(`
  SELECT id, marker_id, date, value, source_file, source_id, specimen_type, excluded
  FROM health_data_points
  WHERE source = 'pdf-lab'
    AND marker_id = ?
    AND date = ?
    AND source_file = ?
  ORDER BY id
`);

const insertPointStmt = db.prepare(`
  INSERT INTO health_data_points (marker_id, date, value, source, source_file, source_id, specimen_type, excluded, created_at, updated_at)
  VALUES (?, ?, ?, 'pdf-lab', ?, ?, ?, 0, datetime('now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))
`);

const updatePointStmt = db.prepare(`
  UPDATE health_data_points
  SET marker_id = ?,
      date = ?,
      value = ?,
      source = 'pdf-lab',
      source_file = ?,
      source_id = ?,
      specimen_type = ?,
      excluded = 0,
      exclude_reason = NULL,
      created_at = CASE WHEN ? THEN datetime('now') ELSE created_at END,
      updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
  WHERE id = ?
`);

function pdfLabRowName(name, markerId) {
  return nameToId(name) || nameToId(markerId) || String(markerId || 'row');
}

function nextPdfLabRowId({ labName, markerId, date, counts }) {
  const normalizedName = pdfLabRowName(labName, markerId);
  const key = `${markerId}|${date}|${normalizedName}`;
  const next = (counts.get(key) || 0) + 1;
  counts.set(key, next);
  return `${normalizedName}:${next}`;
}

function pointValueChanged(existingValue, nextValue) {
  const oldValue = Number(existingValue);
  const newValue = Number(nextValue);
  if (!Number.isFinite(oldValue) || !Number.isFinite(newValue)) return String(existingValue) !== String(nextValue);
  return Math.abs(oldValue - newValue) > 1e-9;
}

function upsertPdfLabPoint({ markerId, date, value, filename, sourceId, specimenType }) {
  const existing = getPointBySourceId.get(sourceId);
  if (existing) {
    const materialChanged = pointValueChanged(existing.value, value) || Number(existing.excluded || 0) !== 0;
    const metadataChanged = existing.marker_id !== markerId
      || existing.date !== date
      || existing.source_file !== filename
      || existing.specimen_type !== specimenType;
    if (materialChanged || metadataChanged) {
      updatePointStmt.run(markerId, date, value, filename, sourceId, specimenType, materialChanged ? 1 : 0, existing.id);
      return { status: materialChanged ? 'updated' : 'unchanged', id: existing.id };
    }
    return { status: 'unchanged', id: existing.id };
  }

  const legacy = getLegacyPdfPoints.all(markerId, date, filename);
  if (legacy.length === 1) {
    const row = legacy[0];
    const materialChanged = pointValueChanged(row.value, value) || Number(row.excluded || 0) !== 0;
    const metadataChanged = row.source_id !== sourceId || row.specimen_type !== specimenType;
    if (materialChanged || metadataChanged) {
      updatePointStmt.run(markerId, date, value, filename, sourceId, specimenType, materialChanged ? 1 : 0, row.id);
      return { status: materialChanged ? 'updated' : 'unchanged', id: row.id };
    }
    return { status: 'unchanged', id: row.id };
  }

  const inserted = insertPointStmt.run(markerId, date, value, filename, sourceId, specimenType);
  return { status: 'inserted', id: Number(inserted.lastInsertRowid) };
}

export function savePdfLabValues({ labValues = [], filename, fingerprint, dateHint, dryRun = false } = {}) {
  let inserted = 0, updated = 0, unchanged = 0, skipped = 0;
  const autoCreatedNames = [];
  const rowCounts = new Map();

  for (const lab of labValues) {
    if (!lab.name || lab.value == null) { skipped++; continue; }
    const numValue = parseFloat(lab.value);
    if (isNaN(numValue)) { skipped++; continue; }

    const date = lab.date && /^\d{4}-\d{2}-\d{2}$/.test(lab.date) ? lab.date : dateHint;

    let markerId = resolveMarkerName(lab.name);
    let wasAutoCreated = false;
    if (markerId === undefined) {
      const importedId = nameToId(lab.name);
      if (!importedId) { skipped++; continue; }
      markerId = canonicalizeResolvedMarkerId(importedId, lab.name);
      wasAutoCreated = markerId === importedId;
      if (wasAutoCreated) autoCreatedNames.push(lab.name);
    }
    if (markerId === null) { skipped++; continue; }
    markerId = canonicalizeResolvedMarkerId(markerId, lab.name);

    const flagStr = lab.flag ? ` [${lab.flag}]` : '';
    const autoStr = wasAutoCreated ? ' [auto-created]' : '';
    console.log(`  ${markerId}: ${numValue} ${lab.unit || ''} (${date})${flagStr}${autoStr}`);

    if (dryRun) {
      inserted++;
      continue;
    }

    ensureMarker(markerId, lab.name, lab.unit || '', lab.ref_low, lab.ref_high, { autoCreated: wasAutoCreated });
    const rowId = nextPdfLabRowId({ labName: lab.name, markerId, date, counts: rowCounts });
    const sourceId = healthDataPointSourceId({
      source: 'pdf-lab',
      markerId,
      date,
      value: numValue,
      sourceFile: filename,
      sourceRunId: fingerprint,
      rowId,
    });
    const specimenType = deriveHealthSpecimenType(markerId);
    const result = upsertPdfLabPoint({ markerId, date, value: numValue, filename, sourceId, specimenType });
    if (result.status === 'inserted') inserted++;
    else if (result.status === 'updated') updated++;
    else if (result.status === 'unchanged') unchanged++;
    else skipped++;
    if (result.id) {
      try {
        projectHealthDataPointForDb(db, {
          id: result.id,
          marker_id: markerId,
          date,
          value: numValue,
          source: 'pdf-lab',
          source_file: filename,
          excluded: 0,
        });
      } catch { /* timeline is a projection; recalc can rebuild */ }
    }
  }

  return {
    inserted,
    updated,
    unchanged,
    skipped,
    autoCreated: [...new Set(autoCreatedNames)],
    unmapped: [...new Set(autoCreatedNames)],
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────

/**
 * Import a single lab PDF into health_data_points, in-process (controlled write
 * path). Called by the drop-folder watcher when a lab_report is dropped, so the
 * import runs inside the server/worker process instead of a blocked detached
 * subprocess. Returns a stats object; never calls process.exit. st_fcdbe84f AC7.
 */
export async function importPdfLabs({ file, date = null, dryRun = false, force = false } = {}) {
  const FILE_PATH = resolve(file);
  const DATE_HINT = date;
  const DRY_RUN = dryRun;
  const FORCE = force;
  const filename = basename(FILE_PATH);
  const recordAttempt = async ({ path, count = 0, status = 'ok', error = null, metadata = null } = {}) => {
    if (DRY_RUN) return;
    try {
      await recordIngestion({ source: 'pdf-lab', path, count, status, error, metadata });
    } catch (err) {
      console.warn(`[health] could not record PDF ingestion attempt for ${filename}: ${err.message}`);
    }
  };
  console.log(`=== PDF Lab Import${DRY_RUN ? ' (dry run)' : ''} ===`);
  console.log(`File: ${FILE_PATH}`);

  try { await access(FILE_PATH); }
  catch {
    await recordAttempt({ path: FILE_PATH, status: 'failed', error: 'file_not_found' });
    return { ok: false, inserted: 0, skipped: 0, error: 'file_not_found', file: filename };
  }

  const pdfBuf = await readFile(FILE_PATH);
  const sha256 = createHash('sha256').update(pdfBuf).digest('hex');
  console.log(`SHA256: ${sha256.slice(0, 12)}...`);

  if (!DRY_RUN && !FORCE) {
    const prior = await wasIngested({ source: 'pdf-lab', path: sha256 });
    if (prior) {
      const vaultPath = await preservePdfLabSource(FILE_PATH, filename, sha256);
      return { ok: true, inserted: 0, skipped: 0, alreadyImported: true, file: filename, vaultPath };
    }
  }

  let pdfText = '';
  let usedOcr = false;
  try {
    // The installed pdf-parse exposes a PDFParse class (named export), not a
    // default function — using the class is what actually extracts the text
    // layer; the old `import pdfParse from 'pdf-parse'` was undefined and sent
    // every PDF down the slow OCR fallback. (st_fcdbe84f AC7)
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(pdfBuf), verbosity: 0 });
    const result = await parser.getText({ pages: [] });
    pdfText = result.pages ? result.pages.map((p) => p.text).join('\n') : (result.text || '');
    await parser.destroy?.();
  } catch (err) {
    // pdf-parse failed — OCR fallback will be attempted below
  }

  const dateHint = DATE_HINT || new Date().toISOString().slice(0, 10);
  let labValues;

  if (!pdfText || pdfText.trim().length < 50) {
    console.log('No extractable text — attempting OCR via pdftoppm + Claude vision...');
    let ocrResults;
    try {
      ocrResults = await ocrPdf(FILE_PATH, dateHint);
    } catch (err) {
      await recordAttempt({ path: sha256, status: 'failed', error: `ocr_failed: ${err.message}` });
      return { ok: false, inserted: 0, skipped: 0, error: `ocr_failed: ${err.message}`, file: filename };
    }
    if (!ocrResults || ocrResults.length === 0) {
      const vaultPath = DRY_RUN ? null : await preservePdfLabSource(FILE_PATH, filename, sha256);
      await recordAttempt({ path: sha256, status: 'no_data', error: 'ocr_no_values', metadata: { usedOcr: true } });
      return { ok: false, inserted: 0, skipped: 0, error: 'ocr_no_values', file: filename, ...(vaultPath ? { vaultPath } : {}) };
    }
    labValues = ocrResults;
    usedOcr = true;
    console.log(`OCR extracted ${labValues.length} lab values\n`);
  } else {
    console.log(`Extracted ${pdfText.length} chars of text\n`);

    const userContent = `Date hint: ${dateHint}\n\n---\n\n${pdfText.slice(0, 50000)}`;
    const client = await getProvider('anthropic');

    try {
      const resp = await client.complete({
        model: HAIKU_MODEL,
        max_tokens: 8192,
        system: EXTRACTION_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });

      const text = resp.content.find(b => b.type === 'text')?.text || '';
      const stripped = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      labValues = parseLabJson(stripped);
      if (!Array.isArray(labValues)) throw new Error('Expected JSON array');
    } catch (err) {
      await recordAttempt({ path: sha256, status: 'failed', error: `haiku_extraction_failed: ${err.message}`, metadata: { usedOcr: false, textChars: pdfText.length } });
      return { ok: false, inserted: 0, skipped: 0, error: `haiku_extraction_failed: ${err.message}`, file: filename };
    }

    console.log(`Haiku extracted ${labValues.length} lab values\n`);
  }

  if (labValues.length === 0) {
    const vaultPath = DRY_RUN ? null : await preservePdfLabSource(FILE_PATH, filename, sha256);
    await recordAttempt({ path: sha256, status: 'no_data', error: 'no_lab_values', metadata: { usedOcr, textChars: pdfText.length } });
    return { ok: true, inserted: 0, skipped: 0, note: 'no_lab_values', file: filename, ...(vaultPath ? { vaultPath } : {}) };
  }

  const saved = savePdfLabValues({
    labValues,
    filename,
    fingerprint: sha256,
    dateHint,
    dryRun: DRY_RUN,
  });
  const { inserted, updated, unchanged, skipped, autoCreated: autoCreatedNames } = saved;

  console.log(`\n${DRY_RUN ? 'Would insert' : 'Inserted'}: ${inserted}, refreshed: ${updated}, unchanged: ${unchanged}, skipped: ${skipped}`);

  if (autoCreatedNames.length) {
    const uniqueAutoCreated = [...new Set(autoCreatedNames)];
    console.log(`\nAuto-created lab markers (${uniqueAutoCreated.length}) — review and add curated mappings when appropriate:`);
    for (const n of uniqueAutoCreated) console.log(`  "${n}"`);
  }

  if (!DRY_RUN) {
    const vaultPath = await preservePdfLabSource(FILE_PATH, filename, sha256);
    await recordAttempt({
      path: sha256,
      count: inserted + updated,
      status: 'ok',
      metadata: { extracted: labValues.length, inserted, updated, unchanged, skipped, usedOcr },
    });
    queueHealthIntelRegenerationIfChanged({
      inserted: inserted + updated,
      reason: 'lab_report_import',
    });
    const total = db.prepare('SELECT COUNT(*) as n FROM health_data_points WHERE excluded = 0').get();
    console.log(`\nTotal data points in DB: ${total.n.toLocaleString()}`);
    return { ok: true, inserted, updated, unchanged, skipped, autoCreated: [...new Set(autoCreatedNames)], unmapped: [...new Set(autoCreatedNames)], file: filename, vaultPath };
  }
  return { ok: true, inserted, updated, unchanged, skipped, autoCreated: [...new Set(autoCreatedNames)], unmapped: [...new Set(autoCreatedNames)], file: filename };
}

// CLI entry — only when invoked directly (importing for the watcher must not run).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
  const file = arg('--file');
  if (!file) {
    console.error('Usage: node scripts/import-pdf-labs.js --file <path.pdf> [--date YYYY-MM-DD] [--dry-run] [--force]');
    process.exit(1);
  }
  importPdfLabs({ file, date: arg('--date'), dryRun: args.includes('--dry-run'), force: args.includes('--force') })
    .then((r) => { if (r && r.ok === false) { console.error('Import failed:', r.error); process.exitCode = 1; } })
    .catch((err) => { console.error('Fatal:', err.message); process.exitCode = 1; });
}
