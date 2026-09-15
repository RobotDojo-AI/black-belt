#!/usr/bin/env node
/**
 * Full-vault PDF lab extractor with permanent audit manifest.
 *
 * Processes every PDF in ~/Robot Dojo/health/archive/labs/, extracts lab
 * values via Claude Haiku, inserts into health_data_points, deduplicates
 * against any pre-existing 'pdf' source rows (premerge legacy), and writes
 * a tamper-evident JSON manifest + SHA256 completion hash.
 *
 * Run once, verify forever:
 *   node scripts/extract-all-pdfs.js
 *   node scripts/extract-all-pdfs.js --force      # re-run all, overwrite
 *   node scripts/extract-all-pdfs.js --dry-run     # extract but don't insert
 *   node scripts/extract-all-pdfs.js --concurrency 5
 *
 * Manifest: ~/.robotdojo/reports/pdf-extraction-YYYY-MM-DD.json
 * Verify:   node scripts/extract-all-pdfs.js --verify
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import db from '../lib/db.js';
import { getProvider } from '../lib/llm/index.js';
import { LAB_NAME_MAP } from '../config/lab-name-map.js';
import { ocrPdf } from '../lib/health-pdf-ocr.js';
import { USER_DATABASES_DIR } from '../lib/robotdojo-paths.js';
import { deriveHealthSpecimenType, healthDataPointSourceId } from '../lib/health-data-point-source.js';
import { queueHealthIntelRegenerationIfChanged } from '../lib/health-intel-regeneration.js';
import { savePdfLabValues } from './import-pdf-labs.js';
import { modelFor } from '../lib/model-lane.js';

export const INTELLIGENCE_TIER = 'orchestration';

const args  = process.argv.slice(2);
const DRY   = args.includes('--dry-run');
const FORCE = args.includes('--force');
const VERIFY = args.includes('--verify');
const CONC  = (() => { const i = args.indexOf('--concurrency'); return i !== -1 ? parseInt(args[i+1], 10) : 3; })();
const FILE_FILTER = (() => { const i = args.indexOf('--match'); return i !== -1 ? args[i+1].toLowerCase() : null; })();

const VAULT = join(USER_DATABASES_DIR, 'health', 'archive', 'labs');
const REPORT_DIR = join(homedir(), '.robotdojo', 'reports');
const DATE = new Date().toISOString().slice(0, 10);
const MANIFEST_PATH = join(REPORT_DIR, `pdf-extraction-${DATE}.json`);
const HAIKU = modelFor('fast');

// ─── Preflight: check pdftoppm is installed ───────────────────────────────────

try {
  execFileSync('which', ['pdftoppm'], { stdio: 'ignore' });
} catch {
  console.error('\nERROR: pdftoppm is not installed. Image-based PDFs cannot be OCR\'d.');
  console.error('  Install: brew install poppler\n');
  // Non-fatal: text-based PDFs still work. Warn and continue.
}

// ─── Verify mode ─────────────────────────────────────────────────────────────

if (VERIFY) {
  const latest = readdirSync(REPORT_DIR)
    .filter(f => f.startsWith('pdf-extraction-') && f.endsWith('.json'))
    .sort().reverse()[0];
  if (!latest) { console.error('No manifest found in', REPORT_DIR); process.exit(1); }
  const path = join(REPORT_DIR, latest);
  const raw = readFileSync(path, 'utf8');
  const manifest = JSON.parse(raw);
  const stored = manifest.completion_hash;
  const { completion_hash: _, ...withoutHash } = manifest;
  const computed = createHash('sha256').update(JSON.stringify(withoutHash, null, 2)).digest('hex');
  if (stored === computed) {
    console.log(`✓ Manifest integrity verified: ${latest}`);
    console.log(`  PDFs processed: ${manifest.post_run.pdfs_with_data}`);
    console.log(`  Points inserted: ${manifest.post_run.new_points_inserted}`);
    console.log(`  Completion hash: ${stored}`);
  } else {
    console.error(`✗ INTEGRITY FAILURE: hash mismatch in ${latest}`);
    console.error(`  Stored:   ${stored}`);
    console.error(`  Computed: ${computed}`);
    process.exit(1);
  }
  process.exit(0);
}

// ─── Lab name → marker ID ────────────────────────────────────────────────────
// LAB_NAME_MAP imported from config/lab-name-map.js (canonical source)

function nameToId(name) {
  return (name || '').toLowerCase()
    .replace(/^[%\s]+/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || null;
}

function resolveMarkerId(name) {
  const key = (name || '').toLowerCase().trim();
  // 1. Direct match
  if (Object.prototype.hasOwnProperty.call(LAB_NAME_MAP, key)) return LAB_NAME_MAP[key];
  // 2. Strip parenthetical qualifiers: "ALT (SGPT)" → "alt"
  const noParens = key.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (noParens && noParens !== key && Object.prototype.hasOwnProperty.call(LAB_NAME_MAP, noParens)) return LAB_NAME_MAP[noParens];
  // 3. Before first comma: "25-OH Vitamin D, Total" → "25-oh vitamin d"
  const beforeComma = key.split(',')[0].trim();
  if (beforeComma !== key && Object.prototype.hasOwnProperty.call(LAB_NAME_MAP, beforeComma)) return LAB_NAME_MAP[beforeComma];
  // 4. noParens before comma
  if (noParens.includes(',')) {
    const noParensBeforeComma = noParens.split(',')[0].trim();
    if (Object.prototype.hasOwnProperty.call(LAB_NAME_MAP, noParensBeforeComma)) return LAB_NAME_MAP[noParensBeforeComma];
  }
  // 5. Normalize punctuation (replace commas, parens, slashes with space)
  const norm = key.replace(/[,()\/%]/g, ' ').replace(/\s+/g, ' ').trim();
  if (Object.prototype.hasOwnProperty.call(LAB_NAME_MAP, norm)) return LAB_NAME_MAP[norm];
  // 6. Norm before comma
  const normBeforeComma = norm.split('  ')[0].trim();
  if (normBeforeComma !== norm && Object.prototype.hasOwnProperty.call(LAB_NAME_MAP, normBeforeComma)) return LAB_NAME_MAP[normBeforeComma];
  // 7. Strip trailing qualifier words
  const withoutTrailing = norm.replace(/\s+(total|serum|plasma|blood|direct|indirect|calculated|cal|abs|absolute|count|level|test|screen|titer|pattern|am|pm)$/, '').trim();
  if (withoutTrailing !== norm && Object.prototype.hasOwnProperty.call(LAB_NAME_MAP, withoutTrailing)) return LAB_NAME_MAP[withoutTrailing];
  return undefined;
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

db.prepare(`INSERT OR IGNORE INTO health_groups (id, name, description) VALUES ('labs', 'Lab Results', 'Blood and clinical laboratory results')`).run();

function ensureMarker(markerId, labName, unit, refLow, refHigh, { autoCreated = false } = {}) {
  if (db.prepare('SELECT id FROM health_markers WHERE id = ?').get(markerId)) return;
  const name = labName.replace(/\b\w/g, c => c.toUpperCase()).trim();
  db.prepare(`INSERT OR IGNORE INTO health_markers (id, name, unit, group_id, ref_low, ref_high, auto_created) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(markerId, name, unit || '', 'labs', refLow ?? null, refHigh ?? null, autoCreated ? 1 : 0);
}

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO health_data_points (marker_id, date, value, source, source_file, source_id, specimen_type, excluded, created_at)
  VALUES (?, ?, ?, 'pdf-lab', ?, ?, ?, 0, datetime('now'))
`);

// ─── Check if already ingested via log ───────────────────────────────────────

const checkIngested = db.prepare(`SELECT id, record_count, created_at FROM health_ingestion_log WHERE source = 'pdf-lab' AND file_path = ? LIMIT 1`);
const recordIngested = db.prepare(`
  INSERT INTO health_ingestion_log (id, source, file_path, ingested_date, record_count)
  VALUES (?, 'pdf-lab', ?, ?, ?)
  ON CONFLICT(source, file_path) DO UPDATE SET
    ingested_date = excluded.ingested_date,
    record_count = CASE
      WHEN excluded.record_count > 0 THEN excluded.record_count
      ELSE health_ingestion_log.record_count
    END,
    created_at = CASE
      WHEN excluded.record_count > 0 THEN datetime('now')
      ELSE health_ingestion_log.created_at
    END
`);

function wasIngested(sha256) { return checkIngested.get(sha256) || null; }
function markIngested(sha256, count) {
  recordIngested.run(randomUUID(), sha256, DATE, count);
}

const PROMPT = `Extract ALL lab test results from the following lab report text.

Return a JSON array. Each element must have:
- "name": exact test name as shown in the report
- "value": numeric value only (number, no units)
- "unit": unit of measurement (string)
- "date": collection date in YYYY-MM-DD format (use the date hint if not in report)
- "ref_low": lower bound of reference range (number or null)
- "ref_high": upper bound of reference range (number or null)
- "flag": "H" if high, "L" if low, "N" if normal, null if not indicated

Rules:
- Include EVERY numeric result — vitals, lab panels, urine studies, bone density, body composition
- If date not found in text, use the date hint
- If this is not a lab report or has no numeric values, return []
- Return ONLY the JSON array, no prose, no code fences`;

// ocrPdf imported from lib/health-pdf-ocr.js

// ─── Process one PDF ──────────────────────────────────────────────────────────

async function processPdf(filePath) {
  const filename = basename(filePath);
  const raw = readFileSync(filePath);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const shortHash = sha256.slice(0, 16);

  if (!FORCE) {
    const prior = wasIngested(shortHash);
    if (prior) return { filename, sha256: shortHash, status: 'already-ingested', prior_date: prior.created_at, prior_count: prior.record_count, inserted: 0, autocreated: [] };
  }

  // Extract date hint from filename
  const dateMatch = filename.match(/(\d{4}[-_]\d{2}[-_]\d{2})/);
  const yearMatch = filename.match(/(\d{4})/);
  const dateHint = dateMatch ? dateMatch[1].replace(/_/g, '-') : (yearMatch ? `${yearMatch[1]}-06-01` : DATE);

  let text = '';
  let usedOcr = false;
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(raw), verbosity: 0 });
    const result = await parser.getText({ pages: [] });
    text = result.pages ? result.pages.map(p => p.text).join('\n') : (result.text || '');
    await parser.destroy?.();
  } catch (e) {
    // pdf-parse failed — try OCR
  }

  if (!text || text.trim().length < 50) {
    // No extractable text — attempt OCR via pdftoppm + Claude vision
    const ocrResults = await ocrPdf(filePath, dateHint);
    if (!ocrResults || ocrResults.length === 0) {
      if (!DRY) markIngested(shortHash, 0);
      return { filename, sha256: shortHash, status: 'no-text', inserted: 0, autocreated: [] };
    }
    // OCR extracted values directly — skip LLM text pass, go straight to insert
    usedOcr = true;
    let inserted = 0, updated = 0, unchanged = 0;
    const autocreated = [];
    if (!DRY) {
      const tx = db.transaction((rows) => {
        const saved = savePdfLabValues({
          labValues: rows,
          filename,
          fingerprint: shortHash,
          dateHint,
          dryRun: false,
        });
        inserted = saved.inserted;
        updated = saved.updated;
        unchanged = saved.unchanged;
        autocreated.push(...saved.autoCreated);
      });
      tx(ocrResults);
      markIngested(shortHash, inserted + updated);
    } else {
      for (const r of ocrResults) {
        const id = resolveMarkerId(r.name);
        if (id || (id === undefined && nameToId(r.name))) inserted++;
      }
    }
    if (ocrResults.length === 0 && inserted === 0) {
      return { filename, sha256: shortHash, status: 'no-data', extracted: 0, inserted: 0, autocreated: [], ocr: true };
    }
    return { filename, sha256: shortHash, status: 'ok', extracted: ocrResults.length, inserted, updated, unchanged, autocreated: [...new Set(autocreated)], ocr: true };
  }

  let results = [];
  try {
    const client = await getProvider('anthropic');
    const msg = await client.complete({
      model: HAIKU,
      max_tokens: 4096,
      system: PROMPT,
      messages: [{ role: 'user', content: `Date hint: ${dateHint}\n\nLab report text:\n${text.slice(0, 50000)}` }],
    });
    const raw = msg.content[0]?.text || '[]';
    // Strip markdown fences and find the JSON array
    const stripped = raw.replace(/```(?:json)?\n?/g, '').trim();
    const arrMatch = stripped.match(/\[[\s\S]*\]/);
    const jsonStr = arrMatch ? arrMatch[0] : stripped;
    try {
      results = JSON.parse(jsonStr);
    } catch {
      // Try to recover partial JSON — truncate at last complete object
      const lastClose = jsonStr.lastIndexOf('}');
      if (lastClose > 0) {
        try { results = JSON.parse(jsonStr.slice(0, lastClose + 1) + ']'); } catch {}
      }
    }
    if (!Array.isArray(results)) results = [];
  } catch (e) {
    return { filename, sha256: shortHash, status: 'error', error: `llm: ${e.message}`, inserted: 0, autocreated: [] };
  }

  if (results.length === 0) {
    if (!DRY) markIngested(shortHash, 0);
    return { filename, sha256: shortHash, status: 'no-data', extracted: 0, inserted: 0, autocreated: [] };
  }

  let inserted = 0, updated = 0, unchanged = 0;
  const autocreated = [];

  if (!DRY) {
    const tx = db.transaction((rows) => {
      const saved = savePdfLabValues({
        labValues: rows,
        filename,
        fingerprint: shortHash,
        dateHint,
        dryRun: false,
      });
      inserted = saved.inserted;
      updated = saved.updated;
      unchanged = saved.unchanged;
      autocreated.push(...saved.autoCreated);
    });
    tx(results);
    markIngested(shortHash, inserted + updated);
  } else {
    for (const r of results) {
      const resolved = resolveMarkerId(r.name);
      const id = resolved || (resolved === undefined ? nameToId(r.name) : null);
      if (id) inserted++;
    }
  }

  return { filename, sha256: shortHash, status: 'ok', extracted: results.length, inserted, updated, unchanged, autocreated: [...new Set(autocreated)] };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(VAULT)) { console.error(`Vault not found: ${VAULT}`); process.exit(1); }
  mkdirSync(REPORT_DIR, { recursive: true });

  const allFiles = readdirSync(VAULT).filter(f => extname(f).toLowerCase() === '.pdf').sort();
  const files = FILE_FILTER ? allFiles.filter(f => f.toLowerCase().includes(FILE_FILTER)) : allFiles;
  console.log(`=== PDF Full-Vault Extraction${DRY ? ' (DRY RUN)' : ''} ===`);
  console.log(`Vault: ${VAULT}`);
  console.log(`PDFs:  ${files.length}`);
  console.log(`Conc:  ${CONC}\n`);

  // Pre-run snapshot
  const preTotal = db.prepare('SELECT COUNT(*) as n FROM health_data_points').get().n;
  const prePdf   = db.prepare("SELECT COUNT(*) as n FROM health_data_points WHERE source IN ('pdf', 'pdf-lab')").get().n;
  const preLog   = db.prepare("SELECT COUNT(*) as n FROM health_ingestion_log WHERE source = 'pdf-lab'").get().n;

  const pdfResults = [];
  const queue = files.map(f => join(VAULT, f));

  for (let i = 0; i < queue.length; i += CONC) {
    const batch = queue.slice(i, i + CONC);
    const results = await Promise.all(batch.map(processPdf));
    for (const r of results) {
      pdfResults.push(r);
      const icon = r.status === 'ok' ? '✓' : r.status === 'already-ingested' ? '·' : (r.status === 'no-data' || r.status === 'no-text') ? '-' : '✗';
      const detail = r.status === 'ok' ? `${r.inserted} inserted, ${r.updated || 0} refreshed (${r.extracted} extracted)` :
                     r.status === 'already-ingested' ? `already done (${r.prior_count} pts, ${r.prior_date})` :
                     r.status === 'no-data' ? 'no lab values' :
                     r.status === 'no-text' ? 'no extractable text (scanned/image PDF)' :
                     r.error || r.status;
      console.log(`  ${icon} ${r.filename.slice(0, 65).padEnd(65)} ${detail}`);
    }
  }

  // Post-run snapshot
  const postTotal = db.prepare('SELECT COUNT(*) as n FROM health_data_points').get().n;
  const postPdf   = db.prepare("SELECT COUNT(*) as n FROM health_data_points WHERE source IN ('pdf', 'pdf-lab')").get().n;

  // Deduplication: if (marker_id, date, value) appears in both old 'pdf' source AND new 'pdf-lab',
  // delete the old 'pdf' row (keep the vault-attributed one).
  const dupes = db.prepare(`
    SELECT old.id FROM health_data_points old
    JOIN health_data_points new2 ON old.marker_id = new2.marker_id AND old.date = new2.date AND ABS(old.value - new2.value) < 0.001
    WHERE old.source = 'pdf' AND new2.source = 'pdf-lab'
  `).all();

  let mergedCount = 0;
  if (!DRY && dupes.length > 0) {
    const ids = dupes.map(d => d.id);
    const del = db.prepare(`DELETE FROM health_data_points WHERE id = ?`);
    const mergeTx = db.transaction((ids) => { for (const id of ids) del.run(id); });
    mergeTx(ids);
    mergedCount = dupes.length;
    console.log(`\nMerged ${mergedCount} legacy 'pdf' rows superseded by new vault extractions`);
  }

  const finalTotal = db.prepare('SELECT COUNT(*) as n FROM health_data_points').get().n;

  // Tally results
  const ok         = pdfResults.filter(r => r.status === 'ok').length;
  const alreadyDone = pdfResults.filter(r => r.status === 'already-ingested').length;
  const noData     = pdfResults.filter(r => r.status === 'no-data').length;
  const noText     = pdfResults.filter(r => r.status === 'no-text').length;
  const errors     = pdfResults.filter(r => r.status === 'error').length;
  const newInserted = pdfResults.reduce((s, r) => s + (r.inserted || 0), 0);
  const newUpdated = pdfResults.reduce((s, r) => s + (r.updated || 0), 0);
  if (!DRY) {
    queueHealthIntelRegenerationIfChanged({
      inserted: newInserted + newUpdated,
      reason: 'lab_report_import',
    });
  }

  const allAutocreated = [...new Set(pdfResults.flatMap(r => r.autocreated || []))].sort();

  console.log(`\n=== Summary ===`);
  console.log(`Processed new:  ${ok}`);
  console.log(`Already done:   ${alreadyDone}`);
  console.log(`No lab data:    ${noData + noText}`);
  console.log(`Errors:         ${errors}`);
  console.log(`Points inserted: ${newInserted}`);
  console.log(`Points refreshed: ${newUpdated}`);
  console.log(`Legacy merged:   ${mergedCount}`);
  console.log(`Auto-created markers: ${allAutocreated.length}`);
  console.log(`DB before: ${preTotal} → after: ${finalTotal} (net +${finalTotal - preTotal})`);

  if (allAutocreated.length) {
    console.log(`\nAuto-created markers (${allAutocreated.length}):`);
    allAutocreated.slice(0, 30).forEach(n => console.log(`  "${n}"`));
    if (allAutocreated.length > 30) console.log(`  ... and ${allAutocreated.length - 30} more`);
  }

  // Write manifest
  const manifest = {
    run_date: DATE,
    run_timestamp: new Date().toISOString(),
    vault_path: VAULT,
    dry_run: DRY,
    pre_run: {
      total_points: preTotal,
      pdf_sourced_points: prePdf,
      pdf_ingestion_log_entries: preLog,
    },
    pdfs: pdfResults,
    post_run: {
      pdfs_total: files.length,
      pdfs_with_data: ok,
      pdfs_already_done: alreadyDone,
      pdfs_no_data: noData + noText,
      pdfs_errors: errors,
      new_points_inserted: newInserted,
      existing_points_refreshed: newUpdated,
      legacy_rows_merged: mergedCount,
      total_points_before: preTotal,
      total_points_after: finalTotal,
      net_new_points: finalTotal - preTotal,
    },
    autocreated_markers: allAutocreated,
  };

  // Completion hash — SHA256 of the manifest JSON (without the hash field)
  const manifestJson = JSON.stringify(manifest, null, 2);
  const completionHash = createHash('sha256').update(manifestJson).digest('hex');
  manifest.completion_hash = completionHash;

  if (!DRY) {
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`\n✓ Manifest written: ${MANIFEST_PATH}`);
    console.log(`  Completion hash: ${completionHash}`);
    console.log(`\nTo verify future sessions: node scripts/extract-all-pdfs.js --verify`);
  } else {
    console.log(`\n[dry-run] Manifest would be written to: ${MANIFEST_PATH}`);
    console.log(`  Completion hash (preview): ${completionHash}`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
