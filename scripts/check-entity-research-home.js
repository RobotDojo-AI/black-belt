#!/usr/bin/env node
/**
 * check-entity-research-home.js — detect-only, report-only guard for the
 * entity-research anti-pattern named in design-unified-architecture.md
 * Chunk 7B (st_5184eb86): deep company/person research written as a loose
 * file under a topic/career workbench's substrate/research/ tree instead of
 * the canonical entity home. See docs/entity-research-home.md for the rule.
 *
 * WHY report-only, never a commit gate: this is a name match against the
 * live entity graph, not a structural fact. A false positive (a real topic
 * analysis mistaken for an entity profile) blocking a commit is worse than a
 * missed loose file — the owner would rather see an occasional miss than be
 * blocked on a wrong guess. Always exits 0; findings are printed as an
 * advisory list. Not wired into check-structure.js or pre-commit — run it
 * manually, or read its output when it fires mid-session.
 *
 * HIGH-PRECISION match rule (read before loosening):
 *   1. Scope: files under user/workbenches/topics/**\/substrate/research/**
 *      only. Entity workbenches (user/workbenches/entities/**) are outside
 *      this walk by construction — they are the destination, never flagged.
 *   2. Candidate name = the file's basename (no extension) OR its immediate
 *      parent directory name, each with a leading `YYYY-MM-DD-` date prefix
 *      and a trailing `-fit`/`-profile`/`-research` suffix stripped, then
 *      slugified (lowercase, non-alnum -> '-').
 *   3. Flag ONLY on an exact slug match against a live `companies.name`,
 *      `companies.id`, or `people.display_name` — no substring/fuzzy
 *      matching. A short match (< MIN_SLUG_LEN chars) is excluded as noise.
 *      A person match additionally requires a multi-token display_name (a
 *      real full name) so a bare common first name can never match alone.
 *
 * Read-only: SELECT-only queries against companies/people. No writes, no
 * file moves — this script only reports. lib/db.js is reached via a runtime
 * dynamic import (literal path, so scripts/check-direct-db-writers.js's
 * static analysis still resolves it) so `node --test` unit tests can import
 * the pure matching functions below with an in-memory fixture DB without
 * paying the live-DB boot cost. Registered `manual-only` in
 * config/direct-db-writers.json.
 *
 * INTELLIGENCE_TIER: none — deterministic, no LLM call.
 */
import { readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { REPO_ROOT, USER_WORKBENCHES_REL } from '../lib/robotdojo-paths.js';

export const MIN_SLUG_LEN = 4;
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/;
const SUFFIX_RE = /-(fit|profile|research)$/i;
const RESEARCH_DIR_RE = /(^|\/)substrate\/research\//;

export function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Strips a date prefix and a research-dir suffix before slugifying, so
// "2026-07-19-acme-fit" and "acme" both resolve to the same candidate slug
// "acme".
export function candidateSlug(name) {
  const stripped = String(name || '').replace(DATE_PREFIX_RE, '').replace(SUFFIX_RE, '');
  return slugify(stripped);
}

// Builds a slug -> { type, id, label } map from the live entity graph.
// database must expose .prepare(sql).all() (better-sqlite3 shape).
export function loadKnownEntities(database) {
  const bySlug = new Map();
  const companies = database.prepare(`SELECT id, name FROM companies WHERE name IS NOT NULL AND name != ''`).all();
  for (const c of companies) {
    for (const slug of [slugify(c.name), slugify(c.id)]) {
      if (slug.length >= MIN_SLUG_LEN && !bySlug.has(slug)) {
        bySlug.set(slug, { type: 'company', id: c.id, label: c.name });
      }
    }
  }
  const people = database.prepare(`SELECT id, display_name FROM people WHERE display_name IS NOT NULL AND display_name != ''`).all();
  for (const p of people) {
    const slug = slugify(p.display_name);
    // require a multi-token full name (post-slugify hyphen) — a bare single
    // first name must never match alone, that is the common-word noise case.
    if (slug.length >= MIN_SLUG_LEN && slug.includes('-') && !bySlug.has(slug)) {
      bySlug.set(slug, { type: 'person', id: p.id, label: p.display_name });
    }
  }
  return bySlug;
}

// Recursively finds files whose repo-relative path contains a
// `substrate/research/` segment, rooted at user/workbenches/topics/.
export function findResearchFiles(repoRoot = REPO_ROOT) {
  const topicsRoot = join(repoRoot, USER_WORKBENCHES_REL, 'topics');
  const found = [];
  walk(topicsRoot);
  return found;

  function walk(absPath) {
    let entries;
    try {
      entries = readdirSync(absPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childAbs = join(absPath, entry.name);
      if (entry.isDirectory()) {
        walk(childAbs);
      } else if (entry.isFile()) {
        const rel = relative(repoRoot, childAbs).replace(/\\/g, '/');
        if (RESEARCH_DIR_RE.test(rel)) found.push({ abs: childAbs, rel });
      }
    }
  }
}

// Pure matcher: given the file list and the known-entity map, return flags.
// Exported separately from findResearchFiles/loadKnownEntities so tests can
// exercise the matching logic against synthetic inputs directly.
export function matchResearchFiles(files, knownEntities) {
  const flags = [];
  for (const file of files) {
    const base = basename(file.abs).replace(/\.[^./]+$/, '');
    const parentDir = basename(dirname(file.abs));
    const match = knownEntities.get(candidateSlug(base)) || knownEntities.get(candidateSlug(parentDir));
    if (match) {
      flags.push({
        file: file.rel,
        entity_type: match.type,
        entity_id: match.id,
        entity_label: match.label,
      });
    }
  }
  return flags;
}

export function findMatches({ repoRoot = REPO_ROOT, database } = {}) {
  if (!database) throw new Error('findMatches requires a database (better-sqlite3-shaped .prepare().all())');
  const known = loadKnownEntities(database);
  const files = findResearchFiles(repoRoot);
  return matchResearchFiles(files, known);
}

function canonicalHome(entityType) {
  const dir = entityType === 'company' ? 'companies' : 'people';
  return `user/workbenches/entities/${dir}/.../wk_.../`;
}

// ── CLI ──────────────────────────────────────────────────────────────────
async function main() {
  const { default: db } = await import('../lib/db.js');
  const flags = findMatches({ database: db });
  if (flags.length === 0) {
    console.log('[check-entity-research-home] ok — no loose entity research found under user/workbenches/topics/**/substrate/research/**');
    return;
  }
  console.warn(`[check-entity-research-home] advisory — ${flags.length} research file(s) look like entity profiles written outside the canonical entity home:`);
  for (const flag of flags) {
    console.warn(`  ${flag.file}`);
    console.warn(`    matches known ${flag.entity_type}: "${flag.entity_label}" (id=${flag.entity_id})`);
    console.warn(`    canonical home: ${canonicalHome(flag.entity_type)} — run /profile "${flag.entity_label}" <url>, then reference it from here`);
  }
  console.warn('Report-only — this does not block the commit. See docs/entity-research-home.md.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(`[check-entity-research-home] error: ${err.message}`);
    process.exit(0); // report-only — never fail the caller on an internal error either
  });
}
