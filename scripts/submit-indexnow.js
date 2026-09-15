#!/usr/bin/env node
/**
 * submit-indexnow.js — post-deploy URL ping to api.indexnow.org
 *
 * IndexNow is the canonical push mechanism for Bing, Yandex, Naver, Seznam, and
 * Yep. Google does NOT participate (its Indexing API is JobPosting/BroadcastEvent
 * only — using it for marketing pages risks API revocation, per Hakase research).
 * For Google, optimized sitemap + lastmod remains the documented signal.
 *
 * Flow:
 *   1. Read sitemap.xml (apps/static/sitemap.xml on this host).
 *   2. Extract all <loc>URL</loc> entries.
 *   3. POST { host, key, urlList } to https://api.indexnow.org/indexnow.
 *
 * Key file: apps/static/indexnow-key.txt (one-line 32-char hex). Generated
 * once via crypto.randomBytes(16).toString('hex'); committed (not a secret,
 * just an ownership token). Verification file at https://{host}/{key}.txt.
 *
 * Flags:
 *   --dry-run            Print the JSON body to stdout, do not POST.
 *   --host <hostname>    Override host (default: robotdojo.ai).
 *   --sitemap <path>     Override sitemap path (default: apps/static/sitemap.xml).
 *
 * Exit codes: 0 success, 1 error (network/sitemap/key missing).
 *
 * Tier: orchestration. No LLM calls; deterministic URL extraction + HTTP POST.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INTELLIGENCE_TIER = 'orchestration';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const HOST = arg('host', 'robotdojo.ai');
const SITEMAP = arg('sitemap', resolve(REPO_ROOT, 'apps', 'static', 'sitemap.xml'));
const KEY_FILE = arg('key-file', resolve(REPO_ROOT, 'apps', 'static', 'indexnow-key.txt'));

function readKey() {
  if (!existsSync(KEY_FILE)) {
    console.error(`error: key file missing: ${KEY_FILE}`);
    process.exit(1);
  }
  const key = readFileSync(KEY_FILE, 'utf8').trim();
  if (!key || key.length < 8) {
    console.error(`error: key file empty or too short: ${KEY_FILE}`);
    process.exit(1);
  }
  return key;
}

function readSitemapUrls() {
  if (!existsSync(SITEMAP)) {
    console.error(`error: sitemap missing: ${SITEMAP}`);
    process.exit(1);
  }
  const xml = readFileSync(SITEMAP, 'utf8');
  const urls = [];
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    urls.push(m[1].trim());
  }
  return urls;
}

async function main() {
  const key = readKey();
  const urlList = readSitemapUrls();
  if (urlList.length === 0) {
    console.error('error: no URLs in sitemap');
    process.exit(1);
  }
  const body = { host: HOST, key, urlList };

  if (DRY_RUN) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // IndexNow returns 200/202 for accepted, 400 for invalid request, 422 for
  // invalid URLs (e.g., not the same host). Log the status; treat 2xx as ok.
  console.log(`IndexNow: ${res.status} ${res.statusText} — ${text || '(no body)'}`);
  if (res.status >= 400) process.exit(1);
}

main().catch((e) => {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
});
