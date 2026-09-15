#!/usr/bin/env node
/**
 * check-vercel-deployment-freshness.js — proves production is running the
 * exact commit the QA seal is verifying.
 *
 * Design (st_6f81e248): the CLI deploy model (`vercel --prod` from local tree)
 * does not record git metadata Vercel can return via `vercel inspect`. Instead,
 * the local pre-deploy wrapper (`scripts/deploy-vercel.sh`) writes the SHA into
 * apps/static/version.json before upload, and vercel.json rewrites /version.json
 * to that static file. This checker fetches that public URL over HTTPS and
 * compares against the expected SHA and, when supplied, the expected source
 * fingerprint. No Vercel CLI dependency, no scope sensitivity, no git-source
 * metadata.
 *
 * Usage:
 *   node scripts/check-vercel-deployment-freshness.js \
 *     --expected-sha <sha> [--expected-source-fingerprint <hash>] \
 *     --deployment-url <url> \
 *     [--write-inspect <path>]
 *
 * Exits 0 with `PASS deployment freshness <sha>` on match.
 * Exits 1 with `FAIL ...` on fetch error, non-200, or SHA mismatch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
function arg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : '';
}

const expectedSha = arg('--expected-sha');
const expectedSourceFingerprint = arg('--expected-source-fingerprint');
const deploymentUrl = arg('--deployment-url');
const writeInspect = arg('--write-inspect') || 'pipeline/vercel-inspect.json';

if (!expectedSha || !deploymentUrl) {
  console.error('FAIL usage: node scripts/check-vercel-deployment-freshness.js --expected-sha <sha> --deployment-url <url> [--write-inspect <path>]');
  process.exit(1);
}

const fetchedAt = new Date().toISOString();
// Strip trailing slash so URL composition is unambiguous regardless of how the
// caller passes the deployment URL (e.g., "https://robotdojo.ai" or "…/").
const base = deploymentUrl.replace(/\/+$/, '');
const versionUrl = `${base}/version.json`;

function writeArtifact(fetchedSha, extra = {}) {
  const payload = {
    expectedSha,
    expectedSourceFingerprint: expectedSourceFingerprint || null,
    deploymentUrl,
    fetchedSha,
    fetchedAt,
    ...extra,
  };
  mkdirSync(dirname(resolve(writeInspect)), { recursive: true });
  writeFileSync(resolve(writeInspect), JSON.stringify(payload, null, 2) + '\n');
}

let resp;
try {
  resp = await fetch(versionUrl, { redirect: 'follow' });
} catch (err) {
  writeArtifact('', { error: err.message });
  console.error(`FAIL deployment freshness fetch error: ${err.message} (url: ${versionUrl})`);
  process.exit(1);
}

if (!resp.ok) {
  writeArtifact('', { status: resp.status });
  console.error(`FAIL deployment freshness fetch returned ${resp.status} for ${versionUrl}`);
  process.exit(1);
}

let body;
try {
  body = await resp.json();
} catch (err) {
  const text = await resp.text().catch(() => '');
  writeArtifact('', { error: `invalid json: ${err.message}`, body: text.slice(0, 500) });
  console.error(`FAIL deployment freshness invalid JSON at ${versionUrl}: ${err.message}`);
  process.exit(1);
}

const fetchedSha = typeof body?.sha === 'string' ? body.sha : '';
const fetchedSourceFingerprint = typeof body?.source_fingerprint === 'string' ? body.source_fingerprint : '';
writeArtifact(fetchedSha, {
  fetchedSourceFingerprint: fetchedSourceFingerprint || null,
  sourceState: body?.source_state || null,
  buildId: body?.build_id || null,
});

// Accept either an exact match OR a short-SHA prefix match (compat with the
// prior checker, which tolerated 7+-char short SHAs from `vercel inspect`).
const matches = fetchedSha && (expectedSha === fetchedSha || expectedSha.startsWith(fetchedSha));
if (!matches) {
  console.error(`FAIL deployment sha mismatch: expected ${expectedSha}, fetched ${fetchedSha || 'not found'}`);
  process.exit(1);
}

if (expectedSourceFingerprint && expectedSourceFingerprint !== fetchedSourceFingerprint) {
  console.error(`FAIL deployment source fingerprint mismatch: expected ${expectedSourceFingerprint}, fetched ${fetchedSourceFingerprint || 'not found'}`);
  process.exit(1);
}

console.log(`PASS deployment freshness ${fetchedSha}${fetchedSourceFingerprint ? ` ${fetchedSourceFingerprint}` : ''}`);
