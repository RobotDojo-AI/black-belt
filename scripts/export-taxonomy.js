#!/usr/bin/env node
/**
 * export-taxonomy — port a user's T1/T2 topic tree from an old Miyagi DB
 * to `~/.robotdojo/taxonomy.user.json`.
 *
 * Reads the flat `user_topics` table (slug, label, description, sort_order,
 * icon, visible, context_md) from a source SQLite DB, buckets each slug into
 * its T1 tier by consulting lib/taxonomy-default.js, and writes a portable
 * JSON file that the customer-side install can consume.
 *
 * Usage:
 *   node scripts/export-taxonomy.js --from ~/.robotdojo/robotdojo.db \
 *                                   --to   ~/.robotdojo/taxonomy.user.json
 *
 * Design:
 *   - Source DB is opened read-only. Never writes.
 *   - Idempotent: two runs produce byte-identical output (minus `exported_at`,
 *     so we keep the date stable when reading an unchanged DB — see below).
 *   - Empty source table is handled: emits an empty topics object with a
 *     clear note, does not crash.
 *   - Output wraps tier data with metadata (`version`, `exported_at`,
 *     `source_db`) AND emits each tier's subtopics under BOTH `subtopics`
 *     (per migration-plan spec) and `topics` (what lib/taxonomy.js reads
 *     today). Dual-key layout keeps the loader happy without touching it.
 *
 * Exit codes:
 *   0 — success
 *   1 — source DB missing, schema unexpected, or write failure
 */

import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_TIERS } from '../lib/taxonomy-default.js';

// --- Args -----------------------------------------------------------------

function parseArgs(argv) {
  const out = { from: null, to: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return resolve(p);
}

function usage() {
  console.info('Usage: node scripts/export-taxonomy.js --from <src.db> --to <dest.json>');
  console.info('');
  console.info('Reads the user_topics table from <src.db> and writes a nested');
  console.info('taxonomy JSON to <dest.json>. Source DB is opened read-only.');
}

// --- Schema guard ---------------------------------------------------------

const REQUIRED_COLUMNS = ['slug', 'label', 'sort_order'];

function ensureUserTopicsSchema(db) {
  const rows = db.prepare('PRAGMA table_info(user_topics)').all();
  if (rows.length === 0) {
    throw new Error('source DB has no user_topics table — is this a Miyagi DB?');
  }
  const have = new Set(rows.map((r) => r.name));
  const missing = REQUIRED_COLUMNS.filter((c) => !have.has(c));
  if (missing.length) {
    throw new Error(`user_topics missing required columns: ${missing.join(', ')}`);
  }
  // Optional columns we'll read only if present — makes this resilient to
  // older/newer schemas.
  return {
    hasIcon: have.has('icon'),
    hasVisible: have.has('visible'),
    hasDescription: have.has('description'),
    hasContextMd: have.has('context_md'),
  };
}

// --- Bucketing ------------------------------------------------------------

/**
 * For a given slug, return the T1 tier name ("Work" / "Family" / ...) by
 * consulting DEFAULT_TIERS. Slugs not found default to "Work" (consistent
 * with lib/taxonomy.js::generateUserTaxonomyFromDb).
 */
function tierForSlug(slug) {
  for (const [tierName, tierDef] of Object.entries(DEFAULT_TIERS)) {
    if (tierDef.topics && Object.prototype.hasOwnProperty.call(tierDef.topics, slug)) {
      return tierName;
    }
  }
  return 'Work';
}

// --- Export ---------------------------------------------------------------

function exportTaxonomy(sourcePath) {
  if (!existsSync(sourcePath)) {
    throw new Error(`source DB not found: ${sourcePath}`);
  }

  // better-sqlite3 opens read-only when { readonly: true }. We also pass
  // fileMustExist to fail loud rather than creating a new empty DB.
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });

  try {
    const schema = ensureUserTopicsSchema(db);

    const cols = [
      'slug',
      'label',
      schema.hasDescription ? 'description' : `'' AS description`,
      'sort_order',
      schema.hasIcon ? 'icon' : `'label' AS icon`,
      schema.hasVisible ? 'visible' : `1 AS visible`,
      schema.hasContextMd ? 'context_md' : `NULL AS context_md`,
    ].join(', ');

    const rows = db.prepare(`SELECT ${cols} FROM user_topics ORDER BY sort_order, slug`).all();

    // Bucket rows by T1 tier.
    const tiers = {};
    for (const tierName of Object.keys(DEFAULT_TIERS)) {
      tiers[tierName] = {};
    }

    for (const r of rows) {
      const tier = tierForSlug(r.slug);
      if (!tiers[tier]) tiers[tier] = {};
      tiers[tier][r.slug] = {
        label: r.label,
        desc: r.description || '',
        icon: r.icon || 'label',
        visible: r.visible === null || r.visible === undefined ? 1 : Number(r.visible),
        sort_order: Number(r.sort_order || 0),
        has_context_md: Boolean(r.context_md && String(r.context_md).trim().length > 0),
      };
    }

    return { tiers, sourceRows: rows.length };
  } finally {
    db.close();
  }
}

