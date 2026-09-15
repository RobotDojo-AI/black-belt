#!/usr/bin/env node
/**
 * Backfill LLM exports from GCS.
 * Downloads today's (2026-04-27) LLM export files from GCS, runs them through
 * route-llm-export.js. Idempotent — re-running produces no duplicate rows.
 *
 * Usage: ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/backfill-llm-exports.js
 *
 * Compute tier: Tier 0 only — structural parsing. No LLM calls in route-llm-export.js.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';
import { routeLlmExport } from '../lib/drop-folder/route-llm-export.js';

const BUCKET = 'gs://miyagi-backup-ak/imports';
const DATE_PREFIX = '2026-04-27';

// Discover GCS keys for today
function listGcsFiles() {
  const result = spawnSync('gsutil', ['ls',
    `${BUCKET}/${DATE_PREFIX}-*.json`,
    `${BUCKET}/${DATE_PREFIX}-*.zip`,
  ], { encoding: 'utf8' });
  if (result.error) { console.error('gsutil not available:', result.error.message); process.exit(1); }
  return (result.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
}

// Download a single GCS file to a temp dir
function downloadFile(gcsUrl, destDir) {
  const name = basename(gcsUrl);
  const dest = join(destDir, name);
  const r = spawnSync('gsutil', ['-q', 'cp', gcsUrl, dest], { encoding: 'utf8' });
  if (r.status !== 0) { console.warn(`  download failed: ${gcsUrl}`); return null; }
  return dest;
}

// Extract a zip to a temp dir, return list of extracted file paths
function extractZip(zipPath, destDir) {
  const r = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) { // unzip exits 1 on warnings
    console.warn(`  unzip failed for ${basename(zipPath)}: ${r.stderr}`);
    return [];
  }
  return collectFiles(destDir);
}

function collectFiles(dir) {
  const results = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) results.push(...collectFiles(full));
    else results.push(full);
  }
  return results;
}

async function main() {
  const tmpBase = mkdtempSync(join(tmpdir(), 'rdjollm-'));
  let totalFiles = 0, totalNew = 0, totalSkip = 0;

  try {
    const gcsUrls = listGcsFiles();
    console.log(`Found ${gcsUrls.length} GCS files matching ${DATE_PREFIX}-*.{json,zip}`);

    for (const url of gcsUrls) {
      const ext = extname(url).toLowerCase();
      const name = basename(url);

      // Skip non-LLM files
      if (!/\.(json|zip)$/.test(ext)) continue;
      if (/\.(pdf|xlsx|xls|csv|png|jpg)$/.test(ext)) continue;

      const fileDir = mkdtempSync(join(tmpBase, 'dl-'));

      if (ext === '.zip') {
        const zipPath = downloadFile(url, fileDir);
        if (!zipPath) continue;

        const extractDir = mkdtempSync(join(tmpBase, 'ex-'));
        const extracted = extractZip(zipPath, extractDir);

        for (const filePath of extracted) {
          const fn = basename(filePath).toLowerCase();
          if (!fn.endsWith('.json') && !fn.endsWith('.jsonl')) continue;
          if (/^(messages|users|projects|memories)\.json$/.test(fn) && fn !== 'conversations.json' && fn !== 'conversations.jsonl') continue;

          console.log(`  processing (from zip): ${name} → ${fn}`);
          totalFiles++;
          try {
            const result = await routeLlmExport({ path: filePath, originalName: fn });
            const parsed = result.extracted_json ? JSON.parse(result.extracted_json) : {};
            totalNew += parsed.new_count || 0;
            totalSkip += parsed.skip_count || 0;
            console.log(`    ${fn}: ${parsed.new_count || 0} new, ${parsed.skip_count || 0} skipped (provider: ${parsed.provider})`);
          } catch (err) {
            console.warn(`    error: ${err.message}`);
          }
        }
      } else {
        // Direct JSON file
        const fn = name.replace(/^2026-04-27-/, ''); // strip date prefix for originalName detection
        console.log(`  processing: ${fn}`);
        totalFiles++;
        const filePath = downloadFile(url, fileDir);
        if (!filePath) continue;

        try {
          const result = await routeLlmExport({ path: filePath, originalName: fn });
          const parsed = result.extracted_json ? JSON.parse(result.extracted_json) : {};
          totalNew += parsed.new_count || 0;
          totalSkip += parsed.skip_count || 0;
          console.log(`    ${fn}: ${parsed.new_count || 0} new, ${parsed.skip_count || 0} skipped (provider: ${parsed.provider})`);
        } catch (err) {
          console.warn(`    error: ${err.message}`);
        }
      }
    }
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }

  console.log(`\nBackfill complete: processed ${totalFiles} files, imported ${totalNew} new conversations, skipped ${totalSkip} duplicates`);
}

main().catch(err => { console.error('Backfill failed:', err); process.exit(1); });
