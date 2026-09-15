#!/usr/bin/env node
/**
 * scripts/refresh-yc-domains.js — st_b879a361
 *
 * Refresh config/yc-domains.json from yc-oss/api (community-maintained,
 * daily-refreshed mirror of YC's Algolia search index).
 *
 * INTELLIGENCE_TIER: not LLM; deterministic data ingest. No tier declaration
 * needed (script does no LLM calls).
 *
 * USAGE
 *   node scripts/refresh-yc-domains.js            # writes config/yc-domains.json
 *   node scripts/refresh-yc-domains.js --dry-run  # print summary, no write
 *
 * EXIT CODES
 *   0  refresh succeeded (or dry-run produced summary)
 *   1  network error / JSON parse error — existing file is NOT overwritten
 *
 * OUTPUT
 *   config/yc-domains.json — JSON array of lowercase hostnames (deduped, sorted).
 *   stderr: 'error: ...' on failure
 *   stdout: 'records=N domains=N' summary line
 *
 * SOURCE
 *   https://yc-oss.github.io/api/companies/all.json — 5,906 companies as of
 *   2026-05-15. No auth, no rate limit documented.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const ENDPOINT = 'https://yc-oss.github.io/api/companies/all.json';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(SCRIPT_DIR, '..', 'config', 'yc-domains.json');

const isDryRun = process.argv.includes('--dry-run');

function extractHostname(website) {
  if (!website || typeof website !== 'string') return null;
  // Many records have empty string or missing protocol — guard both.
  let url;
  try {
    url = new URL(website.trim());
  } catch {
    // Try prefixing http:// for records missing the scheme.
    try { url = new URL('http://' + website.trim()); }
    catch { return null; }
  }
  let host = url.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  // Skip obviously invalid hosts (single token, no dot).
  if (!host.includes('.')) return null;
  return host;
}

async function main() {
  let records;
  try {
    const res = await fetch(ENDPOINT);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    records = await res.json();
  } catch (err) {
    process.stderr.write(`error: fetch failed (${err.message})\n`);
    process.exit(1);
  }

  if (!Array.isArray(records)) {
    process.stderr.write('error: API did not return an array\n');
    process.exit(1);
  }

  const domains = new Set();
  for (const r of records) {
    const host = extractHostname(r?.website);
    if (host) domains.add(host);
  }

  const sorted = [...domains].sort();
  process.stdout.write(`records=${records.length} domains=${sorted.length}\n`);

  if (isDryRun) {
    process.stdout.write('dry-run: no write\n');
    return;
  }

  // Atomic write — never overwrite with partial data on a fetch error.
  // Tier 0 (refresh script): no encryption, no Keychain, no DB write.
  writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 0) + '\n', 'utf8');
  process.stdout.write(`wrote ${OUT_PATH}\n`);
}

main().catch((err) => {
  process.stderr.write(`error: ${err.stack || err.message}\n`);
  process.exit(1);
});
