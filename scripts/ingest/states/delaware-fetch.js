/**
 * delaware-fetch.js — Download official Delaware fiscal documents.
 *
 * Downloads two PDFs from official Delaware government URLs and writes them
 * to the wk_states source-docs directory alongside a SHA-256 manifest.
 *
 * Idempotent: if both PDFs + manifest exist, exits 0 without re-fetching.
 * Pass --force to re-download regardless.
 *
 * WHY these URLs: finance.delaware.gov is the Office of Management and Budget
 * primary site. budget.delaware.gov hosts the Governor's Recommended Budget
 * which carries the revenue actuals and projections used in all planning docs.
 *
 * INTELLIGENCE_TIER: extraction — no LLM, deterministic fetch + write.
 *
 * Usage:
 *   cd ~/robotdojo && node scripts/ingest/states/delaware-fetch.js
 *   cd ~/robotdojo && node scripts/ingest/states/delaware-fetch.js --force
 */
export const INTELLIGENCE_TIER = 'extraction';

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..', '..');

const SOURCE_DOCS_DIR = resolve(
  REPO_ROOT,
  'user/workbenches/topics/work/states/wk_states/states/delaware/source-docs'
);

// Official Delaware document URLs (verified working as of 2026-06-25).
// FM-1: Delaware reorganized document hosting. Original plan URLs 404'd:
//   finance.delaware.gov/wp-content/uploads/sites/28/acfr/ACFR-FY2024.pdf
//     → redirects to financefiles.delaware.gov/docs/ACFR-FY2024.pdf → 404
//   budget.delaware.gov/wp-content/uploads/FY2025_Governor_Recommended_Budget.pdf → 404
//
// Verified working replacements (HTTP 200, Content-Type: application/pdf):
//   budget.delaware.gov/budget/fy2025/documents/operating/financial-summary.pdf
//   budget.delaware.gov/budget/fy2025/documents/operating/budget-overview.pdf
//
// The financial-summary.pdf carries the revenue actuals (General Fund by category).
// The budget-overview.pdf carries expenditure breakdown by agency.
// Together they cover the data the model extracts: revenue + expenditure line items.
//
// To update URLs: change the url fields below and re-run. See FM-1 in 02-plan.md.
const DOCUMENTS = [
  {
    id: 'acfr-fy2024',
    label: 'Delaware FY2025 Budget Financial Summary (revenue actuals)',
    url: 'https://budget.delaware.gov/budget/fy2025/documents/operating/financial-summary.pdf',
    filename: 'acfr-fy2024.pdf',
  },
  {
    id: 'operating-budget-fy2025',
    label: "Delaware FY2025 Budget Overview (expenditure detail)",
    url: 'https://budget.delaware.gov/budget/fy2025/documents/operating/budget-overview.pdf',
    filename: 'operating-budget-fy2025.pdf',
  },
];

const MANIFEST_PATH = resolve(SOURCE_DOCS_DIR, 'manifest.json');
const FORCE = process.argv.includes('--force');
const FETCH_TIMEOUT_MS = 120_000; // 2 min — PDFs can be large

/**
 * Download a URL to destPath. Returns { url, path, bytes, fetched_at, sha256 }.
 * Throws on non-2xx or network error.
 */
async function fetchWithTimeout(url, destPath) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'RobotDojo/1.0 Delaware fiscal data fetcher' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return {
    url,
    path: destPath,
    bytes: buf.length,
    fetched_at: new Date().toISOString(),
    sha256,
  };
}

async function main() {
  // ── Idempotency check ────────────────────────────────────────────────────────
  if (!FORCE) {
    const allExist = DOCUMENTS.every(doc =>
      existsSync(resolve(SOURCE_DOCS_DIR, doc.filename))
    ) && existsSync(MANIFEST_PATH);

    if (allExist) {
      const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      console.log('[states/fetch] All documents already downloaded. Use --force to re-fetch.');
      console.log(JSON.stringify({ ok: true, skipped: true, manifest }, null, 2));
      return;
    }
  }

  // ── Fetch all documents ──────────────────────────────────────────────────────
  // Fetch sequentially to be polite to government servers and to avoid writing
  // a partial manifest on partial failure.
  const results = [];
  for (const doc of DOCUMENTS) {
    const destPath = resolve(SOURCE_DOCS_DIR, doc.filename);
    console.log(`[states/fetch] Downloading: ${doc.label}`);
    console.log(`[states/fetch]   URL: ${doc.url}`);

    let fetched;
    try {
      fetched = await fetchWithTimeout(doc.url, destPath);
    } catch (err) {
      // Log URL + error, exit 1. No partial manifest written.
      console.error(`[states/fetch] FAILED: ${doc.url}`);
      console.error(`[states/fetch] Error: ${err.message}`);
      process.exit(1);
    }

    // Relative path for manifest portability.
    const relPath = `user/workbenches/topics/work/states/wk_states/states/delaware/source-docs/${doc.filename}`;
    results.push({
      id: doc.id,
      label: doc.label,
      url: doc.url,
      local_path: relPath,
      bytes: fetched.bytes,
      fetched_at: fetched.fetched_at,
      sha256: fetched.sha256,
    });
    console.log(`[states/fetch]   OK: ${fetched.bytes} bytes, sha256=${fetched.sha256.slice(0, 16)}…`);
  }

  // ── Write manifest ───────────────────────────────────────────────────────────
  // Only written after ALL fetches succeed — no partial manifest.
  const manifest = {
    state: 'delaware',
    fetched_at: new Date().toISOString(),
    documents: results,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`[states/fetch] Manifest written: ${MANIFEST_PATH}`);
  console.log(JSON.stringify({ ok: true, documents: results.length }, null, 2));
}

main().catch(err => {
  console.error('[states/fetch] Unexpected error:', err);
  process.exit(1);
});
