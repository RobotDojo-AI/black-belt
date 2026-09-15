#!/usr/bin/env node
/**
 * generate-marketing-sitemap.js — Auto-generate apps/static/sitemap.xml from
 * apps/*.html top-level marketing pages.
 *
 * WHY this exists (and not in the existing generate-sitemap.js): the existing
 * generate-sitemap.js writes the *codebase* SITEMAP.md (a Tantei
 * pre-computation that maps routes/, lib/, migrations/). This script writes
 * the *marketing* XML sitemap consumed by Google + Bing crawlers. Different
 * outputs, different consumers, different cadences — kept as separate
 * scripts to avoid coupling them.
 *
 * WHY this exists at all: prior to st_e5665b1e's self-enforcement amendment,
 * apps/static/sitemap.xml was hand-maintained. Every new marketing page
 * required a manual edit; every `<lastmod>` drifted from the actual file
 * mtime; the bug that prompted this work (hardcoded article dates) was a
 * class of drift the marketing-metadata gate alone couldn't catch.
 * Auto-generating from the filesystem + git makes drift impossible: the
 * sitemap IS the marketing-page set, by construction.
 *
 * WHY git log for lastmod (vs file mtime): file mtime resets on every
 * `git checkout` to an unrelated commit, so it tracks "when did this
 * working copy last touch this file" — not "when did this page last
 * meaningfully change". `git log -1 --format=%cI -- <file>` returns the
 * commit time of the most recent commit touching the file, which is what
 * sitemap consumers (Google, Bing) actually want. Falls back to today's
 * date for unstaged-but-tracked files.
 *
 * Output: stable, byte-identical for a given git state. Pre-commit hook
 * regenerates and stages it.
 *
 * Exclusions: pages with `<meta name="robots" content="noindex...">` in
 * their <head> are out-of-index by declaration; they don't belong in a
 * sitemap meant to drive crawl coverage.
 *
 * INTELLIGENCE_TIER = 'extraction' (deterministic, no LLM).
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const APPS_DIR = join(REPO_ROOT, 'apps');
const SITEMAP_PATH = join(REPO_ROOT, 'apps', 'static', 'sitemap.xml');

export const INTELLIGENCE_TIER = 'extraction';

const SITE_BASE = 'https://robotdojo.ai';

// Priority + changefreq table. Homepage gets 1.0 because it's the canonical
// entry. Legal pages are reference material, low change rate.
//
// Subdirectory marketing pages (e.g. apps/faq/index.html) are keyed by their
// subdirectory name with a leading 'subdir:' marker so the inventory walk can
// detect them. WHY this shape (vs a separate map): keeps one table = one
// source of truth for sitemap rows; the walker below scans both top-level
// apps/*.html and the explicit subdir list.
const URL_METADATA = {
  'index.html':       { slug: '/',           priority: '1.0', changefreq: 'weekly'  },
  'privacy.html':     { slug: '/privacy',    priority: '0.5', changefreq: 'monthly' },
  'terms.html':       { slug: '/terms',      priority: '0.5', changefreq: 'monthly' },
  'licensing.html':   { slug: '/licensing',  priority: '0.5', changefreq: 'monthly' },
};

// Subdirectory marketing pages — apps/{name}/index.html that should appear in
// the public sitemap. st_85ca4f3c added /faq as a self-contained public app
// duplicate (lives at apps/faq/index.html, not apps/faq.html), so the walker
// must look in subdirectories as well as the top level.
const SUBDIR_MARKETING_PAGES = {
  'faq': { slug: '/faq', priority: '0.6', changefreq: 'weekly' },
};

function extractHead(html) {
  const m = html.match(/<head[\s>]([\s\S]*?)<\/head>/i);
  return m ? m[1] : '';
}

function isNoindex(head) {
  return /<meta\s+name="robots"\s+content="[^"]*noindex/i.test(head);
}

function gitLastModifiedDate(absPath) {
  // %cI = strict ISO 8601 committer date. -1 = most recent commit only.
  // Returns null if file is untracked (never committed yet) — caller falls
  // back to today.
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%cI', '--', absPath],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    ).trim();
    if (!out) return null;
    // Trim time component — sitemap.org spec accepts either W3C-DTF date OR
    // full datetime, but Google's crawler treats date-only as canonical.
    return out.split('T')[0];
  } catch {
    return null;
  }
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

// Tracked top-level apps/*.html basenames. WHY tracked-only (df_2962486a class):
// a bare readdirSync(APPS_DIR) enumerates untracked dev-machine *.html that
// CI's tracked-only clone never sees, so dev output diverges from CI and a
// freshness --check fails on a clean merge. `git ls-files apps/*.html` matches
// exactly what CI's clone contains. Falls back to no filter if git is
// unavailable.
function trackedAppsHtml() {
  try {
    const out = execSync('git ls-files apps/*.html', { cwd: REPO_ROOT, encoding: 'utf8' });
    return new Set(
      out.split('\n').filter(Boolean).map((p) => basename(p)),
    );
  } catch {
    return null;
  }
}

function listTopLevelHtml() {
  const tracked = trackedAppsHtml();
  return readdirSync(APPS_DIR)
    .filter((name) => {
      const full = join(APPS_DIR, name);
      if (!name.endsWith('.html')) return false;
      if (tracked && !tracked.has(name)) return false; // tracked-only (matches CI clone)
      try {
        return statSync(full).isFile();
      } catch {
        return false;
      }
    })
    .map((name) => ({ name, abs: join(APPS_DIR, name) }));
}

// st_85ca4f3c — discover subdirectory marketing pages (apps/{name}/index.html)
// listed in SUBDIR_MARKETING_PAGES. Returns the same {name, abs} shape as
// listTopLevelHtml so the main loop can treat them uniformly.
function listSubdirMarketingHtml() {
  const out = [];
  for (const [dirName, _meta] of Object.entries(SUBDIR_MARKETING_PAGES)) {
    const abs = join(APPS_DIR, dirName, 'index.html');
    try {
      if (statSync(abs).isFile()) {
        // Use a synthetic name `${dirName}/index.html` so URL_METADATA lookup
        // misses (we read SUBDIR_MARKETING_PAGES separately in main()).
        out.push({ name: `${dirName}/index.html`, abs, subdir: dirName });
      }
    } catch {
      console.error(`[generate-marketing-sitemap] WARNING: subdir page ${abs} declared but missing`);
    }
  }
  return out;
}

// Render the sitemap XML in memory. Single code path for write + --check so the
// two modes cannot diverge. Returns { xml, urlCount }.
function render() {
  const files = [...listTopLevelHtml(), ...listSubdirMarketingHtml()];
  const urls = [];
  for (const entry of files) {
    const { name, abs, subdir } = entry;
    const html = readFileSync(abs, 'utf8');
    const head = extractHead(html);
    if (isNoindex(head)) continue; // exclude out-of-index pages
    let meta;
    if (subdir) {
      meta = SUBDIR_MARKETING_PAGES[subdir];
    } else {
      meta = URL_METADATA[name];
      if (!meta) {
        // Indexable but unknown to the priority table — include with defaults
        // so a forgotten new page still lands in the sitemap, just at default
        // priority. Add an entry to URL_METADATA to override.
        console.error(`[generate-marketing-sitemap] WARNING: ${name} not in URL_METADATA; using defaults`);
      }
    }
    const slug = meta?.slug ?? `/${basename(name, '.html')}`;
    const priority = meta?.priority ?? '0.5';
    const changefreq = meta?.changefreq ?? 'monthly';
    const lastmod = gitLastModifiedDate(abs) ?? todayIso();
    urls.push({ slug, priority, changefreq, lastmod });
  }

  // Sort by priority desc, then slug asc — stable ordering for byte-identical
  // output across runs.
  urls.sort((a, b) => {
    const pd = parseFloat(b.priority) - parseFloat(a.priority);
    if (pd !== 0) return pd;
    return a.slug.localeCompare(b.slug);
  });

  const xmlLines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const u of urls) {
    xmlLines.push(
      `  <url><loc>${SITE_BASE}${u.slug}</loc><lastmod>${u.lastmod}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`
    );
  }
  xmlLines.push('</urlset>');
  xmlLines.push(''); // trailing newline

  return { xml: xmlLines.join('\n'), urlCount: urls.length };
}

// <lastmod> derives from each page's git-commit date (gitLastModifiedDate), which
// is REFLEXIVE: committing a page moves its date, so the sitemap.xml committed in
// that same commit is instantly one-commit-stale. That is metadata churn, not
// content drift. --check therefore compares with the dates normalized out (same
// spirit as ontology/sitemap --check normalizing their generated-date line) — it
// catches real structural drift (URLs, priority, changefreq, added/removed pages)
// without false-failing on the inherent lastmod reflexivity (st_fdd414de).
function stripLastmod(xml) {
  return String(xml).replace(/<lastmod>[^<]*<\/lastmod>/g, '<lastmod/>');
}

// Mode dispatch (st_fdd414de AC5). No-arg / --write keep the original write
// behavior. --check renders in memory and compares (lastmod-normalized) to the
// committed sitemap.xml, exiting 1 on structural drift and 0 on match — so the
// drift meta-test gates this generator the same way as ontology/sitemap.
function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--check') ? 'check' : 'write';
  const { xml, urlCount } = render();

  if (mode === 'check') {
    let actual = null;
    try { actual = readFileSync(SITEMAP_PATH, 'utf8'); } catch { actual = null; }
    if (actual === null || stripLastmod(actual) !== stripLastmod(xml)) {
      process.stderr.write(
        `[generate-marketing-sitemap --check] FAIL — stale output:\n  ${SITEMAP_PATH}\n` +
        `Fix: node scripts/generate-marketing-sitemap.js --write\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`[generate-marketing-sitemap --check] OK — ${urlCount} URLs match\n`);
    process.exit(0);
  }

  writeFileSync(SITEMAP_PATH, xml);
  console.log(`[generate-marketing-sitemap] wrote ${SITEMAP_PATH} (${urlCount} URLs)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