// --- Output format --------------------------------------------------------

/**
 * Deterministic serializer: stable key order per tier, stable subtopic order
 * (by sort_order, then slug). Guarantees two consecutive runs over an
 * unchanged source produce identical output (modulo `exported_at` — see
 * idempotency note below).
 */
function buildOutput({ tiers, sourcePath, previousExportedAt }) {
  const topics = {};
  const tierNames = Object.keys(DEFAULT_TIERS); // stable tier order
  for (const tierName of tierNames) {
    const subtopics = tiers[tierName] || {};
    const sortedSlugs = Object.keys(subtopics).sort((a, b) => {
      const sa = subtopics[a].sort_order || 0;
      const sb = subtopics[b].sort_order || 0;
      if (sa !== sb) return sa - sb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const orderedSubtopics = {};
    for (const slug of sortedSlugs) orderedSubtopics[slug] = subtopics[slug];
    topics[tierName] = {
      // `subtopics` — per migration-plan spec.
      subtopics: orderedSubtopics,
      // `topics` — keep alongside for lib/taxonomy.js backward-compat.
      // Same object reference so JSON stays deterministic.
      topics: orderedSubtopics,
    };
  }

  return {
    version: '1.0',
    // Idempotency: if the destination already exists AND the incoming tier
    // data is byte-identical to what's on disk, we preserve the old
    // exported_at so the file hash doesn't flap. The caller handles that.
    exported_at: previousExportedAt || new Date().toISOString().split('T')[0],
    source_db: sourcePath,
    topics,
  };
}

/** Strip volatile fields for idempotency check. */
function stableSnapshot(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { exported_at: _ignored, ...rest } = obj;
  return rest;
}

// --- Main -----------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.from || !args.to) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const fromPath = expandHome(args.from);
  const toPath = expandHome(args.to);

  let result;
  try {
    result = exportTaxonomy(fromPath);
  } catch (err) {
    console.error(`[export-taxonomy] FAILED: ${err.message}`);
    process.exit(1);
  }

  // Idempotent write: if destination exists and would be unchanged,
  // preserve its exported_at so re-runs produce byte-identical output.
  let previousExportedAt = null;
  if (existsSync(toPath)) {
    try {
      const prev = JSON.parse(readFileSync(toPath, 'utf8'));
      const candidate = buildOutput({
        tiers: result.tiers,
        sourcePath: fromPath,
        previousExportedAt: prev.exported_at,
      });
      if (JSON.stringify(stableSnapshot(candidate)) === JSON.stringify(stableSnapshot(prev))) {
        previousExportedAt = prev.exported_at;
      }
    } catch {
      // Malformed previous file — overwrite with a fresh export.
    }
  }

  const output = buildOutput({
    tiers: result.tiers,
    sourcePath: fromPath,
    previousExportedAt,
  });

  try {
    mkdirSync(dirname(toPath), { recursive: true, mode: 0o700 });
    writeFileSync(toPath, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error(`[export-taxonomy] failed to write ${toPath}: ${err.message}`);
    process.exit(1);
  }

  const { size } = statSync(toPath);
  const subtopicCounts = Object.entries(output.topics)
    .map(([t, v]) => `${t}=${Object.keys(v.subtopics).length}`)
    .join(' ');

  console.info(`[export-taxonomy] wrote ${toPath} (${size} bytes)`);
  console.info(`[export-taxonomy] source rows: ${result.sourceRows}`);
  console.info(`[export-taxonomy] subtopics: ${subtopicCounts}`);
  if (result.sourceRows === 0) {
    console.info('[export-taxonomy] note: user_topics was empty — output contains default-tier skeleton only.');
  }
}

main();
