#!/usr/bin/env node
/**
 * canonical-trend.js — show per-surface quality score history with directional
 * indicators.
 *
 * Story st_0b5e7458 — canonical-degradation-signals.
 *
 * WHY this exists: the dual gate enforces commit-time integrity, but the
 * owner also needs to see drift trends across the history of each canonical
 * surface — "is this doc getting sharper or silently degrading over the
 * last N versions?" This CLI reads canonical_versions.quality_json directly
 * and renders a chronological table per surface, with ↑/↓/→ indicators
 * computed from the aggregate score delta between adjacent rows.
 *
 * Read-only: no DB writes, no LLM calls.
 *
 * CLI: node scripts/canonical-trend.js --surface <doc-path> [--limit N]
 *   default --limit: 10
 */

import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

export const INTELLIGENCE_TIER = 'extraction';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a normalized doc_path. The canonical_versions table stores keys via
 * canonicalKey() — leading ~/ trimmed, leading repo-root prefix trimmed, etc.
 * For trend lookup we accept loose input and normalize it.
 */
export function normalizeSurface(input, repoRoot = resolve(homedir(), 'robotdojo')) {
  if (!input) return input;
  let p = input;
  if (p.startsWith(homedir() + '/')) p = '~/' + p.slice(homedir().length + 1);
  if (p.startsWith(repoRoot + '/')) p = p.slice(repoRoot.length + 1);
  if (p.startsWith('./')) p = p.slice(2);
  return p;
}

/**
 * Read trend rows from a `canonical_versions` table.
 * Accepts an externally-provided db (better-sqlite3 instance) for tests.
 * Newest first; we reverse for chronological rendering.
 */
export function readTrend(db, surface, limit = 10) {
  const stmt = db.prepare(`
    SELECT id, doc_path, content_size, content_sha256, quality_json, story_id, created_at
      FROM canonical_versions
     WHERE doc_path = ?
     ORDER BY id ASC
     LIMIT ?
  `);
  const rows = stmt.all(surface, limit);
  return rows.map(r => {
    let q = null;
    if (r.quality_json) {
      try { q = JSON.parse(r.quality_json); } catch { q = null; }
    }
    return {
      id: r.id,
      doc_path: r.doc_path,
      content_size: r.content_size,
      content_sha256: r.content_sha256,
      story_id: r.story_id,
      created_at: r.created_at,
      quality: q,
    };
  });
}

/**
 * Compute the directional indicator for each row relative to the prior row
 * with a matching judge_model + rubric_hash. Rows with no comparable prior
 * (first row, or judge/rubric drift) get '·'.
 */
export function annotateTrend(rows) {
  return rows.map((row, i) => {
    if (i === 0 || !row.quality?.aggregate) {
      return { ...row, indicator: '·', delta: null };
    }
    // Find most recent prior row with same judge + rubric
    let prior = null;
    for (let j = i - 1; j >= 0; j--) {
      const p = rows[j];
      if (!p.quality?.aggregate) continue;
      if (
        p.quality.judge_model === row.quality.judge_model &&
        p.quality.rubric_hash === row.quality.rubric_hash
      ) {
        prior = p;
        break;
      }
    }
    if (!prior) return { ...row, indicator: '·', delta: null };
    const delta = row.quality.aggregate - prior.quality.aggregate;
    let indicator;
    if (delta > 0) indicator = '↑';
    else if (delta < 0) indicator = '↓';
    else indicator = '→';
    return { ...row, indicator, delta };
  });
}

/**
 * Render annotated rows as a human-readable table.
 * The first column is the indicator. Width-constrained for terminal use.
 */
export function renderTable(annotated, surface) {
  const lines = [];
  lines.push(`# canonical-trend: ${surface}`);
  lines.push('');
  if (annotated.length === 0) {
    lines.push('(no history)');
    return lines.join('\n');
  }
  lines.push('idx  trend  aggregate  dims                    judge                 created_at           story');
  lines.push('---  -----  ---------  ---------------------   --------------------  -------------------  -------------');
  for (let i = 0; i < annotated.length; i++) {
    const r = annotated[i];
    const agg = r.quality?.aggregate != null ? String(r.quality.aggregate).padStart(3) : '  -';
    const dims = (r.quality?.dimensions || [])
      .map(d => d.score)
      .join(',')
      .padEnd(23);
    const judge = (r.quality?.judge_model || '-').slice(0, 20).padEnd(20);
    const created = (r.created_at || '-').slice(0, 19).padEnd(19);
    const story = (r.story_id || '-').slice(0, 13);
    lines.push(
      `${String(i + 1).padStart(3)}  ${r.indicator}     ${agg}        ${dims}  ${judge}  ${created}  ${story}`,
    );
  }
  return lines.join('\n');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const surfaceIdx = args.indexOf('--surface');
  if (surfaceIdx === -1 || !args[surfaceIdx + 1]) {
    console.error('Usage: canonical-trend.js --surface <doc-path> [--limit N]');
    process.exit(2);
  }
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10;
  const surface = normalizeSurface(args[surfaceIdx + 1]);

  // Late-bind the DB import — keeps the module test-friendly (tests pass
  // their own db instance to readTrend).
  const dbMod = await import('../lib/db.js');
  const db = dbMod.default;
  const rows = readTrend(db, surface, limit);
  const annotated = annotateTrend(rows);
  console.log(renderTable(annotated, surface));
}
