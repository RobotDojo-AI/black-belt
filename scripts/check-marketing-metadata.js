#!/usr/bin/env node
/**
 * check-marketing-metadata.js — Marketing-page metadata drift gate.
 *
 * WHY this exists: st_e5665b1e shipped on 2026-05-13 made every robotdojo.ai
 * marketing page emit a complete metadata profile (title, description, robots,
 * canonical, full OpenGraph set, Twitter Card set, ≥1 JSON-LD block). That
 * state is now load-bearing for Google + AI-foundation-model indexing. Any
 * future commit that adds a marketing HTML missing any of those fields, or
 * regresses an existing page, must be blocked at commit time — not caught
 * months later when a SERP audit notices the gap.
 *
 * Scope: walks `apps/*.html` AT THE TOP LEVEL ONLY. Subdirectories
 * (`apps/account/`, `apps/chat/`, etc.) are SPA app shells with their own
 * indexing policy; this gate does not touch them.
 *
 * Exemption: any page carrying `<meta name="robots" content="noindex...">`
 * anywhere in its `<head>` is by definition out-of-index and exempt from the
 * full marketing profile (e.g. `auth-google-guidance.html`). The presence of
 * `noindex` is an explicit declaration that the page is not meant to surface;
 * holding it to the same SEO bar would be wrong.
 *
 * Wire-in: invoked by `scripts/pre-commit.sh` as a stop-the-line check.
 * INTELLIGENCE_TIER = 'extraction' (deterministic regex, zero LLM).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const APPS_DIR = join(REPO_ROOT, 'apps');

// Declared per the INTELLIGENCE_TIER protocol — this script does no LLM work,
// only deterministic string/regex extraction over committed HTML.
export const INTELLIGENCE_TIER = 'extraction';

// Required fields. Each entry: { name, test(headHtml) → boolean }.
const REQUIRED_FIELDS = [
  {
    name: 'title (non-empty)',
    test: (head) => {
      const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      return !!(m && m[1].trim().length > 0);
    },
  },
  {
    name: 'meta description',
    test: (head) => /<meta\s+name="description"\s+content="[^"]+"/i.test(head),
  },
  {
    name: 'meta keywords',
    test: (head) => /<meta\s+name="keywords"/i.test(head),
  },
  {
    name: 'meta robots',
    test: (head) => /<meta\s+name="robots"\s+content="[^"]+"/i.test(head),
  },
  {
    name: 'link canonical',
    test: (head) => /<link\s+rel="canonical"\s+href="[^"]+"/i.test(head),
  },
  {
    name: 'og:title',
    test: (head) => /<meta\s+property="og:title"\s+content="[^"]+"/i.test(head),
  },
  {
    name: 'og:description',
    test: (head) => /<meta\s+property="og:description"\s+content="[^"]+"/i.test(head),
  },
  {
    name: 'og:image',
    test: (head) => /<meta\s+property="og:image"\s+content="[^"]+"/i.test(head),
  },
  {
    name: 'og:url',
    test: (head) => /<meta\s+property="og:url"\s+content="[^"]+"/i.test(head),
  },
  {
    name: 'og:type',
    test: (head) => /<meta\s+property="og:type"\s+content="[^"]+"/i.test(head),
  },
  {
    name: 'twitter:card',
    test: (head) => /<meta\s+name="twitter:card"\s+content="[^"]+"/i.test(head),
  },
  {
    name: 'twitter:title',
    test: (head) => /<meta\s+name="twitter:title"\s+content="[^"]+"/i.test(head),
  },
  {
    name: 'twitter:description',
    test: (head) => /<meta\s+name="twitter:description"\s+content="[^"]+"/i.test(head),
  },
  {
    name: 'twitter:image',
    test: (head) => /<meta\s+name="twitter:image"\s+content="[^"]+"/i.test(head),
  },
  {
    name: 'json-ld (≥1 block)',
    test: (head) => /<script\s+type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/i.test(head),
  },
];

function extractHead(html) {
  const m = html.match(/<head[\s>]([\s\S]*?)<\/head>/i);
  return m ? m[1] : '';
}

function isNoindex(head) {
  // WHY: app shells (account/, chat/, health/, network/, auth-google-guidance)
  // explicitly carry `noindex` because they're authenticated SPA surfaces.
  // Holding them to the marketing-profile bar would falsely flag them.
  return /<meta\s+name="robots"\s+content="[^"]*noindex/i.test(head);
}

function checkFile(absPath, displayPath) {
  const html = readFileSync(absPath, 'utf8');
  const head = extractHead(html);
  if (head === '') {
    return { ok: false, missing: ['<head> block not found'] };
  }
  if (isNoindex(head)) {
    return { ok: true, exempt: true };
  }
  const missing = [];
  for (const field of REQUIRED_FIELDS) {
    if (!field.test(head)) missing.push(field.name);
  }
  return { ok: missing.length === 0, missing };
}

function listTopLevelHtml(dir) {
  return readdirSync(dir)
    .filter((name) => {
      const full = join(dir, name);
      if (!name.endsWith('.html')) return false;
      try {
        return statSync(full).isFile();
      } catch {
        return false;
      }
    })
    .map((name) => ({ abs: join(dir, name), display: `apps/${name}` }));
}

function main() {
  // Explicit subdirectory pages that must meet the same marketing standard.
  // WHY listed explicitly rather than recursing: subdirectories also contain
  // SPA app shells (apps/chat/, apps/account/) that are noindex by design.
  // Recursing would require maintaining an exclusion list; explicit is safer.
  const subdirFiles = [
    { abs: join(APPS_DIR, 'faq', 'index.html'), display: 'apps/faq/index.html' },
  ];
  const files = [...listTopLevelHtml(APPS_DIR), ...subdirFiles];
  if (files.length === 0) {
    console.error(`[check-marketing-metadata] no top-level HTML found in ${APPS_DIR}`);
    process.exit(1);
  }
  let failed = 0;
  let exempt = 0;
  let passed = 0;
  for (const { abs, display } of files) {
    const result = checkFile(abs, display);
    if (result.exempt) {
      exempt++;
      continue;
    }
    if (!result.ok) {
      console.error(`FAIL: ${display} missing: ${result.missing.join(', ')}`);
      failed++;
    } else {
      passed++;
    }
  }
  if (failed > 0) {
    console.error(`[check-marketing-metadata] ${failed} file(s) failed, ${passed} passed, ${exempt} exempt`);
    process.exit(1);
  }
  console.log(`[check-marketing-metadata] ok — ${passed} passed, ${exempt} exempt (noindex)`);
}

// Run when invoked directly. Importable for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
