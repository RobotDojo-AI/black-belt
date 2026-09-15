#!/usr/bin/env node
/**
 * check-marketing-files.js — sitewide invariants for marketing static files.
 *
 * WHY this is separate from check-marketing-metadata.js: that one is per-page
 * (does each HTML file carry the required <head> metadata). This one is
 * sitewide (do the supporting static files exist and have the required
 * shape). Splitting them keeps each script's purpose clear.
 *
 * Checks (all must pass for the pre-commit hook to succeed):
 *   1. apps/static/og-image.png exists and is > 0 bytes
 *   2. apps/static/robots.txt has explicit blocks for the 7 AI bots
 *      (GPTBot, ClaudeBot, Google-Extended, PerplexityBot, CCBot,
 *      Applebot-Extended, OAI-SearchBot)
 *   3. apps/static/llms.txt exists and starts with "# Robot Dojo"
 *   4. apps/static/llms-full.txt exists and is ≥ 2 KB (the corpus must
 *      contain real content, not just a header)
 *   5. apps/static/sitemap.xml has <lastmod> on every <url> (defense in
 *      depth — generate-marketing-sitemap.js already guarantees this, but
 *      a manual edit could break it)
 *
 * INTELLIGENCE_TIER = 'extraction' (deterministic, no LLM).
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const STATIC_DIR = join(REPO_ROOT, 'apps', 'static');

export const INTELLIGENCE_TIER = 'extraction';

const AI_BOTS = [
  'GPTBot',
  'ClaudeBot',
  'Google-Extended',
  'PerplexityBot',
  'CCBot',
  'Applebot-Extended',
  'OAI-SearchBot',
];

function fail(msg) {
  console.error(`[check-marketing-files] FAIL: ${msg}`);
  process.exit(1);
}

function checkOgImage() {
  const path = join(STATIC_DIR, 'og-image.png');
  if (!existsSync(path)) fail('apps/static/og-image.png is missing — marketing pages reference it as og:image');
  const size = statSync(path).size;
  if (size === 0) fail('apps/static/og-image.png is 0 bytes');
  return `og-image.png ok (${size} bytes)`;
}

function checkRobots() {
  const path = join(STATIC_DIR, 'robots.txt');
  if (!existsSync(path)) fail('apps/static/robots.txt is missing');
  const txt = readFileSync(path, 'utf8');
  const missing = AI_BOTS.filter((b) => !new RegExp(`^User-agent:\\s*${b}$`, 'm').test(txt));
  if (missing.length) fail(`robots.txt missing User-agent blocks for: ${missing.join(', ')}`);
  return `robots.txt ok (${AI_BOTS.length} AI bot blocks)`;
}

function checkLlms() {
  const path = join(STATIC_DIR, 'llms.txt');
  if (!existsSync(path)) fail('apps/static/llms.txt is missing — run scripts/generate-public-truth.js');
  const txt = readFileSync(path, 'utf8');
  if (!txt.startsWith('# Robot Dojo')) fail('llms.txt does not start with "# Robot Dojo" (llmstxt.org spec violation)');
  if (!/^> /m.test(txt)) fail('llms.txt missing the blockquote summary line (llmstxt.org spec)');
  return `llms.txt ok (${txt.length} bytes)`;
}

function checkLlmsFull() {
  const path = join(STATIC_DIR, 'llms-full.txt');
  if (!existsSync(path)) fail('apps/static/llms-full.txt is missing — run scripts/generate-public-truth.js');
  const size = statSync(path).size;
  // WHY 2KB threshold: the file structure header alone (h1 + blockquote +
  // long descriptor + 6 section dividers) is roughly 1KB. A real corpus of
  // 6 marketing pages produces ~15–35KB. 2KB catches the "headers only,
  // body extraction broken" failure mode without being so strict that a
  // future minor content trim breaks the check.
  if (size < 2048) fail(`llms-full.txt is suspiciously small (${size} bytes) — body-text extraction may be broken`);
  return `llms-full.txt ok (${size} bytes)`;
}

function checkSitemap() {
  const path = join(STATIC_DIR, 'sitemap.xml');
  if (!existsSync(path)) fail('apps/static/sitemap.xml is missing');
  const xml = readFileSync(path, 'utf8');
  const locs = (xml.match(/<loc>/g) || []).length;
  const mods = (xml.match(/<lastmod>/g) || []).length;
  if (locs === 0) fail('sitemap.xml has zero <url> entries');
  if (locs !== mods) fail(`sitemap.xml has ${locs} <loc> entries but ${mods} <lastmod> entries (must match)`);
  return `sitemap.xml ok (${locs} URLs, all with lastmod)`;
}

function main() {
  const results = [
    checkOgImage(),
    checkRobots(),
    checkLlms(),
    checkLlmsFull(),
    checkSitemap(),
  ];
  for (const r of results) console.log(`[check-marketing-files] ${r}`);
  console.log('[check-marketing-files] ok');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
